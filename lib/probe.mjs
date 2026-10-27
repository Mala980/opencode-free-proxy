/**
 * Live verification: ask Zen itself whether a model can actually be used
 * for free, right now.
 *
 * The Zen model list is not the truth — it still lists ids that answer
 * 400 "Model is unavailable" (deprecated), 403 RegionError (geoblocked) or
 * 401/403 "Model access is disabled" (paid-only). So every candidate gets a
 * tiny real request at startup and on a timer, and only the ones that
 * answer (or merely hit the shared quota) are advertised.
 *
 * Statuses:
 *   ok            200 with content                       → shown
 *   rate_limited  429 / FreeUsageLimitError              → shown (quota, not the model)
 *   unavailable   400/404/410 gone, deprecated, disabled → hidden
 *   region_blocked                                       → hidden
 *   access_denied paid-only for this credential          → hidden
 *   gate_failed   free-tier fingerprint rejected         → shown, warns
 *   error         network/timeout/5xx (transient)        → shown, flagged
 */

import {
  applyChunk,
  applyV2ChatRequest,
  generateSessionId,
  newAggregate,
  withFingerprintTools,
  withFingerprintToolsFlat,
  zenHeaders,
} from "./zen.mjs";

export const HIDDEN_STATUSES = new Set(["unavailable", "region_blocked", "access_denied"]);

export const PROBE_PROMPT = "Reply with exactly: OK";

const RE = {
  unavailable: /(model is unavailable|model .*not found|unknown model|no model|deprecat|disabled|not available)/i,
  region: /region/i,
  freeTier: /(free tier|freetier)/i,
  quota: /(usage limit|rate limit|quota|too many requests)/i,
};

function sseError(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.error) return parsed.error;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function errorMessage(text) {
  const fromSse = sseError(text);
  if (fromSse) return String(fromSse.message || fromSse.type || "error");
  try {
    const data = JSON.parse(text);
    return String(data?.error?.message || data?.error?.type || data?.message || "");
  } catch {
    return text.slice(0, 200);
  }
}

function hasText(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasText);
  if (!value || typeof value !== "object") return false;
  if (typeof value.text === "string" && value.text.trim()) return true;
  if ((value.type === "function_call" || value.type === "tool_use") && typeof value.name === "string" && value.name.trim()) return true;
  return hasText(value.content) || hasText(value.output);
}

function hasUsablePayload(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed.choices)) {
    if (
      parsed.choices.some((choice) => {
        const delta = choice?.delta || {};
        const message = choice?.message || {};
        return (
          hasText(delta.content) ||
          hasText(delta.reasoning_content) ||
          hasText(delta.reasoning) ||
          hasText(delta.reasoning_text) ||
          Boolean(delta.tool_calls?.length) ||
          hasText(message.content) ||
          Boolean(message.tool_calls?.length)
        );
      })
    ) return true;
  }
  if (parsed.type === "response.output_text.delta" && hasText(parsed.delta)) return true;
  if (parsed.type === "response.function_call_arguments.delta" && hasText(parsed.delta)) return true;
  if (parsed.response && hasUsablePayload(parsed.response)) return true;
  return hasText(parsed.output) || hasText(parsed.output_text);
}

function hasUsableOutput(text) {
  let foundData = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    foundData = true;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      if (hasUsablePayload(JSON.parse(payload))) return true;
    } catch {
      /* continue through the stream */
    }
  }
  if (foundData) return false;
  try {
    return hasUsablePayload(JSON.parse(text));
  } catch {
    return false;
  }
}

/** Decides whether a model is usable for free from a probe response. */
export function classifyProbe(httpStatus, text) {
  if (httpStatus === 200) {
    const error = sseError(text);
    if (error) {
      const message = String(error.message || error.type || "");
      if (RE.quota.test(message) || String(error.type || "").includes("FreeUsageLimit")) {
        return { status: "rate_limited", detail: message || "free quota exhausted" };
      }
      return classifyProbe(502, JSON.stringify({ error }));
    }
    if (!hasUsableOutput(text)) return { status: "error", detail: "HTTP 200 but no completion content" };
    return { status: "ok", detail: "answered with completion content" };
  }

  const message = errorMessage(text);

  if (httpStatus === 429 || RE.quota.test(message)) {
    return { status: "rate_limited", detail: message || "free quota exhausted" };
  }
  if (httpStatus === 404 || httpStatus === 410 || RE.unavailable.test(message)) {
    return { status: "unavailable", detail: message || `HTTP ${httpStatus}` };
  }
  if (RE.region.test(message)) {
    return { status: "region_blocked", detail: message || "not served in your region" };
  }
  if (RE.freeTier.test(message)) {
    return { status: "gate_failed", detail: message || "free-tier fingerprint rejected" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "access_denied", detail: message || `HTTP ${httpStatus}` };
  }
  if (httpStatus >= 500 || httpStatus === 0) {
    return { status: "error", detail: message || `HTTP ${httpStatus}` };
  }
  return { status: "error", detail: message || `HTTP ${httpStatus}` };
}

/**
 * Sends one tiny request to Zen for `model` and classifies the answer.
 * Uses the same fingerprint as the proxy so the probe sees exactly what a
 * real request would see.
 */
export async function probeModel({
  zenBase,
  userAgent,
  zenKey = "public",
  client = "cli",
  project = "global",
  model,
  timeoutMs = 20000,
  prompt = PROBE_PROMPT,
}) {
  const started = Date.now();
  const isResponses = model.endpoint === "responses";
  const body = isResponses
    ? { model: model.id, input: prompt, max_output_tokens: 16, stream: true, store: false }
    : applyV2ChatRequest(
        { model: model.id, messages: [{ role: "user", content: prompt }], max_completion_tokens: 16, stream: true },
        { forceStream: true },
      );
  (isResponses ? withFingerprintToolsFlat : withFingerprintTools)(body);

  const url = `${zenBase}/${isResponses ? "responses" : "chat/completions"}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: zenHeaders({ userAgent, zenKey, client, project }, generateSessionId()),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    const { status, detail } = classifyProbe(res.status, text);
    return { status, detail, httpStatus: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      status: "error",
      detail: err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message,
      httpStatus: 0,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** First bit of text a probe got back — handy for logs. */
export function probePreview(text, limit = 40) {
  if (text.includes("data:")) {
    const agg = newAggregate("");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        applyChunk(agg, JSON.parse(payload));
      } catch {
        /* ignore */
      }
    }
    return agg.content.replace(/\s+/g, " ").trim().slice(0, limit);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

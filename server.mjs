#!/usr/bin/env node
/**
 * opencode-free-proxy
 *
 * Exposes the free tier of OpenCode Zen (https://opencode.ai/zen/v1) as
 * OpenAI- and Anthropic-compatible HTTP APIs, so any tool that speaks those
 * formats can use the free models.
 *
 * Zero dependencies — `node server.mjs` is enough.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aggregateToCompletion,
  applyChunk,
  generateSessionId,
  newAggregate,
  withFingerprintTools,
  withFingerprintToolsFlat,
  zenHeaders as zenFingerprintHeaders,
} from "./lib/zen.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROXY_VERSION = "1.1.0";

// Latest stable opencode 1.x (the line that still ships the Zen free tier
// flow this proxy mimics). opencode 2.0.22 exists and uses the same
// `Bearer public` free-tier path — override with OC_VERSION if you want.
const OC_VERSION_DEFAULT = "1.18.34";
const OC_RUNTIME_DEFAULT = "bun/1.3.14";
const OC_PROVIDER_UTILS = "4.0.23";

// ── Config ─────────────────────────────────────────────────────────
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

export function loadConfig(overrides = {}) {
  const ocVersion = process.env.OC_VERSION || OC_VERSION_DEFAULT;
  const cfg = {
    port: num(process.env.PROXY_PORT, 6446),
    host: process.env.PROXY_HOST || "0.0.0.0",
    zenBase: trimSlash(process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1"),
    ocVersion,
    ocRuntime: process.env.OC_RUNTIME || OC_RUNTIME_DEFAULT,
    userAgent:
      process.env.OC_USER_AGENT ||
      `opencode/${ocVersion} ai-sdk/provider-utils/${OC_PROVIDER_UTILS} runtime/${process.env.OC_RUNTIME || OC_RUNTIME_DEFAULT}`,
    client: process.env.OC_CLIENT || "cli",
    project: process.env.OC_PROJECT || "global",
    zenKey: process.env.ZEN_API_KEY || "public",
    timeoutMs: num(process.env.ZEN_TIMEOUT_MS, 120000),
    keysFile: process.env.KEYS_FILE || path.join(HERE, "api-keys.json"),
    modelsFile: process.env.MODELS_FILE || path.join(HERE, "models.json"),
    refreshModels: process.env.REFRESH_MODELS !== "0",
    refreshMs: num(process.env.REFRESH_INTERVAL_MS, 6 * 60 * 60 * 1000),
    sessionTtlMs: num(process.env.SESSION_TTL_MS, 30 * 60 * 1000),
    maxBodyBytes: num(process.env.MAX_BODY_BYTES, 12 * 1024 * 1024),
    publicModels: process.env.PUBLIC_MODELS === "1",
    logRequests: process.env.LOG_REQUESTS !== "0",
    // Free models hit usage limits often; with FALLBACK=1 the proxy retries the
    // request on the next free model instead of returning 429.
    fallback: process.env.FALLBACK === "1",
    fallbackMax: num(process.env.FALLBACK_MAX, 2),
    // Zen's free tier only answers requests that look like the OpenCode CLI:
    // streamed, carrying the bash/glob/grep/read tool quartet. Both are on by
    // default; turn them off only when you use a real (paid) Zen key.
    forceStream: process.env.ZEN_FORCE_STREAM !== "0",
    injectTools: process.env.ZEN_TOOLS !== "0",
    stripInjectedTools: process.env.ZEN_STRIP_INJECTED_TOOLS !== "0",
  };
  return { ...cfg, ...overrides };
}

// ── Small helpers ──────────────────────────────────────────────────
function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.end(body);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...corsHeaders(),
  });
  res.end(body);
}

// Anthropic clients expect { type: "error", error: {...} }; OpenAI clients
// expect { error: {...} }. Same payload, two envelopes.
function sendError(res, status, err) {
  const core = { type: err.type || "error", message: err.message };
  if (err.code) core.code = err.code;
  sendJson(res, status, res.proxyFormat === "anthropic" ? { type: "error", error: core } : { error: core });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, x-api-key, Content-Type, anthropic-version",
    "Access-Control-Max-Age": "86400",
  };
}

async function writeChunk(res, chunk) {
  if (res.writableEnded) return false;
  const ok = res.write(chunk);
  if (!ok) {
    await Promise.race([once(res, "drain"), once(res, "close")]).catch(() => {});
  }
  return !res.writableEnded;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── API keys ───────────────────────────────────────────────────────
function loadKeys(cfg) {
  let keys = {};
  try {
    keys = JSON.parse(fs.readFileSync(cfg.keysFile, "utf8"));
  } catch {
    keys = {};
  }
  if (process.env.PROXY_API_KEY) {
    return { default: process.env.PROXY_API_KEY };
  }
  if (!keys || typeof keys !== "object" || Object.keys(keys).length === 0) {
    keys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    try {
      fs.writeFileSync(cfg.keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
      console.log("[INIT] Generated new API keys →", cfg.keysFile);
    } catch (e) {
      console.log("[INIT] Could not write keys file:", e.message);
    }
  }
  return keys;
}

function auth(req, keys) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  if (!tok) return null;
  for (const [name, key] of Object.entries(keys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Model catalog ──────────────────────────────────────────────────
function loadCatalog(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[FATAL] Cannot read model catalog ${file}: ${e.message}`);
    console.error("[FATAL] Run `npm run update:models` or restore models.json.");
    process.exit(1);
  }
  const models = Array.isArray(raw.models) ? raw.models : [];
  return { ...raw, models };
}

// Zen keeps only free models live; paid ids never end in "-free" and the only
// free id without the suffix is a stealth model we list explicitly.
const FREE_SUFFIX = /-free$/;
const EXTRA_FREE = new Set(["big-pickle", "grok-code"]);

function looksFree(id) {
  return FREE_SUFFIX.test(id) || EXTRA_FREE.has(id);
}

function prettifyId(id) {
  return id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z]+\d*$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bV(\d)/, "V$1");
}

function activeModels(catalog, state) {
  const curated = catalog.models.filter((m) => m && m.id && m.supported !== false);
  const out = [];
  const seen = new Set();
  if (state.liveIds) {
    for (const m of curated) {
      if (!state.liveIds.has(m.id)) continue;
      out.push(m);
      seen.add(m.id);
    }
    // Anything new that showed up on Zen and looks like a free model.
    for (const id of state.liveIds) {
      if (seen.has(id) || !looksFree(id)) continue;
      out.push({
        id,
        name: prettifyId(id),
        endpoint: "chat",
        reasoning: true,
        tool_call: true,
        attachment: false,
        dynamic: true,
        notes: "Discovered on Zen after the catalog was last updated.",
      });
      seen.add(id);
    }
    return out;
  }
  return curated.slice();
}

async function fetchLiveModels(cfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${cfg.zenBase}/models`, {
      headers: {
        Accept: "application/json",
        "User-Agent": cfg.userAgent,
        Authorization: `Bearer ${cfg.zenKey}`,
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json?.data || []).map((m) => m?.id).filter(Boolean);
    if (!ids.length) throw new Error("empty model list");
    return new Set(ids);
  } finally {
    clearTimeout(timer);
  }
}

// ── Upstream errors ────────────────────────────────────────────────
class UpstreamError extends Error {
  constructor(status, type, message, code) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function mapUpstreamError(status, data, raw) {
  const message =
    data?.error?.message || data?.message || data?.error || (raw && raw.slice(0, 300)) || "Upstream error";
  const text = String(message).toLowerCase();
  const errType = String(data?.error?.type || data?.type || "");

  if (
    status === 429 ||
    errType.includes("FreeUsageLimit") ||
    text.includes("free usage limit") ||
    text.includes("usage limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  ) {
    return new UpstreamError(429, "rate_limit_error", `${message} (Zen free-tier limit)`, "rate_limit_exceeded");
  }
  if (status === 401 || status === 403 || errType.includes("Auth") || text.includes("unauthorized")) {
    return new UpstreamError(status || 502, "authentication_error", `Zen rejected the request: ${message}`);
  }
  if (status === 404 || text.includes("unknown model") || text.includes("not found") || text.includes("no model")) {
    return new UpstreamError(404, "invalid_request_error", `Zen does not serve that model: ${message}`);
  }
  if (status >= 500) {
    return new UpstreamError(502, "upstream_error", `Zen error: ${message}`);
  }
  return new UpstreamError(status >= 400 ? status : 502, "upstream_error", String(message));
}

// ── Zen request ────────────────────────────────────────────────────
function zenHeaders(cfg, sessionId) {
  return zenFingerprintHeaders(
    { userAgent: cfg.userAgent, zenKey: cfg.zenKey, client: cfg.client, project: cfg.project },
    sessionId,
  );
}

function endpointPath(endpoint) {
  if (endpoint === "responses") return "responses";
  if (endpoint === "systemone") return "systemone";
  return "chat/completions";
}

const CHAT_PASSTHROUGH = [
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "seed",
  "reasoning_effort",
  "parallel_tool_calls",
  "stream_options",
  "logprobs",
  "top_logprobs",
  "user",
];

function buildChatPayload(body, model) {
  const payload = { model: model.id, messages: body.messages || [], stream: Boolean(body.stream) };
  for (const key of CHAT_PASSTHROUGH) {
    if (key === "messages" || key === "stream" || key === "model") continue;
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

async function callZen(cfg, model, payload, sessionId) {
  const url = `${cfg.zenBase}/${endpointPath(model.endpoint)}`;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: zenHeaders(cfg, sessionId),
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (err) {
    if (timedOut || err.name === "AbortError" || err.name === "TimeoutError") {
      throw new UpstreamError(504, "timeout_error", `Zen did not respond within ${cfg.timeoutMs}ms`);
    }
    throw new UpstreamError(502, "upstream_error", `Cannot reach Zen: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  return res;
}

// ── Anthropic ⇄ OpenAI translation ─────────────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b) => b.text || "").join("\n")
          : "";
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const toolResults = msg.content.filter((b) => b.type === "tool_result");

    if (toolUses.length && msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
        })),
      });
    } else if (toolResults.length) {
      for (const b of toolResults) {
        const resultText =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c) => (c && c.text) || "").join("\n")
              : "";
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
      }
    } else {
      messages.push({ role: msg.role, content: text });
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));

  const payload = {
    messages,
    max_tokens: Number(body.max_tokens) || 4096,
  };
  if (tools.length) payload.tools = tools;
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") payload.tool_choice = "auto";
    else if (tc.type === "any") payload.tool_choice = "required";
    else if (tc.type === "tool") payload.tool_choice = { type: "function", function: { name: tc.name } };
    else payload.tool_choice = tc;
  }
  for (const key of ["temperature", "top_p", "stop_sequences", "reasoning_effort"]) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  if (body.stream) payload.stream = true;
  return payload;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp?.choices?.[0] || {};
  const content = [];
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice.message?.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    model: model.id,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: oaiResp?.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp?.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ── Streaming ──────────────────────────────────────────────────────
function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  });
  if (res.flushHeaders) res.flushHeaders();
}

function sseLine(payload) {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function anthropicEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function upstreamErrorFromSse(payload) {
  const data = parseJsonSafe(payload);
  if (!data || typeof data !== "object") return null;
  if (data.error || data.type === "error") return data;
  return null;
}

async function pipeRawSse(upstream, res, format) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    let value;
    try {
      ({ done, value } = await reader.read());
    } catch {
      break;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let errored = null;
      if (line.startsWith("data:") || line.startsWith("event:")) {
        const payload = line.replace(/^(data|event):\s*/, "").trim();
        errored = upstreamErrorFromSse(payload);
      } else if (line.trim().startsWith("{")) {
        errored = upstreamErrorFromSse(line.trim());
      }
      if (errored) {
        const err = mapUpstreamError(502, errored);
        if (format === "anthropic") {
          await writeChunk(res, anthropicEvent("error", { type: "error", error: { type: err.type, message: err.message } }));
        } else {
          await writeChunk(res, sseLine({ error: { message: err.message, type: err.type, code: err.code || null } }));
          await writeChunk(res, sseLine("[DONE]"));
        }
        done = true;
        break;
      }
      if (!(await writeChunk(res, line + "\n"))) {
        done = true;
        break;
      }
    }
  }

  if (buffer && !res.writableEnded) await writeChunk(res, buffer);
  if (!res.writableEnded) res.end();
}

async function pipeAsAnthropicSse(upstream, res, model, inputTokens) {
  const msgId = ocId("msg");
  let started = false;
  let nextIndex = 0;
  let textIndex = -1;
  let thinkingIndex = -1;
  const toolIndex = new Map();
  const openBlocks = [];
  let outputTokens = 0;
  let usage = null;

  const start = async () => {
    if (started) return;
    started = true;
    sseHeaders(res);
    await writeChunk(
      res,
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: model.id,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens || 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
    await writeChunk(res, anthropicEvent("ping", { type: "ping" }));
  };

  const closeBlock = async (index) => {
    await writeChunk(res, anthropicEvent("content_block_stop", { type: "content_block_stop", index }));
    const at = openBlocks.indexOf(index);
    if (at !== -1) openBlocks.splice(at, 1);
  };

  const closeThinking = async () => {
    if (thinkingIndex < 0) return;
    const index = thinkingIndex;
    thinkingIndex = -1;
    await closeBlock(index);
  };

  const closeText = async () => {
    if (textIndex < 0) return;
    const index = textIndex;
    textIndex = -1;
    await closeBlock(index);
  };

  const openText = async () => {
    if (textIndex >= 0) return;
    await closeThinking();
    textIndex = nextIndex++;
    openBlocks.push(textIndex);
    await writeChunk(
      res,
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      }),
    );
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    let value;
    try {
      ({ done, value } = await reader.read());
    } catch {
      break;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      const parsed = parseJsonSafe(payload);
      if (!parsed) continue;

      if (parsed.error || parsed.type === "error") {
        const err = mapUpstreamError(502, parsed);
        if (!started) {
          sendJson(res, err.status, { type: "error", error: { type: err.type, message: err.message } });
        } else {
          await writeChunk(res, anthropicEvent("error", { type: "error", error: { type: err.type, message: err.message } }));
        }
        done = true;
        break;
      }
      if (parsed.usage) usage = parsed.usage;

      const delta = parsed.choices?.[0]?.delta;
      const finish = parsed.choices?.[0]?.finish_reason;
      if (!delta && !finish) continue;

      await start();

      if (delta?.content) {
        await openText();
        await writeChunk(
          res,
          anthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
        outputTokens += estimateTokens(delta.content);
      }

      if (delta?.reasoning_content) {
        // Zen sends chain-of-thought on `reasoning_content`; Anthropic clients
        // expect it as a thinking block emitted before the text block.
        await closeText();
        if (thinkingIndex < 0) {
          thinkingIndex = nextIndex++;
          openBlocks.push(thinkingIndex);
          await writeChunk(
            res,
            anthropicEvent("content_block_start", {
              type: "content_block_start",
              index: thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            }),
          );
        }
        await writeChunk(
          res,
          anthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index: thinkingIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content },
          }),
        );
        outputTokens += estimateTokens(delta.reasoning_content);
      }

      for (const tc of delta?.tool_calls || []) {
        const key = tc.index ?? 0;
        if (!toolIndex.has(key)) {
          await closeText();
          const blockIndex = nextIndex++;
          toolIndex.set(key, blockIndex);
          openBlocks.push(blockIndex);
          await writeChunk(
            res,
            anthropicEvent("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "", input: {} },
            }),
          );
        }
        if (tc.function?.arguments) {
          await writeChunk(
            res,
            anthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: toolIndex.get(key),
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            }),
          );
          outputTokens += estimateTokens(tc.function.arguments);
        }
      }

      if (finish) {
        for (const blockIndex of [...openBlocks].sort((a, b) => a - b)) {
          await writeChunk(res, anthropicEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        }
        openBlocks.length = 0;
        const stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
        await writeChunk(
          res,
          anthropicEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage?.completion_tokens || outputTokens },
          }),
        );
        await writeChunk(res, anthropicEvent("message_stop", { type: "message_stop" }));
        done = true;
        break;
      }
    }
  }

  if (started && openBlocks.length) {
    for (const blockIndex of [...openBlocks].sort((a, b) => a - b)) {
      await writeChunk(res, anthropicEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    }
    await writeChunk(
      res,
      anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens || outputTokens },
      }),
    );
    await writeChunk(res, anthropicEvent("message_stop", { type: "message_stop" }));
  }

  if (!started) {
    sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: "Empty response from Zen" } });
    return;
  }
  if (!res.writableEnded) res.end();
}

// ── Server ─────────────────────────────────────────────────────────
export function createServer(overrides = {}) {
  const cfg = loadConfig(overrides);
  const catalog = loadCatalog(cfg.modelsFile);
  const keys = loadKeys(cfg);
  const sessions = new Map();
  const state = { liveIds: null, lastRefreshAt: 0, lastRefreshError: null, timer: null };

  const models = () => activeModels(catalog, state);
  const findModel = (id) => models().find((m) => m.id === id) || null;

  function sessionFor(user) {
    const now = Date.now();
    const current = sessions.get(user);
    if (current && now - current.ts < cfg.sessionTtlMs) return current.id;
    const session = { id: generateSessionId(), ts: now };
    sessions.set(user, session);
    return session.id;
  }

  async function refresh() {
    try {
      state.liveIds = await fetchLiveModels(cfg);
      state.lastRefreshAt = Date.now();
      state.lastRefreshError = null;
      const known = models().length;
      console.log(`[MODELS] Refreshed from Zen: ${state.liveIds.size} ids upstream, ${known} free models exposed`);
    } catch (err) {
      state.lastRefreshError = err.message;
      console.log(`[MODELS] Could not refresh from Zen (${err.message}) — using bundled catalog`);
    }
  }

  function unknownModelError(id) {
    const retired = catalog.retired?.[id];
    const available = models().map((m) => m.id);
    return {
      message: retired
        ? `${id} is no longer available. ${retired}`
        : `Unknown model "${id}". Available: ${available.join(", ")}`,
      type: "invalid_request_error",
      code: retired ? "model_retired" : "model_not_found",
      available,
    };
  }

  function logRequest(tag, user, model, extra) {
    if (!cfg.logRequests) return;
    console.log(`[${tag}]`, new Date().toISOString(), user, model.id, extra);
  }

  // Drain a Zen SSE stream, watching for error frames.
  async function collectSseLines(upstream) {
    const raw = await upstream.text();
    const lines = [];
    if (!raw.includes("data:")) {
      const data = parseJsonSafe(raw);
      if (data?.error || data?.type === "error") throw mapUpstreamError(upstream.status, data, raw);
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const parsed = parseJsonSafe(payload);
      if (!parsed) continue;
      if (parsed.error || parsed.type === "error") throw mapUpstreamError(502, parsed, payload);
      lines.push(parsed);
    }
    return lines;
  }

  async function collectChatCompletion(upstream, model) {
    const agg = newAggregate(model.id);
    for (const parsed of await collectSseLines(upstream)) applyChunk(agg, parsed);
    return agg;
  }

  async function collectResponsesPayload(upstream) {
    let completed = null;
    let last = null;
    for (const parsed of await collectSseLines(upstream)) {
      if (parsed.type === "response.completed" && parsed.response) completed = parsed.response;
      last = parsed;
    }
    if (completed) return completed;
    if (last?.response) return last.response;
    if (last) return last;
    throw new UpstreamError(502, "upstream_error", "Zen returned an empty response");
  }

  /**
   * `clientStream` is what the caller asked for; Zen is always called with
   * stream:true because the free tier rejects anything else.
   */
  async function runUpstream({ req, res, model, body, format, user, clientStream, injectedTools }) {
    const sessionId = sessionFor(user);
    const upstream = await callZen(cfg, model, body, sessionId);

    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => "");
      const data = parseJsonSafe(raw);
      throw mapUpstreamError(upstream.status, data, raw);
    }

    if (clientStream) {
      if (!upstream.body) throw new UpstreamError(502, "upstream_error", "Zen returned an empty stream");
      if (format === "anthropic") {
        const inputTokens = estimateTokens(JSON.stringify(body.messages || []));
        await pipeAsAnthropicSse(upstream, res, model, inputTokens);
        return;
      }
      sseHeaders(res);
      await pipeRawSse(upstream, res, format);
      return;
    }

    // Non-streaming caller: re-assemble the upstream stream into one payload.
    if (!upstream.body) throw new UpstreamError(502, "upstream_error", "Zen returned an empty response");

    if (format === "responses") {
      sendJson(res, 200, await collectResponsesPayload(upstream));
      return;
    }

    const agg = await collectChatCompletion(upstream, model);
    const completion = aggregateToCompletion(agg, {
      dropToolNames: cfg.stripInjectedTools ? injectedTools : [],
    });

    if (format === "anthropic") {
      const inputTokens = estimateTokens(JSON.stringify(body.messages || []));
      sendJson(res, 200, openAIToAnthropic(completion, model, inputTokens));
      return;
    }

    sendJson(res, 200, completion);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    try {
      // ── Public endpoints ──
      if (route === "GET /" || route === "GET /health") {
        const list = models();
        sendJson(res, 200, {
          status: "ok",
          service: "opencode-free-proxy",
          version: PROXY_VERSION,
          ocVersion: cfg.ocVersion,
          zen: cfg.zenBase,
          models: list.map((m) => m.id),
          modelCount: list.length,
          upstream: {
            live: Boolean(state.liveIds),
            lastRefresh: state.lastRefreshAt ? new Date(state.lastRefreshAt).toISOString() : null,
            error: state.lastRefreshError,
          },
          endpoints: {
            openai: "POST /v1/chat/completions",
            anthropic: "POST /v1/messages",
            responses: "POST /v1/responses",
            models: "GET /v1/models",
          },
        });
        return;
      }

      // ── Authenticated endpoints ──
      const user = auth(req, keys);
      const needsAuth = !cfg.publicModels || url.pathname !== "/v1/models";
      if (!user && needsAuth) {
        res.proxyFormat = url.pathname === "/v1/messages" ? "anthropic" : "openai";
        sendError(res, 401, {
          message: "Invalid or missing API key (use Authorization: Bearer KEY or x-api-key: KEY)",
          type: "authentication_error",
        });
        return;
      }

      if (route === "GET /v1/models") {
        const list = models();
        sendJson(res, 200, {
          object: "list",
          data: list.map((m) => ({
            id: m.id,
            object: "model",
            created: Math.floor(new Date(catalog.updated || Date.now()).getTime() / 1000),
            owned_by: "opencode-free",
            display_name: m.name,
            endpoint: m.endpoint || "chat",
            context_window: m.context || null,
            max_output_tokens: m.output || null,
            supports_tools: Boolean(m.tool_call),
            supports_reasoning: Boolean(m.reasoning),
            supports_attachments: Boolean(m.attachment),
            deprecation: m.status === "deprecated" ? "deprecated" : null,
          })),
        });
        return;
      }

      if (route === "GET /v1/models/detail") {
        sendJson(res, 200, { object: "list", data: models() });
        return;
      }

      if (route === "POST /v1/chat/completions" || route === "POST /v1/messages" || route === "POST /v1/responses") {
        const format = route.endsWith("/messages") ? "anthropic" : route.endsWith("/responses") ? "responses" : "openai";
        res.proxyFormat = format;

        let body;
        try {
          body = JSON.parse(await readBody(req, cfg.maxBodyBytes)) || {};
        } catch (err) {
          sendError(res, err.status === 413 ? 413 : 400, {
            message: err.status === 413 ? "Request body too large" : `Invalid JSON body: ${err.message}`,
            type: "invalid_request_error",
          });
          return;
        }

        let model = findModel(body.model);
        if (!model) {
          const info = unknownModelError(body.model);
          sendError(res, 404, { message: info.message, type: info.type, code: info.code });
          return;
        }

        if (format === "responses" && model.endpoint !== "responses") {
          sendError(res, 400, {
            message: `${model.id} is a chat model — use POST /v1/chat/completions`,
            type: "invalid_request_error",
          });
          return;
        }
        if (format !== "responses" && model.endpoint !== "chat") {
          sendError(res, 400, {
            message: `${model.id} is served on the ${model.endpoint} endpoint — use POST /v1/responses`,
            type: "invalid_request_error",
          });
          return;
        }

        let payload;
        if (format === "anthropic") {
          payload = anthropicToOpenAI(body);
          payload.model = model.id;
        } else if (format === "responses") {
          payload = { ...body, model: model.id, stream: Boolean(body.stream) };
          if (payload.store === undefined) payload.store = false;
        } else {
          payload = buildChatPayload(body, model);
        }

        const clientStream = Boolean(payload.stream);
        let injectedTools = [];
        if (cfg.injectTools) {
          injectedTools = format === "responses" ? withFingerprintToolsFlat(payload) : withFingerprintTools(payload);
        }
        if (cfg.forceStream) payload.stream = true;

        logRequest(
          format === "anthropic" ? "ANT" : format === "responses" ? "RSP" : "OAI",
          user,
          model,
          `${body.stream ? "stream" : "sync"} msgs:${(body.messages || []).length || 0}`,
        );

        const tried = new Set([model.id]);
        let attempt = 0;
        for (;;) {
          try {
            await runUpstream({ req, res, model, body: payload, format, user, clientStream, injectedTools });
            break;
          } catch (err) {
            const canFallback =
              cfg.fallback &&
              err instanceof UpstreamError &&
              (err.status === 429 || err.status === 404 || err.status >= 500) &&
              attempt < cfg.fallbackMax &&
              !res.headersSent &&
              !res.writableEnded;
            if (!canFallback) throw err;

            const next = models().find((m) => !tried.has(m.id) && (m.endpoint || "chat") === (model.endpoint || "chat"));
            if (!next) throw err;

            tried.add(next.id);
            attempt += 1;
            console.log(`[FALLBACK] ${model.id} → ${next.id} (${err.type})`);
            model = next;
            payload.model = next.id;
          }
        }
        return;
      }

      sendJson(res, 404, { error: { message: `Not found: ${route}`, type: "not_found" } });
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (!res.headersSent && !res.writableEnded) {
          sendError(res, err.status, {
            message: err.message,
            type: err.type,
            code: err.code || (err.status === 429 ? "rate_limit_exceeded" : undefined),
          });
        } else {
          res.end();
        }
        return;
      }
      console.error("[ERROR]", err);
      if (!res.headersSent && !res.writableEnded) {
        sendError(res, 500, { message: err.message || "Internal error", type: "internal_error" });
      } else {
        res.end();
      }
    }
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return {
    server,
    cfg,
    catalog,
    keys,
    state,
    models,
    refresh,
    close: async () => {
      if (state.timer) clearInterval(state.timer);
      await new Promise((resolve) => server.close(resolve));
    },
    listen: async () => {
      if (cfg.refreshModels) {
        await refresh();
        state.timer = setInterval(refresh, cfg.refreshMs);
        state.timer.unref?.();
      }
      await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
      return server.address();
    },
  };
}

export async function startServer(overrides = {}) {
  const app = createServer(overrides);
  const addr = await app.listen();
  const port = typeof addr === "object" && addr ? addr.port : app.cfg.port;
  const list = app.models();

  console.log(`opencode-free-proxy v${PROXY_VERSION}  (impersonating opencode ${app.cfg.ocVersion})`);
  console.log(`  listening   http://${app.cfg.host}:${port}`);
  console.log(`  upstream    ${app.cfg.zenBase}`);
  console.log("  endpoints   POST /v1/chat/completions · POST /v1/messages · POST /v1/responses · GET /v1/models · GET /health");
  console.log(`  models      ${list.length} free: ${list.map((m) => m.id).join(", ")}`);
  for (const [name, key] of Object.entries(app.keys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
  if (!app.state.liveIds) {
    console.log("  note        Zen model list not reachable — serving the bundled catalog");
  }
  return app;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}

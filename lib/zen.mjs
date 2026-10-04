/**
 * Zen transport: everything needed to make a request look like it came from
 * the OpenCode CLI.
 *
 * Since 2026-09-16 the Zen free tier rejects requests that do not look like
 * the official agentic client (403 FreeTierError: "OpenCode's free tier can
 * only be used from within OpenCode"). The gates, verified live by the
 * community (decolua/9router#4101 + #4132, apmantza/pi-free#544):
 *
 *   1. User-Agent must lead with opencode/<version>, version >= 1.17.0
 *   2. x-opencode-session must match ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
 *   3. the request must be streamed (stream:true)
 *   4. tools[] must carry the OpenCode builtin tool names — at least the
 *      file-search quartet {bash, glob, grep, read}; the threshold has been
 *      tuned to 5 (adding edit) and back, so we send all five.
 *
 * Everything here keeps this proxy on the right side of those gates.
 * Non-streaming client requests are streamed upstream and re-assembled.
 */

import crypto from "node:crypto";

// Superset of the reported thresholds (4: bash/glob/grep/read, 5: + edit).
// Override with ZEN_TOOL_SET=bash,edit,glob,grep,read if Zen retunes again.
export const OPENCODE_FINGERPRINT_TOOLS = (process.env.ZEN_TOOL_SET || "bash,edit,glob,grep,read")
  .split(",")
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomPart(length = 14) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i] % 62];
  return out;
}

// OpenCode ids are 6 big-endian bytes of ~timestamp as hex + 14 random chars.
function timePart(timestamp, counter, invert) {
  let value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  if (invert) value = ~value;
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

let lastTimestamp = 0;
let counter = 0;

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;
  return `ses_${timePart(timestamp, counter, true)}${randomPart()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  return `msg_${timePart(timestamp, 1, false)}${randomPart()}`;
}

export function ensureSessionId(id) {
  if (typeof id === "string" && OPENCODE_SESSION_RE.test(id.trim())) return id.trim();
  return generateSessionId();
}

/**
 * Headers Zen expects from the CLI. `sessionId` must already have the
 * canonical ses_… shape — use generateSessionId()/ensureSessionId().
 */
export function zenHeaders({ userAgent, zenKey = "public", client = "cli", project = "global" }, sessionId) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
    Authorization: `Bearer ${zenKey}`,
    "User-Agent": userAgent,
    "x-opencode-client": client,
    "x-opencode-project": project,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-opencode-request": generateRequestId(),
  };
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
  return raw.trim();
}

/**
 * Adds the quartet the free-tier gate looks for. Caller tools win: an
 * existing tool with the same name is never overwritten (duplicates make
 * Zen answer 500).
 *
 * Returns the names that were injected (i.e. that the caller never declared).
 */
export function withFingerprintTools(payload, names = OPENCODE_FINGERPRINT_TOOLS) {
  if (!payload || typeof payload !== "object") return [];
  if (!Array.isArray(payload.tools)) payload.tools = [];

  const present = new Set(payload.tools.map(toolName).filter(Boolean).map((n) => n.toLowerCase()));
  const injected = [];
  for (const name of names) {
    if (present.has(name)) continue;
    payload.tools.push({
      type: "function",
      function: {
        name,
        description: `OpenCode built-in ${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    });
    injected.push(name);
  }
  return injected;
}

/** Same thing for the flat Responses-API tool shape. */
export function withFingerprintToolsFlat(payload, names = OPENCODE_FINGERPRINT_TOOLS) {
  if (!payload || typeof payload !== "object") return [];
  if (!Array.isArray(payload.tools)) payload.tools = [];

  const present = new Set(payload.tools.map((t) => (typeof t?.name === "string" ? t.name.trim().toLowerCase() : "")));
  const injected = [];
  for (const name of names) {
    if (present.has(name)) continue;
    payload.tools.push({
      type: "function",
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    });
    injected.push(name);
  }
  return injected;
}

// ── Re-assembling a streamed response for non-streaming clients ─────
export function newAggregate(model) {
  return {
    id: null,
    model,
    created: Math.floor(Date.now() / 1000),
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
}

export function applyChunk(agg, parsed) {
  if (!parsed || typeof parsed !== "object") return agg;
  if (typeof parsed.id === "string" && parsed.id) agg.id = parsed.id;
  if (typeof parsed.model === "string" && parsed.model) agg.model = parsed.model;
  if (parsed.created) agg.created = parsed.created;
  if (parsed.usage) agg.usage = parsed.usage;

  const choice = parsed.choices?.[0];
  if (!choice) return agg;
  const delta = choice.delta || {};
  if (typeof delta.content === "string") agg.content += delta.content;
  if (typeof delta.reasoning_content === "string") agg.reasoning += delta.reasoning_content;

  for (const tc of delta.tool_calls || []) {
    const idx = tc.index ?? 0;
    while (agg.toolCalls.length <= idx) {
      agg.toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } });
    }
    const call = agg.toolCalls[idx];
    if (tc.id) call.id = tc.id;
    if (tc.type) call.type = tc.type;
    if (tc.function?.name) call.function.name += tc.function.name;
    if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
  }

  if (choice.finish_reason) agg.finishReason = choice.finish_reason;
  return agg;
}

/**
 * Builds a chat.completion object out of the aggregated stream.
 * `dropToolNames` removes tool calls for tools we injected on the caller's
 * behalf — the caller has no way to run them.
 */
export function aggregateToCompletion(agg, { dropToolNames = [] } = {}) {
  const drop = new Set(dropToolNames);
  const toolCalls = agg.toolCalls.filter((tc) => tc.function?.name && !drop.has(tc.function.name));

  const message = { role: "assistant", content: agg.content || null };
  if (agg.reasoning) message.reasoning_content = agg.reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  let finishReason = agg.finishReason || "stop";
  if (finishReason === "tool_calls" && !toolCalls.length) finishReason = "stop";

  return {
    id: agg.id || `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: agg.created,
    model: agg.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: agg.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

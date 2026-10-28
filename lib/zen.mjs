/**
 * Zen transport profile captured from the official OpenCode v2.2.0 Linux CLI.
 *
 *   UA: opencode/latest/2.2.0/cli
 *   chat: HTTP OpenAI-compatible SSE, stream=true, stream_options.include_usage=true
 *   session: one 26-character `ses_` ID used as session and cache affinity
 *   built-ins: edit, glob, grep, question, read, shell, skill, subagent,
 *              webfetch, websearch, write, execute
 *
 * Non-streaming callers are still served the format they asked for: the proxy
 * streams to Zen, then re-assembles the response when needed.
 */

import crypto from "node:crypto";

export const DEFAULT_OC_VERSION = "2.2.0";
export const DEFAULT_OC_CHANNEL = "latest";
export const DEFAULT_OC_USER_AGENT = `opencode/${DEFAULT_OC_CHANNEL}/${DEFAULT_OC_VERSION}/cli`;

export function opencodeUserAgent(version = DEFAULT_OC_VERSION, channel = DEFAULT_OC_CHANNEL) {
  return `opencode/${channel}/${version}/cli`;
}

// Exact default tool-name set from the 2.2.0 CLI capture. Callers' own tools
// win; injected built-ins are removed from responses because the proxy cannot
// execute OpenCode's local tools on their behalf.
export const OPENCODE_FINGERPRINT_TOOLS = (
  process.env.ZEN_TOOL_SET || "edit,glob,grep,question,read,shell,skill,subagent,webfetch,websearch,write,execute"
)
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

// OpenCode IDs use six big-endian timestamp/counter bytes and fourteen random chars.
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

/** A valid upstream CLI session ID is reused; other inputs get a canonical ID. */
export function ensureSessionId(id) {
  if (typeof id === "string" && OPENCODE_SESSION_RE.test(id.trim())) return id.trim();
  return generateSessionId();
}

/**
 * V2 request headers. `sessionId` identifies the current session; `affinityId`
 * groups child/fork requests with the session whose prompt cache they share.
 */
export function zenHeaders(
  {
    userAgent,
    zenKey = "public",
    client = "cli",
    project = "global",
    sessionId: inputSessionId,
    affinityId: inputAffinityId,
    parentSessionId,
  },
  fallbackSessionId,
) {
  const sessionId = ensureSessionId(inputSessionId || fallbackSessionId);
  const affinityId = ensureSessionId(inputAffinityId || sessionId);
  const parentId = typeof parentSessionId === "string" && OPENCODE_SESSION_RE.test(parentSessionId) ? parentSessionId : null;
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    Authorization: `Bearer ${zenKey}`,
    "User-Agent": userAgent,
    "x-opencode-client": client,
    "x-opencode-project": project,
    "x-opencode-session": affinityId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": affinityId,
    "X-Session-Id": affinityId,
    ...(parentId
      ? {
          "x-opencode-parent-session-id": parentId,
          "x-parent-session-id": parentId,
        }
      : {}),
  };
}

/** OpenCode v2 chat defaults captured from the official OpenAI-compatible route. */
export function applyV2ChatRequest(payload, { forceStream = true, maxTokensField = "max_completion_tokens" } = {}) {
  if (forceStream) payload.stream = true;
  if (payload.stream === true) {
    payload.stream_options = {
      ...(payload.stream_options && typeof payload.stream_options === "object" ? payload.stream_options : {}),
      include_usage: payload.stream_options?.include_usage ?? true,
    };
  }

  const otherField = maxTokensField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  const maxTokens = payload[maxTokensField] ?? payload[otherField];
  if (maxTokens !== undefined) {
    payload[maxTokensField] = maxTokens;
    delete payload[otherField];
  }
  return payload;
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
  return raw.trim();
}

/** Adds the captured chat-completions built-ins without replacing caller tools. */
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

/** Adds the same built-ins using the flat OpenAI Responses API tool shape. */
export function withFingerprintToolsFlat(payload, names = OPENCODE_FINGERPRINT_TOOLS) {
  if (!payload || typeof payload !== "object") return [];
  if (!Array.isArray(payload.tools)) payload.tools = [];

  const present = new Set(payload.tools.map((tool) => (typeof tool?.name === "string" ? tool.name.trim().toLowerCase() : "")));
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
  for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
    if (typeof delta[key] === "string") agg.reasoning += delta[key];
  }

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

/** Builds a chat.completion from the stream and drops tools injected by this proxy. */
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

#!/usr/bin/env node
/**
 * doctor — checks that the free OpenCode Zen models actually answer.
 *
 *   npm run doctor
 *   npm run doctor -- --server http://127.0.0.1:6446 --key oc-xxxx
 *   npm run doctor -- --model big-pickle --verbose
 *
 * Without --server it talks to Zen directly with the same headers the proxy
 * uses (that tells you whether the free tier itself is reachable from your
 * machine / IP). With --server it goes through your running proxy instead.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODELS_FILE = process.env.MODELS_FILE || path.join(HERE, "models.json");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const OC_VERSION = process.env.OC_VERSION || "1.18.34";
const USER_AGENT =
  process.env.OC_USER_AGENT ||
  `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/${process.env.OC_RUNTIME || "bun/1.3.14"}`;
const ZEN_BASE = (process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const SERVER = getArg("server", process.env.PROXY_URL || "");
const TIMEOUT = Number(getArg("timeout", process.env.ZEN_TIMEOUT_MS || 45000));
const ONLY = getArg("model", "");
const VERBOSE = hasFlag("verbose");

function ocId(prefix) {
  return `${prefix}_${Date.now().toString(16)}${crypto.randomBytes(12).toString("base64url").slice(0, 16)}`;
}

function zenHeaders() {
  const session = ocId("ses");
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${process.env.ZEN_API_KEY || "public"}`,
    "User-Agent": USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-project": process.env.OC_PROJECT || "global",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-opencode-request": ocId("msg"),
  };
}

async function request(url, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, text: err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function extractReply(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.content?.[0]?.text ||
    data?.output?.map?.((o) => o?.content?.map?.((c) => c?.text).join("")).join("") ||
    (typeof data?.output_text === "string" ? data.output_text : "") ||
    ""
  );
}

function verdict(status, text) {
  if (status === 200) return { ok: true, label: "OK" };
  const lower = String(text).toLowerCase();
  if (status === 429 || lower.includes("usage limit") || lower.includes("rate limit"))
    return { ok: true, label: "RATE LIMITED", note: "model exists on Zen, free quota exhausted" };
  if (status === 0) return { ok: false, label: "UNREACHABLE" };
  if (status === 401 || status === 403) return { ok: false, label: "AUTH REJECTED", note: "Zen refused the public/anonymous headers" };
  if (status === 404) return { ok: false, label: "NOT ON ZEN", note: "model id no longer served" };
  return { ok: false, label: `HTTP ${status}` };
}

async function probeZen(model) {
  const isResponses = model.endpoint === "responses";
  const url = `${ZEN_BASE}/${isResponses ? "responses" : "chat/completions"}`;
  const body = isResponses
    ? { model: model.id, input: "Reply with exactly: OK", max_output_tokens: 16 }
    : { model: model.id, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16, stream: false };
  const res = await request(url, zenHeaders(), body, TIMEOUT);
  return { ...res, ...verdict(res.status, res.text), via: "zen" };
}

async function probeProxy(model, server, key) {
  const isResponses = model.endpoint === "responses";
  const url = `${server.replace(/\/+$/, "")}/v1/${isResponses ? "responses" : "chat/completions"}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const body = isResponses
    ? { model: model.id, input: "Reply with exactly: OK", max_output_tokens: 16 }
    : { model: model.id, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16 };
  const res = await request(url, headers, body, TIMEOUT);
  return { ...res, ...verdict(res.status, res.text), via: "proxy" };
}

function readKey() {
  if (process.env.PROXY_API_KEY) return process.env.PROXY_API_KEY;
  if (args.includes("--key")) return getArg("key", "");
  const keyFile = process.env.KEYS_FILE || path.join(HERE, "api-keys.json");
  try {
    const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    return Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const models = (catalog.models || []).filter((m) => m.supported !== false && (!ONLY || m.id === ONLY));
  const key = SERVER ? readKey() : "";

  console.log(`opencode-free-proxy doctor — catalog ${catalog.updated} (opencode ${catalog.opencodeVersion})`);
  console.log(SERVER ? `Probing through proxy ${SERVER}\n` : `Probing Zen directly at ${ZEN_BASE}\n`);

  if (!SERVER) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(`${ZEN_BASE}/models`, { headers: { Accept: "application/json", ...zenHeaders() }, signal: ctl.signal });
      const ids = ((await res.json())?.data || []).map((m) => m.id);
      console.log(`Zen model list: HTTP ${res.status}, ${ids.length} models\n`);
    } catch (err) {
      console.log(`Zen model list: UNREACHABLE (${err.name === "AbortError" ? "timeout" : err.message})\n`);
    } finally {
      clearTimeout(timer);
    }
  }

  let working = 0;
  for (const model of models) {
    const result = SERVER ? await probeProxy(model, SERVER, key) : await probeZen(model);
    const reply = (() => {
      try {
        return extractReply(JSON.parse(result.text)).replace(/\s+/g, " ").slice(0, 40);
      } catch {
        return result.text.replace(/\s+/g, " ").slice(0, 90);
      }
    })();
    const mark = result.ok ? (result.label === "OK" ? "✓" : "~") : "✗";
    if (result.ok) working += 1;
    console.log(
      `${mark} ${model.id.padEnd(34)} ${result.label.padEnd(14)} ${String(result.ms).padStart(6)}ms  ${result.note || reply}`,
    );
    if (VERBOSE && !result.ok) console.log(`    ${result.text.slice(0, 400)}`);
  }

  console.log(`\n${working}/${models.length} models usable${SERVER ? " through the proxy" : " on Zen"}.`);
  if (SERVER && !key) {
    console.log("No proxy API key found — pass --key or set PROXY_API_KEY.");
    process.exit(1);
  }
  if (working === 0) {
    console.log("Nothing works. Check your internet access, then run `npm run update:models`.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

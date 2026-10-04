#!/usr/bin/env node
/**
 * doctor — checks that the free OpenCode Zen models actually answer.
 *
 *   npm run doctor
 *   npm run doctor -- --server http://127.0.0.1:6446 --key oc-xxxx
 *   npm run doctor -- --model big-pickle --verbose
 *
 * Without --server it talks to Zen directly, using exactly the same
 * fingerprint the proxy uses (canonical ses_ id, opencode User-Agent,
 * stream:true, bash/glob/grep/read tool quartet). That tells you whether the
 * free tier is reachable from your machine and whether the fingerprint is
 * still accepted. With --server it goes through your running proxy instead.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyProbe, probeModel } from "../lib/probe.mjs";
import { generateSessionId, zenHeaders } from "../lib/zen.mjs";

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

async function request(url, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 0,
      text: err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

const LABELS = {
  ok: { ok: true, label: "OK" },
  rate_limited: { ok: true, label: "RATE LIMITED", note: "model exists on Zen, free quota exhausted" },
  unavailable: { ok: false, label: "NOT USABLE", note: "Zen refuses it (deprecated / removed / paid-only)" },
  region_blocked: { ok: false, label: "REGION BLOCKED", note: "not served in your region" },
  access_denied: { ok: false, label: "ACCESS DENIED", note: "not free for this credential" },
  gate_failed: {
    ok: false,
    label: "FREE-TIER GATE",
    note: "Zen did not accept the client fingerprint (see README -> Free-tier gates)",
  },
  error: { ok: false, label: "ERROR", note: "transient / network" },
};

async function probeZen(model) {
  const result = await probeModel({
    zenBase: ZEN_BASE,
    userAgent: USER_AGENT,
    zenKey: process.env.ZEN_API_KEY || "public",
    client: "cli",
    project: "global",
    model,
    timeoutMs: TIMEOUT,
  });
  return { ...result, ...(LABELS[result.status] || { ok: false, label: result.status }), text: result.detail };
}

/** Goes through the proxy: a plain client-shaped request, no fingerprint. */
async function probeProxy(model, server, key) {
  const isResponses = model.endpoint === "responses";
  const url = `${server.replace(/\/+$/, "")}/v1/${isResponses ? "responses" : "chat/completions"}`;
  const body = isResponses
    ? { model: model.id, input: "Reply with exactly: OK", max_output_tokens: 32 }
    : { model: model.id, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 32 };
  const res = await request(url, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, TIMEOUT);
  const { status, detail } = classifyProbe(res.status, res.text);
  return { ...res, status, detail, ...(LABELS[status] || { ok: false, label: status }) };
}

function readKey() {
  if (process.env.PROXY_API_KEY) return process.env.PROXY_API_KEY;
  if (args.includes("--key")) return getArg("key", "");
  const keyFile = process.env.KEYS_FILE || path.join(HERE, "api-keys.json");
  try {
    return Object.values(JSON.parse(fs.readFileSync(keyFile, "utf8")))[0] || "";
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
  if (!SERVER) console.log(`User-Agent: ${USER_AGENT}\n`);

  if (!SERVER) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(`${ZEN_BASE}/models`, {
        headers: { Accept: "application/json", ...zenHeaders({ userAgent: USER_AGENT }, generateSessionId()) },
        signal: ctl.signal,
      });
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
    const mark = result.ok ? (result.label === "OK" ? "✓" : "~") : "✗";
    if (result.ok) working += 1;
    console.log(
      `${mark} ${model.id.padEnd(34)} ${result.label.padEnd(16)} ${String(result.ms).padStart(6)}ms  ${result.note || String(result.detail).slice(0, 40)}`,
    );
    if (VERBOSE && !result.ok) console.log(`    ${result.detail}`);
  }

  console.log(`\n${working}/${models.length} models usable${SERVER ? " through the proxy" : " on Zen"}.`);
  if (SERVER && !key) {
    console.log("No proxy API key found — pass --key or set PROXY_API_KEY.");
    process.exit(1);
  }
  if (working === 0) {
    console.log(
      SERVER
        ? "Nothing works through the proxy. Check the proxy logs, then run `npm run doctor` without --server."
        : "Nothing works. If every model says FREE-TIER GATE, the fingerprint in lib/zen.mjs is out of date.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

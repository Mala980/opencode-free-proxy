#!/usr/bin/env node
/**
 * doctor — checks that the free OpenCode Zen models actually answer.
 *
 *   npm run doctor
 *   npm run doctor -- --server http://127.0.0.1:6446 --key oc-xxxx
 *   npm run doctor -- --model big-pickle --verbose
 *   npm run doctor -- --compare-paths --model big-pickle
 *   npm run doctor -- --apply     # write NOT USABLE verdicts back to models.json
 *
 * --apply switches off the models Zen refuses (`supported: false` plus an
 * entry in `retired`, which is what makes `/v1/models` answer 404 with a
 * reason). Only `unavailable` is recorded: a rate limit is a quota, a region
 * error is geography, and a network error is not the model's fault — none of
 * those should disable a model permanently. Undo with `git checkout models.json`
 * or by flipping `supported` back to true.
 *
 * Without --server it talks to Zen directly, using exactly the same
 * fingerprint the proxy uses (v2.2.0 User-Agent, canonical session/affinity
 * IDs, streamed chat, v2 token field and captured builtin tools). That tells
 * you whether the free tier is reachable from your machine and whether the
 * fingerprint is still accepted. With --server it goes through your proxy.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyProbe, probeModel } from "../lib/probe.mjs";
import {
  DEFAULT_OC_CHANNEL,
  DEFAULT_OC_VERSION,
  generateSessionId,
  opencodeUserAgent,
  zenHeaders,
} from "../lib/zen.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODELS_FILE = process.env.MODELS_FILE || path.join(HERE, "models.json");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const OC_VERSION = process.env.OC_VERSION || DEFAULT_OC_VERSION;
const OC_CHANNEL = process.env.OC_CHANNEL || DEFAULT_OC_CHANNEL;
const USER_AGENT = process.env.OC_USER_AGENT || opencodeUserAgent(OC_VERSION, OC_CHANNEL);
const ZEN_BASE = (process.env.ZEN_BASE_URL || "https://opencode.ai/inference/openai/v1").replace(/\/+$/, "");
const USE_MODEL_BASE_URLS = process.env.ZEN_MODEL_BASE_URLS === "1";
const modelBase = (model) =>
  USE_MODEL_BASE_URLS && model.baseUrl ? model.baseUrl.replace(/\/+$/, "") : ZEN_BASE;
const SERVER = getArg("server", process.env.PROXY_URL || "");
const TIMEOUT = Number(getArg("timeout", process.env.ZEN_TIMEOUT_MS || 45000));
const ONLY = getArg("model", "");
const VERBOSE = hasFlag("verbose");
const APPLY = hasFlag("apply");
const COMPARE_PATHS = hasFlag("compare-paths");
const ZEN_PATHS = ["https://opencode.ai/zen/v1", "https://opencode.ai/inference/openai/v1"];

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

async function listZenModels(zenBase) {
  const timeoutMs = Math.min(TIMEOUT, 15000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${zenBase.replace(/\/+$/, "")}/models`, {
      headers: {
        ...zenHeaders(
          { userAgent: USER_AGENT, zenKey: process.env.ZEN_API_KEY || "public", client: "cli", project: "global" },
          generateSessionId(),
        ),
      },
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => null);
    const ids = (json?.data || []).map((model) => model?.id).filter(Boolean);
    return { status: res.status, ids, detail: res.ok ? `${ids.length} models` : `HTTP ${res.status}` };
  } catch (error) {
    return { status: 0, ids: [], detail: error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeZen(model, zenBase = modelBase(model)) {
  const result = await probeModel({
    zenBase,
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
    : { model: model.id, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_completion_tokens: 32 };
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
  const allModels = catalog.models || [];
  const models = allModels.filter((model) => model.supported !== false && (!ONLY || model.id === ONLY));
  const key = SERVER ? readKey() : "";

  console.log(`opencode-free-proxy doctor — catalog ${catalog.updated} (opencode ${catalog.opencodeVersion})`);
  console.log(
    SERVER
      ? `Probing through proxy ${SERVER}\n`
      : COMPARE_PATHS
        ? `Comparing both Zen API paths with the v2.2.0 request profile\n`
        : `Probing Zen directly at ${ZEN_BASE}\n`,
  );
  if (!SERVER) console.log(`User-Agent: ${USER_AGENT}\n`);

  if (COMPARE_PATHS) {
    if (SERVER || APPLY) throw new Error("--compare-paths is direct-only and cannot be combined with --apply");
    const model = allModels.find((entry) => entry.id === ONLY) ||
      models.find((entry) => entry.id === "big-pickle") ||
      models.find((entry) => entry.endpoint === "chat") ||
      models[0];
    if (!model) throw new Error("No catalog model available for the path comparison");

    console.log(`Control model: ${model.id} (${model.endpoint}) — same body/profile to both paths. Rate limits are not a refusal.\n`);
    let answered = 0;
    for (const zenBase of ZEN_PATHS) {
      const list = await listZenModels(zenBase);
      const listed = list.ids.includes(model.id) ? "listed" : list.status === 200 ? "not listed" : "unknown";
      console.log(`${zenBase}`);
      console.log(`  GET /models: HTTP ${list.status || "000"}, ${list.detail}; ${model.id} ${listed}`);
      const result = await probeZen(model, zenBase);
      const mark = result.status === "ok" ? "✓" : result.status === "rate_limited" ? "~" : "✗";
      console.log(`  ${mark} ${model.id}: ${result.label} (HTTP ${result.httpStatus || "000"}, ${result.ms}ms) — ${result.detail}`);
      if (result.status === "ok") answered += 1;
      if (result.status === "rate_limited") console.log("    Quota response: model is not disabled, but generation was not verified.");
      console.log();
    }
    console.log(`${answered}/${ZEN_PATHS.length} paths returned a generated completion.`);
    if (!answered) process.exit(1);
    return;
  }

  if (!SERVER) {
    const list = await listZenModels(ZEN_BASE);
    console.log(`Zen model list: HTTP ${list.status || "000"}, ${list.detail}\n`);
  }

  let retained = 0;
  let answered = 0;
  let rateLimited = 0;
  const dead = [];
  for (const model of models) {
    const result = SERVER ? await probeProxy(model, SERVER, key) : await probeZen(model);
    const mark = result.ok ? (result.label === "OK" ? "✓" : "~") : "✗";
    if (result.status === "ok") {
      answered += 1;
      retained += 1;
    } else if (result.status === "rate_limited") {
      rateLimited += 1;
      retained += 1;
    }
    if (APPLY && result.status === "unavailable") dead.push({ id: model.id, detail: result.detail });
    console.log(
      `${mark} ${model.id.padEnd(34)} ${result.label.padEnd(16)} ${String(result.ms).padStart(6)}ms  ${result.note || String(result.detail).slice(0, 40)}`,
    );
    if (VERBOSE && !result.ok) console.log(`    ${result.detail}`);
  }

  console.log(
    `\n${answered}/${models.length} models returned content${SERVER ? " through the proxy" : " on Zen"}; ` +
      `${rateLimited} rate-limited (retained, not counted as confirmed generations).`,
  );
  if (SERVER && !key) {
    console.log("No proxy API key found — pass --key or set PROXY_API_KEY.");
    process.exit(1);
  }
  if (APPLY) {
    if (!dead.length) {
      console.log("\n--apply: nothing to record — no model was refused by Zen.");
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const retired = { ...catalog.retired };
      let changed = 0;
      for (const { id, detail } of dead) {
        const model = catalog.models.find((m) => m.id === id);
        if (!model || model.supported === false) continue;
        model.supported = false;
        retired[id] = `Zen refused it on ${today} (${detail}). Re-check with \`npm run doctor\`.`;
        changed += 1;
      }
      if (!changed) {
        console.log("\n--apply: every refused model was already switched off.");
      } else {
        fs.writeFileSync(
          MODELS_FILE,
          `${JSON.stringify({ ...catalog, updated: today, retired }, null, 2)}\n`,
        );
        console.log(`\n--apply: switched off ${changed} model(s) in ${MODELS_FILE}`);
        console.log(`  ${dead.map((d) => d.id).join(", ")}`);
        console.log("  Undo: git checkout models.json  (or set supported back to true)");
      }
    }
  }

  if (retained === 0) {
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

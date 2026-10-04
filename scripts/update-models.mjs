#!/usr/bin/env node
/**
 * update:models — refreshes models.json against the live OpenCode Zen list.
 *
 *   npm run update:models            # rewrite models.json
 *   npm run update:models -- --dry-run
 *   npm run update:models -- --check # exit 1 when a bundled model disappeared
 *
 * Curated capability metadata (context window, tool support, endpoint …) is
 * preserved for every model id we already know about. Ids that are new on Zen
 * are added with `unverified: true` — verify them with `npm run doctor`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODELS_FILE = process.env.MODELS_FILE || path.join(HERE, "models.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");

const ZEN_BASE = (process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const OC_VERSION = process.env.OC_VERSION || "1.18.34";
const USER_AGENT =
  process.env.OC_USER_AGENT ||
  `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/${process.env.OC_RUNTIME || "bun/1.3.14"}`;

const FREE_SUFFIX = /-free$/;
const EXTRA_FREE = new Set(["big-pickle", "grok-code"]);
const looksFree = (id) => FREE_SUFFIX.test(id) || EXTRA_FREE.has(id);

function prettifyId(id) {
  return id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z]+\d*$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

async function fetchLive() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${ZEN_BASE}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.ZEN_API_KEY || "public"}`,
        "User-Agent": USER_AGENT,
        "x-opencode-client": "cli",
        "x-opencode-project": process.env.OC_PROJECT || "global",
        "x-opencode-session": `ses_${crypto.randomBytes(16).toString("hex")}`,
        "x-opencode-request": `msg_${crypto.randomBytes(16).toString("hex")}`,
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

async function main() {
  const catalog = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  let live;
  try {
    live = await fetchLive();
  } catch (err) {
    console.error(`Could not reach ${ZEN_BASE}/models (${err.message}). models.json left untouched.`);
    process.exit(1);
  }

  const kept = [];
  const removed = [];
  const retired = { ...(catalog.retired || {}) };

  for (const model of catalog.models || []) {
    if (!model?.id) continue;
    if (live.has(model.id)) {
      const { removedAt, ...rest } = model;
      kept.push(rest);
    } else {
      removed.push(model.id);
      if (model.supported === false) {
        kept.push(model); // not served by us anyway (e.g. systemone models)
      } else {
        retired[model.id] = `No longer listed on Zen (last seen ${catalog.updated}). Pick another free model.`;
      }
    }
  }

  const known = new Set(kept.map((m) => m.id));
  const added = [];
  for (const id of live) {
    if (known.has(id) || !looksFree(id)) continue;
    added.push(id);
    kept.push({
      id,
      name: prettifyId(id),
      endpoint: "chat",
      reasoning: true,
      tool_call: true,
      attachment: false,
      dynamic: true,
      unverified: true,
      notes: "Auto-discovered on Zen — verify with `npm run doctor`.",
    });
  }

  const next = {
    ...catalog,
    updated: today,
    opencodeVersion: OC_VERSION,
    models: kept,
    retired,
  };

  console.log(`Zen reports ${live.size} models.`);
  console.log(`Kept ${kept.length - added.length} bundled models, added ${added.length} new, dropped ${removed.length}.`);
  if (added.length) console.log(`  new: ${added.join(", ")}`);
  if (removed.length) console.log(`  gone: ${removed.join(", ")}`);

  if (CHECK) {
    if (removed.length) {
      console.error("\nStale catalog: some bundled models are no longer on Zen.");
      process.exit(1);
    }
    console.log("\nCatalog is up to date.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  fs.writeFileSync(MODELS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nWrote ${MODELS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

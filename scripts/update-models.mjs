#!/usr/bin/env node
/**
 * update:models — refreshes models.json.
 *
 *   npm run update:models              # rewrite models.json
 *   npm run update:models -- --dry-run
 *   npm run update:models -- --check   # exit 1 when the bundled catalog is stale
 *   npm run update:models -- --no-models-dev
 *
 * Two sources, the same ones opencode itself uses:
 *
 *   1. models.dev (https://models.dev/api.json, provider `opencode`) — the
 *      catalogue anomalyco/opencode ships and refreshes daily. It decides
 *      which models are FREE, from a real price table, and it carries the
 *      capability metadata (context window, tools, attachments, modalities).
 *   2. Zen's live /v1/models — decides which of those ids are actually
 *      served right now.
 *
 * Curated metadata (notes, `supported` …) wins over models.dev, so hand
 * written advice survives a refresh. Ids that are new are added with
 * `unverified: true` — confirm them with `npm run doctor`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { fetchFreeModels } from "../lib/models-dev.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODELS_FILE = process.env.MODELS_FILE || path.join(HERE, "models.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");
const NO_MODELS_DEV = args.includes("--no-models-dev");

const ZEN_BASE = (process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const OC_VERSION = process.env.OC_VERSION || "1.18.34";
const MODELS_DEV_URL = process.env.MODELS_DEV_API_URL || "https://models.dev/api.json";
const MODELS_DEV_PROVIDER = process.env.MODELS_DEV_PROVIDER || "opencode";
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

/**
 * models.dev fills in what the catalog does not know and refreshes what it
 * does; curated `notes` and `supported` are never overwritten.
 */
function applyModelsDev(model, upstream) {
  const changed = [];
  // Filling in something we never knew is not "stale" — only a value that
  // actually moved counts as a change (otherwise --check would never pass).
  const sync = (key, value) => {
    if (value === undefined) return;
    if (model[key] === undefined) {
      model[key] = value;
      return;
    }
    if (model[key] !== value) {
      changed.push(`${key} ${model[key]} → ${value}`);
      model[key] = value;
    }
  };

  for (const key of ["context", "input", "output"]) {
    if (Number.isFinite(upstream[key])) sync(key, upstream[key]);
  }
  for (const key of ["reasoning", "tool_call", "attachment", "structured_output", "temperature"]) {
    if (typeof upstream[key] === "boolean") sync(key, upstream[key]);
  }
  if (upstream.modalities) {
    if (!model.modalities) model.modalities = upstream.modalities;
    else if (JSON.stringify(model.modalities) !== JSON.stringify(upstream.modalities)) {
      changed.push("modalities");
      model.modalities = upstream.modalities;
    }
  }
  if (upstream.deprecated && model.status !== "deprecated") {
    model.status = "deprecated";
    changed.push("marked deprecated (upstream)");
  }
  if (!model.name && upstream.name) model.name = upstream.name;
  return changed;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const today = new Date().toISOString().slice(0, 10);

  let live = null;
  let zenError = null;
  try {
    live = await fetchLive();
  } catch (err) {
    zenError = err.message;
  }

  let dev = null;
  let devError = null;
  if (!NO_MODELS_DEV) {
    try {
      dev = await fetchFreeModels({
        url: MODELS_DEV_URL,
        provider: MODELS_DEV_PROVIDER,
        log: (line) => console.log(line),
      });
    } catch (err) {
      devError = err.message;
    }
  }

  if (!live && !dev) {
    console.error(`Could not reach ${ZEN_BASE}/models (${zenError}) nor models.dev (${devError}).`);
    console.error("models.json left untouched.");
    process.exit(1);
  }

  if (dev) {
    const stale = dev.models.filter((m) => m.deprecated).length;
    console.log(
      `models.dev (${dev.source}): ${dev.total} ${dev.provider} models, ${dev.models.length} priced at zero` +
        (stale ? ` (${stale} of them marked deprecated upstream)` : ""),
    );
  } else if (devError) {
    console.error(`! models.dev unreachable (${devError}) — keeping the bundled free list`);
  }
  if (live) {
    console.log(`Zen lists ${live.size} models.`);
  } else {
    console.error(`! Zen unreachable (${zenError}) — refreshing from models.dev only`);
  }

  const devFree = new Map((dev?.models || []).map((m) => [m.id, m]));
  const devKnown = new Set(dev?.known || []);

  const kept = [];
  const removed = [];
  const priced = [];
  const updated = [];
  const retired = { ...catalog.retired };
  const blocked = new Set([
    ...(catalog.models || []).filter((m) => m?.supported === false).map((m) => m.id),
    ...Object.keys(retired),
  ]);

  for (const model of catalog.models || []) {
    if (!model?.id) continue;
    const upstream = devFree.get(model.id);

    if (live && !live.has(model.id)) {
      removed.push(model.id);
      if (model.supported === false) {
        kept.push(model); // not served by us anyway
      } else {
        retired[model.id] = `No longer listed on Zen (last seen ${catalog.updated}). Pick another free model.`;
      }
      continue;
    }

    // models.dev publishes it with a price above zero: it is not free anymore.
    if (devKnown.has(model.id) && !upstream && model.supported !== false) {
      model.supported = false;
      model.notes = `No longer free per models.dev (${dev?.source}, ${today}). Kept in the catalog, hidden from /v1/models.`;
      priced.push(model.id);
      kept.push(model);
      continue;
    }

    if (upstream) {
      const changed = applyModelsDev(model, upstream);
      if (changed.length) updated.push(`${model.id}: ${changed.join(", ")}`);
    }
    kept.push(model);
  }

  const known = new Set(kept.map((m) => m.id));
  const added = [];

  // Free models models.dev knows about (with its real metadata), as long as
  // Zen serves them. Without Zen to cross-check we only take the ones
  // models.dev has not marked deprecated, so a flaky network cannot fill the
  // catalog with legacy ids.
  for (const upstream of devFree.values()) {
    if (known.has(upstream.id) || blocked.has(upstream.id)) continue;
    if (live && !live.has(upstream.id)) continue;
    if (!live && upstream.deprecated) continue;
    added.push(upstream.id);
    kept.push({
      ...upstream,
      dynamic: true,
      unverified: true,
      notes: `Free per models.dev — verify with \`npm run doctor\`.`,
    });
    known.add(upstream.id);
  }

  // Anything else that showed up on Zen and looks like a free model.
  for (const id of live || []) {
    if (known.has(id) || blocked.has(id) || !looksFree(id)) continue;
    const upstream = devFree.get(id);
    added.push(id);
    kept.push(
      upstream
        ? { ...upstream, dynamic: true, unverified: true }
        : {
            id,
            name: prettifyId(id),
            endpoint: "chat",
            reasoning: true,
            tool_call: true,
            attachment: false,
            dynamic: true,
            unverified: true,
            notes: "Discovered on Zen — verify with `npm run doctor`.",
          },
    );
    known.add(id);
  }

  const next = { ...catalog, updated: today, opencodeVersion: OC_VERSION, models: kept, retired };

  console.log(
    `Kept ${kept.length - added.length} bundled models, added ${added.length} new, dropped ${removed.length}, priced out ${priced.length}.`,
  );
  if (added.length) console.log(`  new: ${added.join(", ")}`);
  if (removed.length) console.log(`  gone: ${removed.join(", ")}`);
  if (priced.length) console.log(`  no longer free: ${priced.join(", ")}`);
  if (updated.length) console.log(`  refreshed from models.dev:\n    ${updated.join("\n    ")}`);

  if (CHECK) {
    const stale = removed.length || priced.length || updated.length;
    if (stale) {
      console.error("\nStale catalog: the bundled models no longer match models.dev / Zen.");
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

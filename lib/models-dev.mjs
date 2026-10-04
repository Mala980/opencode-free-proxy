/**
 * models.dev — the catalogue anomalyco/opencode itself ships.
 *
 * opencode does not hardcode a model list: `packages/core` reads the
 * `opencode` provider from https://models.dev/api.json (the repo is
 * https://github.com/anomalyco/models.dev, and the daily `models-snapshot`
 * workflow commits a refreshed snapshot). A model is free there when every
 * price in its `[cost]` table is zero — that is a lot more reliable than
 * guessing from an `-free` suffix.
 *
 * So this module does three things:
 *   1. read that catalogue (api.json, with the GitHub repo as a fallback)
 *   2. pick the free models of the `opencode` (Zen) provider
 *   3. translate them into this proxy's catalog shape
 *
 * Zero dependencies: the TOML reader below only understands the subset
 * models.dev actually uses (scalars, arrays, inline tables, [table] and
 * [[array of tables]]).
 */

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_PROVIDER = "opencode";
export const MODELS_DEV_GITHUB_API = "https://api.github.com/repos/anomalyco/models.dev";
export const MODELS_DEV_REPO_CONTENTS = `${MODELS_DEV_GITHUB_API}/contents/providers`;

const COST_KEYS = ["input", "output", "cache_read", "cache_write"];

// ── TOML (the subset models.dev uses) ──────────────────────────────
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Splits `a, b, c` at depth 0, ignoring commas inside quotes/brackets. */
function splitTopLevel(raw) {
  const items = [];
  let depth = 0;
  let quote = null;
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      buf += ch;
      if (ch === quote && raw[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) items.push(buf);
  return items.map((s) => s.trim()).filter(Boolean);
}

function parseValue(raw) {
  const text = raw.trim();
  if (text.startsWith("[")) return splitTopLevel(text.slice(1, text.lastIndexOf("]"))).map(parseValue);
  if (text.startsWith("{")) {
    const inner = text.slice(1, text.lastIndexOf("}"));
    const obj = {};
    for (const item of splitTopLevel(inner)) {
      const eq = item.indexOf("=");
      if (eq === -1) continue;
      obj[item.slice(0, eq).trim()] = parseValue(item.slice(eq + 1));
    }
    return obj;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.length >= 2 && text[0] === '"' && text.endsWith('"')) return text.slice(1, -1).replace(/\\"/g, '"');
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'")) return text.slice(1, -1);
  if (/^[+-]?[\d_]+$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?[\d_]*\.[\d_]+([eE][+-]?\d+)?$/.test(text)) return Number(text.replace(/_/g, ""));
  return text;
}

function ensurePath(root, parts) {
  let node = root;
  for (const part of parts) {
    const key = part.replace(/^"(.*)"$/, "$1");
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  return node;
}

function ensureArrayPath(root, parts) {
  const parents = parts.slice(0, -1);
  const leaf = parts[parts.length - 1];
  const parent = parents.length ? ensurePath(root, parents) : root;
  if (!Array.isArray(parent[leaf])) parent[leaf] = [];
  const node = {};
  parent[leaf].push(node);
  return node;
}

export function parseToml(text) {
  const root = {};
  const lines = String(text).split(/\r?\n/);
  let current = root;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = stripComment(lines[i]).trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("[[")) {
      const end = trimmed.indexOf("]]");
      if (end === -1) continue;
      current = ensureArrayPath(root, trimmed.slice(2, end).trim().split("."));
      continue;
    }
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]");
      if (end === -1) continue;
      current = ensurePath(root, trimmed.slice(1, end).trim().split("."));
      continue;
    }

    let raw = trimmed;
    // Arrays (and inline tables) may span several lines.
    while (count(raw, "[") + count(raw, "{") > count(raw, "]") + count(raw, "}") && i + 1 < lines.length) {
      raw += ` ${stripComment(lines[++i]).trim()}`;
    }
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim().replace(/^"(.*)"$/, "$1");
    if (key) current[key] = parseValue(raw.slice(eq + 1));
  }
  return root;
}

function count(text, ch) {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

// ── Selecting the free models ──────────────────────────────────────
/** A model is free when every price models.dev lists for it is zero. */
export function isFreeCost(cost) {
  if (!cost || typeof cost !== "object") return false;
  for (const key of COST_KEYS) {
    const value = cost[key];
    if (typeof value === "number" && value !== 0) return false;
  }
  for (const tier of cost.tiers || []) {
    for (const key of COST_KEYS) {
      const value = tier?.[key];
      if (typeof value === "number" && value !== 0) return false;
    }
  }
  // No numeric price at all: unknown, so we do not advertise it as free.
  return COST_KEYS.some((key) => typeof cost[key] === "number");
}

const FLAGS = [
  ["reasoning", "reasoning"],
  ["tool_call", "tool_call"],
  ["attachment", "attachment"],
  ["structured_output", "structured_output"],
  ["temperature", "temperature"],
  ["open_weights", "open_weights"],
];

export function prettifyId(id) {
  return id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z]+\d*$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** models.dev entry (api.json shape or parsed TOML) → our catalog shape. */
export function entryFromModelsDev(id, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!isFreeCost(raw.cost)) return null;

  const limit = raw.limit || {};
  const entry = { id, name: raw.name || prettifyId(id), endpoint: "chat", source: "models.dev" };
  if (Number.isFinite(limit.context)) entry.context = limit.context;
  if (Number.isFinite(limit.input)) entry.input = limit.input;
  if (Number.isFinite(limit.output)) entry.output = limit.output;
  for (const [from, to] of FLAGS) {
    if (typeof raw[from] === "boolean") entry[to] = raw[from];
  }
  if (raw.modalities) entry.modalities = raw.modalities;
  if (raw.family) entry.family = raw.family;
  if (raw.knowledge) entry.knowledge = raw.knowledge;
  if (raw.release_date) entry.releaseDate = raw.release_date;
  if (raw.last_updated) entry.lastUpdated = raw.last_updated;
  if (raw.status === "deprecated") entry.deprecated = true;
  if (raw.description) entry.notes = raw.description;
  return entry;
}

/** Free `opencode` (Zen) models from a full https://models.dev/api.json. */
export function freeModelsFromApi(json, provider = MODELS_DEV_PROVIDER) {
  const models = json?.[provider]?.models;
  if (!models || typeof models !== "object") return [];
  const out = [];
  for (const [id, raw] of Object.entries(models)) {
    const entry = entryFromModelsDev(id, raw);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every id models.dev publishes for the provider, free or not. */
export function knownIdsFromApi(json, provider = MODELS_DEV_PROVIDER) {
  return Object.keys(json?.[provider]?.models || {});
}

/** Same, from `[{ name, content }]` of providers/<provider>/models/*.toml. */
export function freeModelsFromTomls(files = []) {
  const out = [];
  for (const file of files) {
    const name = file?.name || "";
    if (!name.endsWith(".toml")) continue;
    const entry = entryFromModelsDev(name.slice(0, -".toml".length), parseToml(file.content || ""));
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Fetching ───────────────────────────────────────────────────────
async function getJson(url, { timeoutMs, fetchImpl, headers }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Lists the TOML files of one provider directory in the models.dev repo. */
async function listRepoFiles(provider, { timeoutMs, fetchImpl, headers }) {
  const url = `${MODELS_DEV_REPO_CONTENTS}/${provider}/models?per_page=100`;
  const files = await getJson(url, { timeoutMs, fetchImpl, headers });
  return files
    .filter((f) => f.type === "file" && f.name.endsWith(".toml"))
    .map((f) => ({ name: f.name, path: f.path }));
}

async function fetchRepoFile(path, { timeoutMs, fetchImpl, headers }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${MODELS_DEV_GITHUB_API}/contents/${path}`, {
      headers: { Accept: "application/vnd.github+json", ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.content) throw new Error("no content");
    return Buffer.from(json.content, "base64").toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the free Zen models from models.dev.
 * `models.dev/api.json` first; when that host is unreachable (corporate
 * proxies, blocked egress) it falls back to the same files in the GitHub
 * repo, which is what api.json is generated from anyway.
 */
export async function fetchFreeModels({
  url = MODELS_DEV_API_URL,
  provider = MODELS_DEV_PROVIDER,
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
  headers,
  githubFallback = true,
  log = () => {},
} = {}) {
  try {
    const json = await getJson(url, { timeoutMs, fetchImpl, headers });
    const models = freeModelsFromApi(json, provider);
    if (!models.length) throw new Error(`provider "${provider}" not found or has no free models`);
    return {
      models,
      provider,
      source: "models.dev/api.json",
      known: knownIdsFromApi(json, provider),
      total: knownIdsFromApi(json, provider).length,
    };
  } catch (err) {
    if (!githubFallback) throw err;
    log(`[models.dev] ${url} unreachable (${err.message}) — falling back to the GitHub repo`);

    const files = await listRepoFiles(provider, { timeoutMs, fetchImpl, headers });
    if (!files.length) throw new Error(`no model files for provider "${provider}"`);
    const contents = [];
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        contents.push({ name: file.name, content: await fetchRepoFile(file.path, { timeoutMs, fetchImpl, headers }) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    const models = freeModelsFromTomls(contents);
    if (!models.length) throw new Error("no free models in the models.dev repo");
    return {
      models,
      provider,
      source: "github/anomalyco/models.dev",
      known: files.map((f) => f.name.replace(/\.toml$/, "")),
      total: files.length,
    };
  }
}

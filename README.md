# opencode-free-proxy

Free models from [OpenCode Zen](https://opencode.ai/docs/zen/) served as standard
**OpenAI**, **Responses** and **Anthropic** APIs — so Cursor, Continue, Cline,
Claude Code, aider, the opencode CLI or plain `curl` can all use them.

Catalog last refreshed: **2026-10-28** · OpenCode CLI fingerprint: **v2.2.0**.
The captured request shape is tested against the official Linux CLI, but that
capture does not prove Zen accepts it; see [Live path comparison](#live-path-comparison).

## 30-second setup

```bash
git clone https://github.com/Mala980/opencode-free-proxy.git
cd opencode-free-proxy
npm install              # installs the Node binding and platform libcurl-impersonate
npm start
```

Server: `http://localhost:6446`. API keys are printed on start and stored in `api-keys.json`
(auto-generated, git-ignored).

```bash
npm run doctor          # verify the free models actually answer from your machine
```

## Free models exposed right now

| Model | Endpoint | Context | Tools | Notes |
|-------|----------|--------:|:-----:|-------|
| `big-pickle` | chat | 200K | ✓ | Prior live result exists; recheck against v2.2.0 pending |
| `mimo-v2.6-flash-free` | chat | 200K | ✓ | Prior live result exists; recheck against v2.2.0 pending |
| `nemotron-3.5-lightning-free` | chat | 262K | ✓ | Prior live result exists; recheck against v2.2.0 pending |
| `beam-free` | chat | — | ✓ | models.dev metadata; v2.2.0 live recheck pending |
| `deepseek-v4.1-flash-free` | chat | 200K | ✓ | models.dev metadata; v2.2.0 live recheck pending |
| `flint-40b-free` | chat | — | — | models.dev metadata; v2.2.0 live recheck pending |
| `glm-5.3-flash-free` | chat | 200K | ✓ | models.dev metadata; v2.2.0 live recheck pending |
| `nemotron-3.5-super-vl-free` | chat | — | — | models.dev metadata; v2.2.0 live recheck pending |

All of them stream, take system messages and (mostly) support tool calls.

The catalog currently retains eight IDs based on the last live doctor results
from **2026-10-26**, which used the previous OpenCode 1.19.4 request profile.
That is historical evidence, not a v2.2.0 Zen acceptance result. At startup the
server probes models with the v2.2.0 profile and hides definitive refusals
(unavailable, region-blocked, or access-denied). Rate limits and transient
network errors do not disable models. `GET /health` shows each verification
status; run `npm run doctor` on your own network to refresh the live result.

`jev-1.13-free` is deliberately **not** proxied: it uses OpenCode's separate
SystemOne typed-question endpoint (`https://opencode.ai/inference/systemone/v1`),
not the chat route, and remains disabled in the catalog. Paid models are also
excluded; the proxy only exposes models published at zero cost by models.dev.

models.dev marks 37 of its 47 free entries as `deprecated` (legacy/superseded).
The previous live doctor run switched off 10 models; `HIDE_DEPRECATED=1` can
skip deprecated candidates before probing, but is opt-in so live verification
remains authoritative.

### Removed since older versions of this proxy

Switched off after a live `npm run doctor` (2026-10-26) — Zen answers
`NOT USABLE` for all of them, and nine were already marked deprecated upstream:
`space-bunny-free`, `longcat-2.5-preview-free`, `fledge-alpha-free`,
`nemotron-3-ultra-free`, `ling-3.1-flash-free`, `ling-3.0-flash-fin-free`,
`deepseek-v4-flash-free`, `mimo-v2.5-free`, `muse-spark-1.3-contributor-free`
and `muse-spark-1.2-contributor-free`. They stay in `models.json` with
`supported: false`, so re-enabling one is a one-line edit.

Older removals: `minimax-m2.5-free`, `nemotron-3-super-free` and
`qwen3.6-plus-free` are gone from Zen. Requests for them (and for any other
switched-off id) return a 404 that tells you what to use instead, e.g.

```json
{ "error": { "message": "space-bunny-free is no longer available. Zen refused it on 2026-10-26 (doctor: NOT USABLE). Re-check with `npm run doctor`, or flip `supported` back to true in models.json.", "code": "model_retired" } }
```

## Free-tier gates and v2 request profile

Zen's free tier has historically required requests to resemble OpenCode CLI
traffic. The current profile is compared against a request captured from the
official **OpenCode v2.2.0** Linux CLI (`@opencode/cli-linux-x64`):

| Detail | v2.2.0 CLI capture | This proxy |
|--------|--------------------|------------|
| Transport | `FetchHttpClient` over Bun `fetch()`; the v2.2.0 build does not enable experimental HTTP/2, so HTTP/1.1 is the default | `libcurl-impersonate` Chrome 150/BoringSSL; HTTP/1.1 by default, with opportunistic `h2` only when `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1`; incremental SSE, non-streaming clients reassembled |
| `User-Agent` | `opencode/latest/2.2.0/cli` | Same by default; `OC_VERSION` / `OC_CHANNEL` can override it |
| Session/cache affinity | `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`; fork requests may include parent-session headers | Canonical v2 `ses_…` IDs; preserves valid incoming v2 session, affinity, project, client and parent headers |
| Streaming | `stream: true`, `stream_options.include_usage: true` | Same defaults; explicit usage preference is preserved |
| Compression | `gzip, deflate, br, zstd` | Preserved; `CURLOPT_ACCEPT_ENCODING` enables native streaming decompression |
| Token limit | `max_completion_tokens` | Converts client `max_tokens` to `max_completion_tokens` by default |
| Builtin tools | `edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, `execute` | Injects the captured set if absent; caller tools are preserved |

The proxy removes calls to tools it injected from chat, Responses, and Anthropic
outputs because it cannot execute OpenCode's local tools. Set
`ZEN_STRIP_INJECTED_TOOLS=0` only if the caller can handle those tool calls.

`test/fingerprint.test.mjs` checks the captured v2.2.0 request contract. **A
fixture or mock-backed test is not a live Zen acceptance test.** The proxy's
model verification and `npm run doctor` use the v2 profile, but results depend
on real access, model quotas and region. A rate limit is not treated as model
unavailability.

## Live path comparison

models.dev publishes `https://opencode.ai/inference/openai/v1` for OpenCode
models. At the user's request, this is now the configured default. That choice
is based on the v2 model catalog, **not** on a live acceptance result; the v2
CLI capture does not prove that Zen accepts requests there. Compare it with the
legacy `https://opencode.ai/zen/v1` route using the same v2 request profile
before drawing a live compatibility conclusion.

From a network that can reach `opencode.ai`, run:

```bash
npm run compare:zen -- --model big-pickle
```

The command checks `GET /models` and probes the same model against both paths.
`OK` means a completion was returned; `RATE LIMITED` means the request did not
verify generation and does **not** disable the model; `FREE-TIER GATE`,
`UNREACHABLE`, and other errors are reported separately. For ordinary catalog
verification use `npm run doctor`. To opt into per-model `baseUrl` metadata
from models.dev, set `ZEN_MODEL_BASE_URLS=1`; this is separate from changing
the global default.

### TLS / browser fingerprint

OpenCode v2.2.0 builds its CLI with Bun 1.4.4 and sends provider calls through
`FetchHttpClient` → `fetch()` without a protocol override or the experimental
HTTP/2 flag. This is visible in OpenCode's [`executor.ts`](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/ai/src/route/executor.ts), [`app-node-platform.ts`](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/util/src/effect/app-node-platform.ts), and [`CLI build script`](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/cli/script/build.ts). Its default is therefore HTTP/1.1. The proxy mirrors that default:
OpenCode HTTPS requests use HTTP/1.1 unless
`BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1` is set. With that Bun opt-in,
the proxy prefers `h2` via ALPN but accepts an HTTP/1.1 fallback, matching
`fetch()` when no per-request protocol is forced. The opt-in is scoped to
`opencode.ai` and its subdomains; redirects outside that scope are rejected.
Other transport destinations stay on HTTP/1.1. Bun documents that an
unspecified fetch protocol offers `h2` only when its experimental HTTP/2 flag
is enabled ([protocol option](https://bun.com/reference/globals/BunFetchRequestInit/protocol)).

The upstream TLS connection still uses `impers` with the pinned
`libcurl-impersonate` native library and its real **Chrome 150 / BoringSSL TLS
fingerprint**—not a User-Agent-only imitation. The client-to-proxy API
connection and proxy-to-client response are separate and remain on the local
Node HTTP server; the upstream protocol setting does not change them.

Zen generation, live model-list refresh, verification, and direct doctor probes
share this transport. Fetches from models.dev and client-facing proxy traffic do
not use the OpenCode `h2` connection. The captured OpenCode v2 headers and
`Accept-Encoding: gzip, deflate, br, zstd` are preserved.

For SSE, the adapter sets `CURLOPT_ACCEPT_ENCODING` so libcurl decompresses
compressed chunks as they arrive, then removes stale wire-level
`content-encoding` and `content-length` response headers. It bridges callbacks
to a streaming Web ReadableStream and aborts the native request when a client
disconnects or a timeout expires.

`npm install` installs `impers` and a platform-specific shared library. If the
native impersonation library or requested profile is missing, upstream calls
fail closed; the proxy does **not** silently fall back to Node TLS or ordinary
libcurl. `GET /health` reports initialization state, the selected profile,
errors, and the last negotiated HTTP version. Use `ZEN_TLS_PROFILE` only with
a profile provided by the installed library. Linux musl/Alpine users may need
to supply a compatible library using `LIBCURL_IMPERSONATE_PATH`.

The local transport test verifies actual `h2` negotiation, incremental SSE,
and gzip decompression against a local TLS server. That is not a Zen acceptance
test: whether Zen accepts this profile and the configured endpoint still needs
to be verified from a network with live access.

## API

### OpenAI — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### Responses — `POST /v1/responses`

For `muse-spark-*-free`, which Zen serves on its Responses endpoint.

```bash
curl http://localhost:6446/v1/responses \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "muse-spark-1.3-contributor-free", "input": "Hello"}'
```

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | Free models that passed verification + capability metadata (`?all=1` = include hidden) |
| `GET` | `/v1/models/detail` | Raw catalog entries |
| `GET` | `/health` | Health, upstream status, impersonated opencode version |

### Auth

`Authorization: Bearer KEY` and `x-api-key: KEY` both work on `/v1/*`.
`/health` is public. Set `PUBLIC_MODELS=1` to make `/v1/models` public too.

## Use with tools

### opencode CLI

`~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/big-pickle": {
          "id": "big-pickle",
          "name": "free/big-pickle",
          "attachment": false,
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 200000, "output": 32000 }
        },
        "free/space-bunny-free": {
          "id": "space-bunny-free",
          "name": "free/space-bunny-free",
          "attachment": true,
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 1048576, "output": 524288 }
        }
      }
    }
  }
}
```

`GET /v1/models/detail` returns exactly the fields you need to fill this in for
every model the proxy currently serves.

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API key: from `api-keys.json`
- Model: `big-pickle`

### Claude Code (Anthropic format)

```bash
ANTHROPIC_BASE_URL=http://localhost:6446 ANTHROPIC_API_KEY=YOUR_KEY claude
```

## Deploy on a VPS

```bash
git clone https://github.com/Mala980/opencode-free-proxy.git
cd opencode-free-proxy
npm ci --omit=dev                            # installs the pinned transport and native library
npm start                                    # foreground
# or
nohup npm start > proxy.log 2>&1 &           # background
```

systemd unit:

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

## Configuration

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Listen port |
| `PROXY_HOST` | `0.0.0.0` | Listen interface |
| `KEYS_FILE` | `./api-keys.json` | API keys file |
| `PROXY_API_KEY` | – | Force a single fixed key (handy in Docker) |
| `PUBLIC_MODELS` | `0` | `1` = `/v1/models` needs no key |
| `ZEN_BASE_URL` | `https://opencode.ai/inference/openai/v1` | Global upstream base selected from the v2 model catalog; live acceptance is not yet confirmed |
| `ZEN_TLS_PROFILE` | `chrome150` | Native libcurl-impersonate Chrome profile; must exist in the installed library |
| `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT` | unset | `1` = opt into `h2` for OpenCode HTTPS requests, with HTTP/1.1 fallback; mirrors Bun Fetch's experimental HTTP/2 flag |
| `LIBCURL_IMPERSONATE_PATH` | auto-detected | Path to a compatible libcurl-impersonate shared library (useful on Linux musl/Alpine) |
| `ZEN_MODEL_BASE_URLS` | `0` | `1` = use each model's models.dev `baseUrl` when available (e.g. `inference/openai/v1`) |
| `ZEN_API_KEY` | `public` | Zen key — leave as `public` for the free tier, or drop in a real Zen key |
| `ZEN_TIMEOUT_MS` | `120000` | Upstream timeout → `504` |
| `MAX_BODY_BYTES` | `12582912` | Request body limit (12 MB) |
| `OC_VERSION` | `2.2.0` | OpenCode version in the captured client profile |
| `OC_CHANNEL` | `latest` | Channel segment in the v2 User-Agent |
| `OC_USER_AGENT` | `opencode/latest/2.2.0/cli` | Full UA override |
| `ZEN_MAX_TOKENS_FIELD` | `max_completion_tokens` | Chat token-limit field; set to `max_tokens` only for a compatible route |
| `OC_CLIENT` / `OC_PROJECT` | `cli` / `global` | `x-opencode-client` / `x-opencode-project` values |
| `REFRESH_MODELS` | `1` | `0` = never call Zen's model list |
| `REFRESH_SOURCE` | `zen` | Where the free list comes from: `zen` (live `/models`), `models-dev` (the catalogue opencode ships) or `both` |
| `MODELS_DEV_API_URL` | `https://models.dev/api.json` | Override the models.dev endpoint (proxy/mirror) |
| `MODELS_DEV_PROVIDER` | `opencode` | Provider id inside models.dev |
| `MODELS_DEV_TIMEOUT_MS` | `20000` | models.dev read timeout |
| `REFRESH_INTERVAL_MS` | `21600000` | Re-sync cadence (6h) |
| `SESSION_TTL_MS` | `1800000` | Session rotation (30m) |
| `LOG_REQUESTS` | `1` | `0` = quiet |
| `FALLBACK` | `0` | `1` = retry the request on the next free model when one is rate limited |
| `FALLBACK_MAX` | `2` | How many other models to try before giving up |
| `ZEN_FORCE_STREAM` | `1` | Always call Zen with `stream:true` (gate #3). `0` = pass the caller's preference through |
| `ZEN_TOOLS` | `1` | Inject the builtin tool names (gate #4). `0` = send the caller's tools only |
| `ZEN_TOOL_SET` | `edit,glob,grep,question,read,shell,skill,subagent,webfetch,websearch,write,execute` | Captured v2.2.0 builtin names to inject |
| `ZEN_STRIP_INJECTED_TOOLS` | `1` | Hide tool calls for injected tools from callers that declared none |
| `VERIFY_MODELS` | `1` | Probe every model against Zen before advertising it |
| `VERIFY_INTERVAL_MS` | `1800000` | Re-probe cadence (30 min) |
| `VERIFY_TIMEOUT_MS` | `20000` | Per-model probe timeout |
| `VERIFY_CONCURRENCY` | `4` | Parallel probes |
| `VERIFY_STARTUP_TIMEOUT_MS` | `60000` | How long startup waits for the first probe round — verification never blocks the port |
| `HIDE_DEPRECATED` | `0` | `1` = never advertise models models.dev marks `deprecated` (they turned out to be refused by Zen) without probing them |

## Where the free list comes from

opencode does not hardcode a model list: it ships the catalogue published at
[models.dev](https://models.dev) — the `opencode` (Zen) provider, refreshed
daily by upstream's own `models-snapshot` workflow. This proxy reads the very
same catalogue, so "free" means **every price in models.dev's `[cost]` table is
zero**, not "the id happens to end in `-free`".

| Source | Decides |
|--------|---------|
| `https://models.dev/api.json` → provider `opencode` | which models are **free**, plus capability metadata (context window, tool call, attachments, modalities, `deprecated`) |
| `https://opencode.ai/inference/openai/v1/models` | which of those ids Zen **actually serves** right now |
| probe at startup (see below) | which of them answer **for you**, from **your** network |

`REFRESH_SOURCE` picks the runtime mix: `zen` (default), `models-dev`, or
`both`. With `both`, an id must be on Zen *and* priced at zero upstream. If
models.dev is unreachable the reader falls back to the same files in
[`anomalyco/models.dev`](https://github.com/anomalyco/models.dev), which is
what `api.json` is generated from.

`npm run update:models` rewrites `models.json` from both sources — keeping
curated notes, refreshing capabilities, retiring ids that disappeared and
hiding ids that are no longer free:

```
models.dev (models.dev/api.json): 118 opencode models, 37 priced at zero
Zen lists 86 models.
Kept 13 bundled models, added 0 new, dropped 0, priced out 0.
```

`npm run update:models -- --check` exits non-zero when a value upstream
changed (good for a cron job / CI — this repo runs it daily).

At startup (and every `REFRESH_INTERVAL_MS`, 6h) the proxy re-reads
`REFRESH_SOURCE` and applies the same rules; if a source is unreachable the
bundled catalog is used and `/health` says why.

Note that models.dev marks 26 of the 37 free Zen models `deprecated` — that
is upstream telling you a model is legacy (superseded, still served), **not**
that it is gone. The proxy surfaces it (`deprecation: "deprecated"` in
`/v1/models`) and lets the live probe decide whether to hide it.

`npm run doctor` then probes every model end-to-end and prints a table:

```
✓ big-pickle                         OK                812ms  OK
✓ space-bunny-free                   OK               1204ms  OK
~ mimo-v2.5-free                     RATE LIMITED      640ms  model exists on Zen, free quota exhausted
✗ nemotron-3-super-free              NOT ON ZEN        310ms  model id no longer served
```

Read it like this: `OK` and `RATE LIMITED` both mean the model is alive (a rate
limit is the shared anonymous quota, not the model's fault — retry later or set
`FALLBACK=1`), while `NOT USABLE` means Zen refuses it. Recording that last
verdict in the catalog is one flag away:

```bash
npm run doctor -- --apply     # switches off every NOT USABLE model, with a reason
```

`--apply` sets `supported: false` and adds a `retired` entry, so `/v1/models`
answers 404 with what happened. Only `unavailable` is recorded — a region block
is geography and a rate limit is a quota, neither should disable a model for
good. Undo with `git checkout models.json`.

## Only models that really work are advertised

The Zen model list is not the truth: it keeps ids that answer
`400 Model is unavailable` (deprecated), `403 RegionError` (geoblocked in
your country) or `401/403 Model access is disabled` (paid-only). Trusting it
means your client happily offers a model that fails on every call.

So at startup — and every `VERIFY_INTERVAL_MS` (default 30 min) — the proxy
sends one tiny request per model (`stream:true`, `max_tokens:16`, about 15
tokens each) and classifies the answer:

models.dev marks superseded models `deprecated`, and in practice every one of
them is refused by Zen — so `HIDE_DEPRECATED=1` skips them outright instead of
probing them first. It stays off by default: the live probe is the authority,
and a "deprecated" model that still answers is still free.

The port is bound **first**, so a slow Zen can never leave you staring at a
frozen console: verification runs in the background, logs one line per model
as it goes, and gives up *waiting* after `VERIFY_STARTUP_TIMEOUT_MS` (60s) —
the probes still in flight keep running and land in the next report. Until
the first round finishes the catalog is served unverified, which is exactly
what `VERIFY_MODELS=0` would give you anyway.

```
[MODELS] Refreshed from Zen: 86 ids upstream, 13 free models exposed
[VERIFY] probing 13 free models (4 at a time, 20000ms each), 60000ms startup budget
[VERIFY] ok            big-pickle (812ms)
[VERIFY] rate_limited  mimo-v2.5-free (640ms)
[VERIFY] hidden        muse-spark-1.3-contributor-free: Region not supported
[VERIFY] done in 12027ms — 11 ok, 1 rate_limited, 1 region_blocked
```

| Probe result | Shown in `/v1/models`? |
|--------------|------------------------|
| `ok` — answered | ✅ |
| `rate_limited` — 429 / `FreeUsageLimitError` | ✅ (quota is per egress IP and shared, not the model's fault) |
| `unavailable` — 400/404/410, deprecated, removed, paid-only | ❌ hidden |
| `region_blocked` — `RegionError` | ❌ hidden |
| `access_denied` — 401/403 | ❌ hidden |
| `error` — network/timeout/5xx | ✅ kept, transient |
| `gate_failed` — fingerprint rejected | ✅ kept + warning (affects every model, so hiding all would be a lie) |

If a round hides *everything*, the proxy keeps the catalog and warns instead
of emptying the list.

```bash
curl http://localhost:6446/health | jq .verification
# { "enabled": true, "lastRun": "…", "hidden": ["deepseek-v4-flash-free"], "results": { "big-pickle": "ok", … } }

curl -H "Authorization: Bearer KEY" "http://localhost:6446/v1/models?all=1"   # includes hidden ones + status
```

A request for a hidden model answers `404` with the reason
(`… is not currently available (unavailable: Model is unavailable …)`)
instead of failing deeper downstream.

## How it works

```
Your tool (Cursor, Claude Code, curl …)
        │
        ▼
  opencode-free-proxy      ← translates Anthropic ⇄ OpenAI, maps errors
        │
        ▼  HTTPS
  opencode.ai/inference/openai/v1/  ← selected v2 catalog base (Bearer public)
```

The captured v2.2.0 request includes these headers (fork/parent headers are
conditional):

```
Authorization: Bearer public
User-Agent: opencode/latest/2.2.0/cli
x-opencode-client: cli
x-opencode-project: global
x-opencode-session: ses_<affinity id>
x-opencode-session-id: ses_<current session id>
x-session-affinity: ses_<affinity id>
X-Session-Id: ses_<affinity id>
```

### Impersonated client version

`OC_VERSION` and `OC_CHANNEL` default to **2.2.0** and **latest**, matching the
latest OpenCode v2 release used for the captured fixture. This is a client
fingerprint choice, not a claim that Zen has accepted it live. To compare the
v2 profile against both published Zen paths, use `npm run compare:zen`; to
change the User-Agent explicitly:

```bash
OC_VERSION=2.2.0 OC_CHANNEL=latest node server.mjs
```

The User-Agent we send is not a guess: `npm run capture:fixture` points the real
CLI at a local server, records the request, and `test/fingerprint.test.mjs`
fails if we ever drift from it. Re-capture after every opencode upgrade:

```bash
npm run capture:fixture -- --bin $(command -v opencode)
```

## Development

```bash
npm test              # unit + mock integration tests; no live network
npm run lint          # oxlint
npm run compare:zen   # live comparison of both Zen paths (requires access)
npm run dev           # node --watch server.mjs
npm run capture:fixture -- --bin $(command -v opencode)   # re-record the CLI's request
```

Two kinds of tests:

- `test/proxy.test.mjs` — end-to-end against a **mock Zen**: all three API
  formats, streaming, error mapping, fallback, and the runtime verification
  (which models get hidden and why).
- `test/fingerprint.test.mjs` — a **request-shape contract test** against the
  official CLI. Versioned fixtures preserve v1.19.4 for historical comparison
  and v2.2.0 as the active target; tests assert the User-Agent, v2 session
  headers, token/stream defaults, and captured tools. This does not test Zen's
  live gate; use `npm run compare:zen` for that.
- `test/models-dev.test.mjs` — the models.dev reader against real provider
  files copied from `anomalyco/models.dev`.

CI (`.github/workflows/`) keeps upstream v2's separate lint and test jobs but
adapts their contents: this Node-only service runs on Node 18/20/22/24, plus
Node 24 on Windows; it has no Bun/Turbo monorepo, TypeScript build, or browser
suite. `models-snapshot.yml` independently re-checks models.dev + Zen daily and
opens an issue when the catalog drifts. See `AGENTS.md` for repository
conventions.

## Free-tier limits

Zen answers `FreeUsageLimitError` once a free model's quota is used up. The proxy
turns that into a proper `429` (and, when it shows up mid-stream, into an SSE
error frame instead of a truncated response). Set `FALLBACK=1` to have the proxy
transparently retry on the next free model instead.

## Troubleshooting

| Symptom | What to do |
|---------|-----------|
| `FreeTierError: ... can only be used from within OpenCode` | Run `npm run compare:zen -- --model big-pickle`; if both routes report `FREE-TIER GATE`, compare the capture contract and try `ZEN_TOOL_SET`, `OC_VERSION` or `OC_CHANNEL` |
| `RATE LIMITED` on every model | The anonymous quota is per egress IP and shared; wait, set `FALLBACK=1` so the proxy hops to the next free model, or set `ZEN_API_KEY` to a real Zen key |
| `REGION BLOCKED` on `muse-spark-*-free` / `fledge-alpha-free` | Geoblocked at the Zen layer, nothing the proxy can do — pick another model |
| `NOT USABLE` / `NOT ON ZEN` | The model rotated out or is geoblocked. It is auto-hidden from `/v1/models`; `npm run update:models` refreshes the catalog |
| `/v1/models` is empty or missing a model | Check `GET /health` → `verification.hidden` and `modelsDev.error`; set `VERIFY_MODELS=0` to see the raw catalog |
| A model vanished after enabling `REFRESH_SOURCE=both` | models.dev now prices it above zero (or does not publish it). Check `/health` → `modelsDev.free` |
| The log stops after `[MODELS] Refreshed from Zen: …` | Not stuck — the probe round is running in the background (up to `VERIFY_STARTUP_TIMEOUT_MS`). The port is already open; watch `GET /health` → `verification.running`, or skip it with `VERIFY_MODELS=0` |
| Startup waits a minute before printing `models` | Zen is slow to answer probes. Lower `VERIFY_TIMEOUT_MS` / `VERIFY_STARTUP_TIMEOUT_MS`, or raise `VERIFY_CONCURRENCY` |
| Every model returns 404/401, or `update:models` reports a models.dev base mismatch | Run `npm run compare:zen -- --model big-pickle` from a network that can reach both paths; do not change the global default based only on catalog metadata |
| `UNREACHABLE` | Network/DNS. Check both `https://opencode.ai/zen/v1/models` and `https://opencode.ai/inference/openai/v1/models` |

## Notes

- Free models are **rate limited** and can disappear without notice; the proxy
  surfaces Zen's `FreeUsageLimitError` as a clean `429` instead of a truncated
  stream.
- Some free providers (Big Pickle, Fledge Alpha, MiMo/Ling previews) may use
  your prompts to improve their model during the free period. NVIDIA's free
  endpoints are explicitly trial-only — don't send confidential data there.
- Unofficial project, not affiliated with the OpenCode team. Be reasonable with
  the free tier.

## License

MIT

# opencode-free-proxy

Free models from [OpenCode Zen](https://opencode.ai/docs/zen/) served as standard
**OpenAI**, **Responses** and **Anthropic** APIs — so Cursor, Continue, Cline,
Claude Code, aider, the opencode CLI or plain `curl` can all use them.

Catalog last synced: **2026-10-04** · opencode **1.18.34** (2.0.22 is current, both
work — see [Version](#impersonated-client-version)).

## 30-second setup

```bash
git clone https://github.com/Mala980/opencode-free-proxy.git
cd opencode-free-proxy
node server.mjs          # zero dependencies, no npm install needed
```

Server: `http://localhost:6446`. API keys are printed on start and stored in `api-keys.json`
(auto-generated, git-ignored).

```bash
npm run doctor          # verify the free models actually answer from your machine
```

## Free models exposed right now

| Model | Endpoint | Context | Tools | Notes |
|-------|----------|--------:|:-----:|-------|
| `big-pickle` | chat | 200K | ✓ | Stealth reasoning model, free for a limited time |
| `space-bunny-free` | chat | 1M | ✓ | Multimodal, zero-retention provider |
| `longcat-2.5-preview-free` | chat | 1M | ✓ | Multimodal, zero-retention provider |
| `fledge-alpha-free` | chat | 1M | ✓ | Newest free model (2026-10-01) |
| `nemotron-3-ultra-free` | chat | 1M | ✓ | NVIDIA trial endpoint |
| `nemotron-3.5-lightning-free` | chat | 262K | ✓ | NVIDIA trial endpoint |
| `ling-3.1-flash-free` | chat | 262K | ✓ | Reasoning toggle |
| `ling-3.0-flash-fin-free` | chat | 262K | ✓ | Finance-tuned |
| `mimo-v2.6-flash-free` | chat | 200K | ✓ | Multimodal |
| `deepseek-v4-flash-free` | chat | 200K | ✓ | Deprecated upstream, still served |
| `mimo-v2.5-free` | chat | 200K | ✓ | Deprecated upstream, still served |
| `muse-spark-1.3-contributor-free` | **responses** | 1M | ✓ | Use `POST /v1/responses` |

All of them stream, take system messages and (mostly) support tool calls.

The list above is what the catalog ships; the server additionally **tests every
model against Zen at startup** and hides the ones that turn out to be
unusable (deprecated ids that answer `400 Model is unavailable`, geoblocked
ids that answer `RegionError`, paid-only ids). `GET /health` shows what was
hidden and why, so `GET /v1/models` only ever lists models that really
answered a real request.

Two free ids are deliberately **not** proxied: `jev-1.13-free` (a typed-question
API on `/zen/v1/systemone`, not chat) and anything that isn't free — the proxy
only ever exposes models that cost $0 on Zen.

### Removed since older versions of this proxy

`minimax-m2.5-free`, `nemotron-3-super-free` and `qwen3.6-plus-free` are gone from
Zen. Requests for them return a 404 that tells you what to use instead, e.g.

```json
{ "error": { "message": "minimax-m2.5-free is no longer available. Removed from Zen (MiniMax M2.5 deprecated 2026-08-05). Use mimo-v2.6-flash-free or big-pickle.", "code": "model_retired" } }
```

## Free-tier gates (read this if you get a 403)

Since 2026-09-16 OpenCode Zen only answers free-tier requests that look like
they come from the OpenCode CLI. Anything else gets:

```json
{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

The gates (reverse engineered live by the community —
[9router#4101](https://github.com/decolua/9router/issues/4101),
[9router#4132](https://github.com/decolua/9router/pulls/4132),
[pi-free#544](https://github.com/apmantza/pi-free/issues/544)):

| # | Zen requires | This proxy sends |
|---|--------------|-----------------|
| 1 | `User-Agent` leading `opencode/<version>`, version ≥ 1.17.0 | `opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` (verified byte-for-byte against the real 1.18.34 CLI) |
| 2 | `x-opencode-session` matching `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` | canonical ids from `lib/zen.mjs` (same scheme as OpenCode's ULID) |
| 3 | `stream: true` | always streamed upstream; non-streaming client requests are re-assembled into one response |
| 4 | `tools[]` containing the builtin names | `bash`, `edit`, `glob`, `grep`, `read` injected when the caller didn't declare them |

Consequences worth knowing:

- Tool calls for the **injected** names are dropped from non-streaming
  responses (`ZEN_STRIP_INJECTED_TOOLS=0` keeps them) — your client has no way
  to run them anyway.
- If Zen retunes the gate again, the fix is usually one line: set
  `ZEN_TOOL_SET=bash,edit,glob,grep,read,write` (or whatever the new set is)
  or bump `OC_VERSION`. Run `npm run doctor` to confirm.

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
node server.mjs                              # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &     # background
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
| `ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | Upstream (also useful for testing against a mock) |
| `ZEN_API_KEY` | `public` | Zen key — leave as `public` for the free tier, or drop in a real Zen key |
| `ZEN_TIMEOUT_MS` | `120000` | Upstream timeout → `504` |
| `MAX_BODY_BYTES` | `12582912` | Request body limit (12 MB) |
| `OC_VERSION` | `1.18.34` | opencode version to impersonate |
| `OC_USER_AGENT` | `opencode/<ver> ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` | Full UA override |
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
| `ZEN_TOOL_SET` | `bash,edit,glob,grep,read` | Which tool names to inject |
| `ZEN_STRIP_INJECTED_TOOLS` | `1` | Hide tool calls for injected tools from callers that declared none |
| `VERIFY_MODELS` | `1` | Probe every model against Zen before advertising it |
| `VERIFY_INTERVAL_MS` | `1800000` | Re-probe cadence (30 min) |
| `VERIFY_TIMEOUT_MS` | `20000` | Per-model probe timeout |
| `VERIFY_CONCURRENCY` | `4` | Parallel probes |
| `VERIFY_STARTUP_TIMEOUT_MS` | `60000` | How long startup waits for the first probe round — verification never blocks the port |

## Where the free list comes from

opencode does not hardcode a model list: it ships the catalogue published at
[models.dev](https://models.dev) — the `opencode` (Zen) provider, refreshed
daily by upstream's own `models-snapshot` workflow. This proxy reads the very
same catalogue, so "free" means **every price in models.dev's `[cost]` table is
zero**, not "the id happens to end in `-free`".

| Source | Decides |
|--------|---------|
| `https://models.dev/api.json` → provider `opencode` | which models are **free**, plus capability metadata (context window, tool call, attachments, modalities, `deprecated`) |
| `https://opencode.ai/zen/v1/models` | which of those ids Zen **actually serves** right now |
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

## Only models that really work are advertised

The Zen model list is not the truth: it keeps ids that answer
`400 Model is unavailable` (deprecated), `403 RegionError` (geoblocked in
your country) or `401/403 Model access is disabled` (paid-only). Trusting it
means your client happily offers a model that fails on every call.

So at startup — and every `VERIFY_INTERVAL_MS` (default 30 min) — the proxy
sends one tiny request per model (`stream:true`, `max_tokens:16`, about 15
tokens each) and classifies the answer:

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
  opencode.ai/zen/v1/      ← free tier (Authorization: Bearer public)
```

Zen requires the client headers the opencode CLI sends. Without them, even
`Bearer public` is rejected with `AuthError`:

```
Authorization: Bearer public
User-Agent: opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: global
x-opencode-session: ses_<id>
x-opencode-session-id: ses_<id>
x-opencode-request: msg_<id>
```

### Impersonated client version

`OC_VERSION` defaults to **1.18.34**, the newest stable opencode 1.x — the line
that still ships the Zen free-tier flow this proxy mimics (`apiKey: "public"`
when no Zen key is configured). opencode **2.0.22** exists and keeps the same
free-tier path, it just moved to `x-opencode-session-id`. The proxy sends both
families of headers, so switching is a one-liner:

```bash
OC_VERSION=2.0.22 OC_RUNTIME=bun/1.4.2 node server.mjs
```

## Development

```bash
npm test              # 62 tests, no network, ~4s
npm run lint          # oxlint (the same linter anomalyco/opencode uses)
npm run dev           # node --watch server.mjs
npm run capture:fixture -- --bin $(command -v opencode)   # re-record the CLI's request
```

Two kinds of tests:

- `test/proxy.test.mjs` — end-to-end against a **mock Zen**: all three API
  formats, streaming, error mapping, fallback, and the runtime verification
  (which models get hidden and why).
- `test/fingerprint.test.mjs` — a **contract test** against the official
  client. `test/fixtures/opencode-cli-1.18.34.json` holds a request recorded
  from the real opencode CLI (captured by pointing it at a local server), and
  the test asserts our User-Agent, `x-opencode-*` headers, id shapes and
  injected tool names still match it. If Zen's gates change, this fails here
  instead of in production.

CI (`.github/workflows/`) mirrors upstream's setup: `test.yml` runs the suite
on Node 18/20/22 plus lint on every push and PR, and `models-snapshot.yml`
re-checks the catalog against Zen daily and opens an issue when it drifts.
See `AGENTS.md` for the branch/commit conventions used in this repo.

## Free-tier limits

Zen answers `FreeUsageLimitError` once a free model's quota is used up. The proxy
turns that into a proper `429` (and, when it shows up mid-stream, into an SSE
error frame instead of a truncated response). Set `FALLBACK=1` to have the proxy
transparently retry on the next free model instead.

## Troubleshooting

| Symptom | What to do |
|---------|-----------|
| `FreeTierError: ... can only be used from within OpenCode` | `npm run doctor`. If it says `FREE-TIER GATE`, Zen retuned a gate — check the table above and try `ZEN_TOOL_SET` / `OC_VERSION` |
| `RATE LIMITED` on every model | The anonymous quota is per egress IP and shared; wait, or set `ZEN_API_KEY` to a real Zen key |
| `REGION BLOCKED` on `muse-spark-*-free` / `fledge-alpha-free` | Geoblocked at the Zen layer, nothing the proxy can do — pick another model |
| `NOT USABLE` / `NOT ON ZEN` | The model rotated out or is geoblocked. It is auto-hidden from `/v1/models`; `npm run update:models` refreshes the catalog |
| `/v1/models` is empty or missing a model | Check `GET /health` → `verification.hidden` and `modelsDev.error`; set `VERIFY_MODELS=0` to see the raw catalog |
| A model vanished after enabling `REFRESH_SOURCE=both` | models.dev now prices it above zero (or does not publish it). Check `/health` → `modelsDev.free` |
| The log stops after `[MODELS] Refreshed from Zen: …` | Not stuck — the probe round is running in the background (up to `VERIFY_STARTUP_TIMEOUT_MS`). The port is already open; watch `GET /health` → `verification.running`, or skip it with `VERIFY_MODELS=0` |
| Startup waits a minute before printing `models` | Zen is slow to answer probes. Lower `VERIFY_TIMEOUT_MS` / `VERIFY_STARTUP_TIMEOUT_MS`, or raise `VERIFY_CONCURRENCY` |
| `UNREACHABLE` | Network/DNS. Check you can `curl https://opencode.ai/zen/v1/models` |

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

# AGENTS.md

How to work in this repo. The conventions follow
[anomalyco/opencode](https://github.com/anomalyco/opencode)'s own AGENTS.md,
scaled down to a Node proxy with a small, pinned native upstream transport.

## Ground rules

- Upstream's default branch is `dev` and PRs target it; this repo's default
  branch is `main`.
- Branch names: at most three words, hyphenated, no slashes or type prefixes
  (`free-tier-fingerprint`, not `fix/free-tier`).
- Commits and PR titles use conventional commits: `type(scope): summary` with
  `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. Scopes used here:
  `proxy`, `zen`, `models`, `doctor`, `ci`.
- Upstream asks for a small looping SVG under `### Visual` in the body of
  user-facing `feat`/`fix`/`perf` PRs (240×72, < 8 KB, CSS/SMIL only). Do the
  same when the change is visible to users.
- The HTTP service uses Node builtins plus `impers` and pinned platform
  `libcurl-impersonate` binaries for Chrome TLS/HTTP2. Fail closed if native
  impersonation is unavailable; never fall back to ordinary Node/libcurl TLS.
- Lint with `oxlint` (same linter upstream uses): `npm run lint`.

## Style

Mirrors upstream's style guide where it applies to plain JS:

- `const` over `let`; early returns over reassignment.
- No aliased or star imports — if a name collides, rename our own function.
- Prefer `map`/`filter`/`for…of` over index loops.
- Don't extract a helper for a single call site.
- Avoid `try`/`catch` where the error path is genuinely exceptional.
- Avoid unnecessary destructuring; use dot notation so context survives.
- Avoid `else` — return early instead.
- Inline a value that is only used once instead of naming it.

## Tests

```bash
npm test                 # node --test, mock-backed/no live network
npm run lint             # oxlint
npm run doctor           # live model check against Zen (needs network)
npm run compare:zen      # compare both published Zen paths (needs network)
```

Upstream's rule is "avoid mocks, test the real implementation" — we break it
deliberately: Zen is a paid, rate-limited third-party service, so `npm test`
runs against a mock upstream and against *recordings* of the real things (the
CLI request, models.dev provider files). Live checks stay in `npm run doctor`.

Layout:

| File | Covers |
|------|--------|
| `test/proxy.test.mjs` | end-to-end against a **mock Zen**: OpenAI/Anthropic/Responses formats, streaming, error mapping, fallback, runtime verification |
| `test/fingerprint.test.mjs` | **contract**: what we send must equal what the real CLI sends (from `test/fixtures/opencode-cli-*.json`) |
| `test/transport.test.mjs` | transport adapter contract plus local TLS/H2/SSE/decompression verification (skips if native library or OpenSSL is unavailable) |
| `test/models-dev.test.mjs` | **contract**: the models.dev reader against real provider files (from `test/fixtures/models-dev-toml/`) |

CI keeps the upstream v2 lint/test split but adapts it to this Node service:
`check.yml` runs oxlint; `check-test.yml` installs the lockfile and tests Node
18/20/22/24 on Linux plus Node 24 on Windows. Upstream v2 uses Bun, TypeScript,
Turbo and a much larger Linux/Windows build/e2e matrix; this proxy has no
corresponding monorepo packages or browser suite.

Two rules for tests:

1. Never hit the public network in `npm test`. Proxy tests use the mock
   upstream in `test/proxy.test.mjs`; the transport test may bind a local TLS
   server to verify actual H2/SSE/decompression behavior.
2. When the client fingerprint changes, re-capture the fixture first
   (`npm run capture:fixture -- --bin $(command -v opencode)`), then let the
   contract test tell you what to fix.

## Keeping up with OpenCode

The free tier is a moving target. In order of freshness:

1. `npm run doctor` — probes every model live, reports which ones work.
   `npm run doctor -- --apply` writes the `NOT USABLE` verdicts back into
   `models.json` (`supported: false` + a `retired` reason); nothing else is
   recorded, because a rate limit or a region block is not the model's fault.
2. `npm run update:models` — rewrites `models.json` from **models.dev**
   (the catalogue opencode ships, free = every price is zero) crossed with
   Zen's live list (`--check` exits non-zero when the catalog is stale; CI
   runs it daily).
3. `npm run capture:fixture` — re-records the official client's request after
   an opencode upgrade. Do this whenever `OC_VERSION` is bumped.

`models.json` is the data: model ids, endpoint, context window, tool/reasoning
support, plus a `retired` map explaining what happened to removed ids.

`lib/models-dev.mjs` reads that catalogue: `models.dev/api.json` first, and the
same files in `anomalyco/models.dev` over the GitHub API when that host is
blocked. It contains a small TOML reader (the subset models.dev uses) — keep it
dependency-free, and validate changes against the fixtures before shipping.

models.dev ships `schema = 2` now: prices are nested per modality
(`[cost.text.input] price`), capabilities moved under `[capabilities]`
(`tools = { supported = true }`), `attachment` is implied by non-text input
modalities, and `[api.*]` says which surface serves the model. The reader walks
the cost table for numeric leaves and accepts either schema — both shapes have
fixtures (`test/fixtures/models-dev-toml-v1`, `-v2`) and tests, so a third
migration shows up as a test failure instead of an empty free list.

## Current v2.2.0 request profile and endpoint policy

`lib/zen.mjs` is aligned to the official OpenCode v2.2.0 Linux CLI capture at
`test/fixtures/opencode-cli-2.2.0.json`. Keep `models.json`, the User-Agent,
and that fixture on the same target. The captured ordinary chat path is HTTP
OpenAI Chat Completions with SSE; don't claim support for every upstream
transport merely because the v2 CLI has transport abstractions.

The captured contract includes:

1. `User-Agent: opencode/latest/2.2.0/cli`.
2. Canonical `ses_` session IDs plus affinity headers; preserve valid client
   session/affinity/project/client and conditional parent-session headers.
3. `stream: true`, `stream_options.include_usage: true`, and
   `max_completion_tokens` for chat requests.
4. The v2.2.0 builtin names `edit, glob, grep, question, read, shell, skill,
   subagent, webfetch, websearch, write, execute`.

The capture/fingerprint tests verify request shape only. Mock-backed tests do
not prove Zen accepts the profile. Run `npm run compare:zen -- --model
big-pickle` and `npm run doctor` from a network that can reach Zen; rate limits
must never mark a model unavailable.

The v2 model catalog publishes `https://opencode.ai/inference/openai/v1`.
The user explicitly selected it as the new global default; this does not mean
live acceptance is verified. Keep `npm run compare:zen` for side-by-side live
checks against `https://opencode.ai/zen/v1`, and qualify results because mocks
and request captures cannot prove the live service accepts the request. Users
can override `ZEN_BASE_URL` to test either route.

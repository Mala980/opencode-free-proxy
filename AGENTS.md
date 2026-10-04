# AGENTS.md

How to work in this repo. The conventions follow
[anomalyco/opencode](https://github.com/anomalyco/opencode)'s own AGENTS.md,
scaled down to a single-file, zero-dependency Node proxy.

## Ground rules

- Default upstream branch is `dev`; this repo's default branch is `main`.
- Branch names: at most three words, hyphenated, no slashes or type prefixes
  (`free-tier-fingerprint`, not `fix/free-tier`).
- Commits and PR titles use conventional commits: `type(scope): summary` with
  `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. Scopes used here:
  `proxy`, `zen`, `models`, `doctor`, `ci`.
- Runtime stays **dependency-free** (`server.mjs` uses only `node:` builtins).
  Dev-only dependencies (linters) are fine.
- Lint with `oxlint` (same linter upstream uses): `npm run lint`.

## Style

Mirrors upstream's style guide where it applies to plain JS:

- `const` over `let`; early returns over reassignment.
- No aliased or star imports — if a name collides, rename our own function.
- Prefer `map`/`filter`/`for…of` over index loops.
- Don't extract a helper for a single call site.
- Avoid `try`/`catch` where the error path is genuinely exceptional.

## Tests

```bash
npm test                 # node --test, 62 tests, no network
npm run lint             # oxlint
npm run doctor           # live check against Zen (needs network)
```

Layout:

| File | Covers |
|------|--------|
| `test/proxy.test.mjs` | end-to-end against a **mock Zen**: OpenAI/Anthropic/Responses formats, streaming, error mapping, fallback, runtime verification |
| `test/fingerprint.test.mjs` | **contract**: what we send must equal what the real CLI sends (from `test/fixtures/opencode-cli-*.json`) |
| `test/models-dev.test.mjs` | **contract**: the models.dev reader against real provider files (from `test/fixtures/models-dev-toml/`) |

Two rules for tests:

1. Never hit the network in `npm test`. Everything goes through the mock
   upstream in `test/proxy.test.mjs`.
2. When the client fingerprint changes, re-capture the fixture first
   (`npm run capture:fixture -- --bin $(command -v opencode)`), then let the
   contract test tell you what to fix.

## Keeping up with OpenCode

The free tier is a moving target. In order of freshness:

1. `npm run doctor` — probes every model live, reports which ones work.
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

## What the proxy must keep doing

Zen only answers free-tier requests that look like the official agentic
client (see README → Free-tier gates). Four things, all in `lib/zen.mjs`:

1. `User-Agent: opencode/<version> …` with version ≥ 1.17.0
2. `x-opencode-session` = `ses_<12 hex><14 alnum>`
3. `stream: true` upstream (non-streaming callers get a re-assembled response)
4. `tools[]` containing the builtin names `bash, edit, glob, grep, read`

`test/fingerprint.test.mjs` enforces 1, 2 and 4 against the captured CLI
request; `test/proxy.test.mjs` enforces 3.

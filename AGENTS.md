# AGENTS.md — pi-codemie

Pi coding-agent extension that bridges to **CodeMie (AI/Run)**, EPAM's enterprise
LLM gateway. It is a **single-file pi extension** (`extensions/codemie.ts`) plus a
`README.md`. There is no build step — the extension source is published and loaded
as-is by pi.

## What it does

- Registers **two pi providers** backed by the *same* CodeMie account/session:
  - `codemie` — billed to the Web/Platform LiteLLM bucket.
  - `codemie-cli` — identical models/routing, but adds headers
    (`X-CodeMie-Client`/`X-CodeMie-CLI`/`X-CodeMie-Project` + UUID
    Session/Request-IDs) that route spend into the separate `"(cli)"` bucket.
- **Dynamic model discovery**: a synchronous seed list registers at load so pi
  starts instantly; the full catalog is fetched in the background from
  `GET {apiUrl}/v1/llm_models` (8s timeouts, non-blocking, falls back to seed
  list on any failure) and cached to `~/.pi/cache/codemie-models.json` (24h TTL,
  keyed by API base URL).
- **Two auth modes** (checked in order):
  1. **Env-var / CI**: `CODEMIE_JWT_TOKEN`/`CODEMIE_API_KEY` (Bearer) or
     `CODEMIE_COOKIE` (raw Cookie), plus optional `CODEMIE_BASE_URL`.
  2. **OAuth SSO**: browser-based login (`/login codemie` or auto-on-first-use),
     mirroring codemie-code's CLI. Credentials persist in `~/.pi/agent/auth.json`.
     The gateway authenticates API calls with the `_oauth2_proxy` session cookie
     (Bearer JWTs are 302-redirected to SSO), so the raw cookie is exported to
     `~/.pi/agent/codemie-cookie.txt` and exposed to the provider via the
     `Cookie: $CODEMIE_SESSION_COOKIE` env interpolation (no shell needed — works
     on Windows).
- **Protocol routing**: Claude models → native Anthropic Messages
  (`{apiUrl}/v1/messages`, preserves thinking/caching); everything else → OpenAI
  Chat Completions (`{apiUrl}/v1`). Newer GPT-5.x/Codex ids set `api: openai-responses`.
- **Image generation**: CodeMie has no dedicated `/images` endpoint — generation
  rides chat/completions and returns images inline in `message.images[]`. For
  image-capable models, a custom `streamSimple` calls chat/completions
  (non-streaming), saves each image to `~/.pi/cache/codemie-generated-images/`,
  reports the saved path as a clickable `file://` link, and adds a TUI-only
  `Image` entry for inline preview.
- **Commands**: `/codemie-prices`, `/codemie-capabilities`, `/codemie-usage`
  (the latter also surfaces **orphaned spend** — `summaries.total_money_spent` −
  Σ `budget_usage` rows — a safety net for any spend the backend left out of
  every budget row, e.g. missing `X-CodeMie-Project` on affected accounts),
  plus a `codemie-generated-image` entry renderer.
- **Status bar**: two compact, per-channel budget widgets, visible only while a
  model from their provider is active, refreshed every 10 min.

## File layout

```
extensions/codemie.ts   ← the entire extension (entry export default function (pi))
README.md               ← user-facing docs (install, auth, billing, commands)
package.json            ← pi extension manifest (no build/test scripts)
.github/workflows/publish.yml
```

`package.json` key fields:
- `pi.extensions: ["./extensions"]` — pi loads this dir on install.
- `files: ["extensions", "README.md"]` — only these are published to npm.
- `peerDependencies`: `@earendil-works/pi-coding-agent` (`*`) and `typebox` (`*`).
- `publishConfig.registry`: `https://registry.npmjs.org/`.
- **No `scripts`** (no build, lint, or test) — TypeScript is consumed directly by pi.

## Key constants / endpoints (in `codemie.ts`)

- `DEFAULT_CODEMIE_URL = https://codemie.lab.epam.com` (override via `CODEMIE_BASE_URL`).
- `ensureApiBase(rawUrl)` appends `/code-assistant-api` to a bare host — all backend
  routes live under it (mirrors codemie-code's `ensureApiBase`).
- Discovery: `GET {apiUrl}/v1/llm_models?include_all=true`
- Billing project: `GET {apiUrl}/v1/user` → `username`/`email` → `X-CodeMie-Project`.
- Usage: `GET {apiUrl}/v1/analytics/budget_usage` (lags ~5-10 min) +
  `GET {apiUrl}/v1/analytics/cli-summary` (fast, ~20-30s; CLI channel only).
- SSO callback: `GET {codeMieUrl}/v1/auth/login/{port}` (local server decodes base64 token).

## Conventions & gotchas

- **One account, multiple buckets.** Bucket attribution varies by
  **backend/time — not by account** (pgciq is the author's username, not a
  CodeMie account; login is always gary_pan on every machine). Omitting
  `X-CodeMie-Project` is never free — spend always counts in the account-wide
  `summaries`/`cli-summary` totals — but whether it also lands in a
  `budget_usage` row (and which row) varies: on 2026-08-27 (author's other
  machine, gary_pan login) missing it orphaned the spend, while on
  2026-08-30 (this machine, gary_pan login) the gateway ignored the project
  header entirely and resolved by **CLI header + model class** (non-premium +
  `X-CodeMie-CLI` → "(cli)", non-premium without it → plain, premium →
  "(premium)"; full 6-combination matrix plus a bogus-`X-CodeMie-Project`
  probe all live-verified — no orphan reproducible).
  Never rely on any of this to dodge budget caps. `/codemie-usage` keeps an
  **Orphaned spend** row (`summaries.total_money_spent` − Σ `budget_usage`
  rows, shown when > 0) as a safety net for *any* spend the backend left out
  of every budget row (backend/time changes, unmapped model class, request
  resolving to no customer, transient lag).
  To reproduce the "missing `X-CodeMie-Project`" request shape on demand set
  `CODEMIE_FORCE_NO_PROJECT=1` (outcome is backend/time-dependent). The `summaries`
  call passes `time_period=current_month` (constant `SUMMARIES_TIME_PERIOD`) to
  match the billing period, falling back to the default window if the param is
  rejected.
- **Reasonable-thinking map** for reasoning models is fixed to
  `low/medium/high/xhigh/max` (no `minimal` — the gateway rejects it). Adaptive
  thinking is forced for `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-opus-4-[6-8]`,
  `claude-opus-5`.
- **Capabilities** are read from CodeMie's live schema: `multimodal` → vision,
  `supports_image_generation` → image, `features.tools` (an **object**, not array)
  → tools. video/audio are not exposed and stay `false`.
- **Cost conversion**: CodeMie reports per-token; pi expects per-1M, so `rate()`
  multiplies by `1_000_000` (with `isValidRate` guards).
- **`registerProviders()` is called twice** — once synchronously with seed/cached
  models, again in background discovery. The CLI models are **deep-cloned**
  (cost/compat/thinkingLevelMap) before the second `registerProvider` so pi's
  per-registration state isn't shared by reference.
- **Startup never opens a browser**; login is lazy (on `/login` or first
  credential refresh).
- Use `console.error` for diagnostics (goes to the TUI, not assistant output);
  command output goes through `pi.appendEntry(...)` + entry renderers, or
  `console.log` in print/json mode (where `notify()` is a no-op).

## Build / publish

Published to npm via **GitHub Actions + npm Trusted Publishing (OIDC)** — no
long-lived npm tokens. Trigger: push a `v*` tag.

```bash
npm version patch        # or minor / major
git push && git push --tags
```

`.github/workflows/publish.yml` runs on `ubuntu-latest` (Node 22), `npm ci`, then
`npm publish --access public --provenance`. The package is published verbatim —
make sure `extensions/` and `README.md` are the only files that matter (respect
`.gitignore`: `node_modules/`, `.vscode/`).

## Testing / verification habits

Behavior here is verified empirically against a live CodeMie account (the README
documents measured billing-channel and latency findings). When changing auth,
billing headers, or model-routing logic, re-verify with a real request + before/
after `/codemie-usage` comparison rather than assuming — the bucket-attribution
and latency behaviors are confirmed facts, not guesses.

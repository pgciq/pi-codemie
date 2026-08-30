# pi-codemie

Pi extension for [CodeMie (AI/Run)](https://github.com/codemie-ai/codemie-code) enterprise gateway.

- **Dynamic model discovery** via `{base}/v1/llm_models` — all CodeMie-deployed models are automatically available.
- **OAuth SSO login** — browser-based SSO flow (EPAM OAuth 2 Proxy), no env vars needed for interactive use.
- **CI-friendly** — env var auth (`CODEMIE_JWT_TOKEN`, `CODEMIE_API_KEY`, `CODEMIE_COOKIE`) for service accounts.
- **Protocol routing** — non-Claude models use OpenAI Chat Completions (`/v1`), Claude models use native Anthropic Messages (preserving thinking/caching).

## Install

### From npm (recommended)
```bash
pi install npm:pi-codemie
```

[![npm](https://img.shields.io/npm/v/pi-codemie.svg)](https://www.npmjs.com/package/pi-codemie)

### From git
```bash
pi install git:github.com/pgciq/pi-codemie
```

### Local path
```bash
pi install /path/to/pi-codemie
```

## Configuration

### Environment variables

| Variable | Description |
|---|---|
| `CODEMIE_BASE_URL` | CodeMie instance URL. **Default:** `https://codemie.lab.epam.com`. Auto-normalizes to include `/code-assistant-api`. |
| `CODEMIE_JWT_TOKEN` | JWT bearer token (CI mode). |
| `CODEMIE_API_KEY` | API key bearer token (CI mode). |
| `CODEMIE_COOKIE` | Raw session cookie (CI mode). |
| `CODEMIE_MODEL` | Static fallback model ID when live model discovery fails. |
| `CODEMIE_FORCE_NO_PROJECT` | **Debug only.** Set to `1` to make `codemie-cli` omit the `X-CodeMie-Project` header, reproducing the "missing `X-CodeMie-Project`" request shape on demand (no failed `/v1/user` lookup needed). Note the billing outcome is backend/time-dependent (see below); off by default. |

### Two billing channels, same account: `codemie` vs `codemie-cli`

CodeMie's backend splits each account's spend across multiple LiteLLM budget
buckets. `/codemie-usage` typically shows something like:

```
| Project                     | Spent  | Budget Limit | ... |
| you@example.com (cli)       | $0.06  | $150.00      | ... |   ← "CLI" bucket, usually idle/underused
| you@example.com              | $14.92 | $120.00      | ... |   ← "Web/Platform" bucket
| you@example.com (premium)   | $0.13  | $30.00       | ... |   ← premium-model bucket
```

**Confirmed mechanism** (4 isolated test configurations on 2026-08-27, author's other
machine, each verified with a before/after `/codemie-usage` comparison across
several real requests):

1. Sending only `X-CodeMie-Client`/`X-CodeMie-CLI` on top of the plain
   OAuth-SSO cookie session — **no effect**, spend stayed in the plain
   Web/Platform bucket.
2. Routing through codemie-code's own local proxy daemon (`codemie proxy
   start`, which re-authenticates upstream with that same SSO session but
   injects its full header set) — **worked**, shifted spend into "(cli)".
3. Direct-to-gateway (no local proxy) with that same full header set copied
   exactly — **worked** identically to (2).
4. Same as (3) minus `X-CodeMie-Project` — **no effect** again on 2026-08-27, where that spend became orphaned (see below).

The deciding header is **`X-CodeMie-Project`** (the account's email/username,
tied to which LiteLLM budget row a request is charged against), together with
`X-CodeMie-Session-ID`/`X-CodeMie-Request-ID` needing to be **validly
formatted UUIDs** (they do not need to be unique per request — reusing the
same two UUIDs across multiple requests still worked). No JWT, no separate
account, no second login required — it's the exact same OAuth-SSO cookie
session `codemie` uses, just with `codemie-cli` adding:

```
X-CodeMie-Client:     codemie-pi
X-CodeMie-CLI:        codemie-cli/1.0.0
X-CodeMie-Project:    <resolved from GET {apiUrl}/v1/user — username/email>
X-CodeMie-Session-ID: <a UUID, generated once per pi process>
X-CodeMie-Request-ID: <a UUID, generated once per pi process>
```

`codemie-cli` resolves `X-CodeMie-Project` automatically at startup (same
credentials as `codemie`, no extra config needed):

```bash
pi --model codemie/gpt-5.1-codex "..."      # billed to the plain Web/Platform bucket
pi --model codemie-cli/gpt-5.1-codex "..."  # billed to the "(cli)" bucket — same account
```

If the `/v1/user` lookup fails at startup (offline, stale session, etc.),
`codemie-cli` still registers without `X-CodeMie-Project` — check the startup
log for a `[codemie-cli] Could not resolve account project` warning. What that
means for billing is **backend/time-dependent** — orphaned on some setups, plain/
premium by model class on others (see below, confirmed 2026-08-27 & 2026-08-30).

#### What happens without `X-CodeMie-Project`: backend/time-dependent, never free

Omitting `X-CodeMie-Project` (deliberately, or via the startup-lookup-failure
path above) does **not** make requests free — spend is always real and always
counted in the account-wide `GET /v1/analytics/summaries` totals (the numbers
behind the
[analytics dashboard](https://codemie.lab.epam.com/analytics?tab=insights)'s
"Summary Metrics" → "Total Money Spent" card). Whether it also lands in a
`budget_usage` row is **backend/time-dependent** (pgciq is the author's
username, not a CodeMie account — login is always gary_pan, on every machine):

- **2026-08-27 (author's other machine, gary_pan login):**
  the spend stays out of every `budget_usage` row (orphaned). Verified with a
  before/after comparison across 4 real requests, same session, headers
  identical except for the missing `X-CodeMie-Project`:

  | Source | Before | After 4 requests | Moved? |
  |---|---|---|---|
  | `budget_usage` — plain row | $14.97 | $14.97 | no |
  | `budget_usage` — "(cli)" row | $0.27 | $0.27 | no |
  | `budget_usage` — "(premium)" row | $0.13 | $0.13 | no |
  | `summaries.total_money_spent` | $27.89 | $27.91 | **yes, +$0.02** |
  | `summaries.cli_cost` | $0.27 | $0.29 | **yes, +$0.02 (matches total exactly)** |
  | `summaries.cli_invoked` | 910 | 914 | **yes, +4 (exactly our request count)** |

- **2026-08-30 (this machine, gary_pan login) — full live matrix.** Every
  request shape below was sent for real against the gateway and the resulting
  `budget_usage` row verified (before/after, ~10 min lag). The rule on this
  backend: **CLI header + model class decide the bucket; `X-CodeMie-Project`
  is ignored.**

  | # | `X-CodeMie-CLI` | `X-CodeMie-Project` | model class | lands in | verified |
  |---|---|---|---|---|---|
  | 1 | no | no | non-premium (`gemini-3.1-pro`) | plain Web/Platform | ✅ live, +$0.03 |
  | 2 | no | no | premium (`o1`) | (premium) | ⚠️ inferred (same rule as #4) |
  | 3 | yes | yes | non-premium | (cli) | ✅ live (4-config test, 2026-08-27) |
  | 4 | yes | yes | premium | (premium) | ⚠️ inferred (README: "premium from either channel") |
  | 5 | yes | no | premium (`o1`) | (premium) | ✅ live, +$0.09 |
  | 6 | yes | no | non-premium (`gemini-3.1-pro`) | (cli) | ✅ live, +$0.05 |
  | 7 | yes | `nonexistent@epam.com` | non-premium | (cli) | ✅ live (bogus project still attributed) |
  | 8 | no | `nonexistent@epam.com` | non-premium | plain | ✅ live |
  | 9 | yes | no (UUIDs omitted) | non-premium | (cli) | ✅ live (missing UUIDs still attributed) |

  Takeaways: a missing `X-CodeMie-Project` (or even a bogus one) does **not**
  orphan spend on this backend — it's attributed by CLI header + model class.
  `cli_cost` only moves when `X-CodeMie-CLI` is present. `CODEMIE_FORCE_NO_PROJECT=1`
  reproduces the *shape* for testing but yields no visible "Orphaned spend" row here.

Either way, spend that no `budget_usage` row accounts for is invisible to the
budget table alone, which is exactly why `/codemie-usage` also calls
`cli-summary` and `summaries` (see below): as a cross-check that can surface
this kind of unattributed spend.

**Does an enforced $ cap still apply to this unattributed spend?** Unconfirmed
by design — answering that for certain would require deliberately exhausting
a real budget to observe the error response, which felt too risky to test
against a live account. What we know: LiteLLM (which CodeMie's gateway is
built on) enforces per-request budget checks against whichever `customer_id`/
`team_id` a request resolves to; where a header-less request resolves to no
customer object (or a different, unmanaged one), which would
mean it's checked against the parent API key's budget instead of any of your
three personal buckets — that key's budget, if any, is not something this
extension has visibility into. Treat this as an open question, not a
confirmed bypass: **don't rely on omitting `X-CodeMie-Project` as a way to get
around the "(cli)"/plain/premium budget limits** — it's undocumented
behavior on CodeMie's backend that could be tightened at any time, and
`codemie-cli` only ever omits it by accident (a failed `/v1/user` lookup), not
by design.

#### Faster verification: the analytics insights endpoints

`/codemie-usage` (`/v1/analytics/budget_usage`) lags real spend by roughly
5-10 minutes, which makes it slow for confirming `codemie-cli` is actually
billing the "(cli)" bucket after a config change. The
[CodeMie analytics dashboard](https://codemie.lab.epam.com/analytics?tab=insights)
is backed by a different, much faster set of endpoints (confirmed by timing:
a token-count bump showed up within ~20-30 seconds of a real request, vs.
minutes for `budget_usage`).

**`/codemie-usage` fetches this automatically** — alongside the budget table,
it shows a "CLI channel (fast, near real-time)" section from
`GET /v1/analytics/cli-summary` (`cli_cost`/`total_tokens`/`unique_sessions`
for CLI-proxy traffic specifically, i.e. requests carrying `X-CodeMie-Client`
like `codemie-cli`'s — it won't move for plain `codemie` usage) plus a direct
link to the full dashboard. If that fetch fails (network hiccup, etc.),
`/codemie-usage` still shows the budget table and just the dashboard link.

This is also the practical reason this section exists at all: it's the
only place `/codemie-usage` can surface **orphaned spend** — spend counted in
the account-wide `summaries`/`cli-summary` totals that no `budget_usage` row
shows (see above, backend/time-dependent). `summaries`/`cli-summary`'s totals still
catch that spend even when the per-project budget table can't attribute it.

For a deeper per-client breakdown than the command surfaces, query the
endpoints directly with the same session cookie `codemie-cli` uses:

```bash
# Per X-CodeMie-Client value (confirms codemie-pi is what's being counted)
curl -s "https://codemie.lab.epam.com/code-assistant-api/v1/analytics/cli-agents?time_period=last_24_hours" \
  -H "Cookie: <your _oauth2_proxy session cookie>"
# → { "data": { "rows": [{ "client_name": "codemie-pi", "total_usage": N }] } }
```

`cli-insights-user-detail?user_name=<your email>` includes a
`repository_classifications[]` array with a `client` field and its own
per-client session/cost — useful to see `codemie-pi` broken out from other
CLI clients (Claude Code, Codex, ...) hitting the same account. Small/cheap
requests may not move `cli_cost` by a visible cent even though `total_tokens`
already reflects them — token count is the more sensitive signal for quick
sanity checks.

### OAuth SSO login (recommended)

No browser pop-up at startup. Login happens on first use or via `/login codemie`.
When logging in you are prompted for the CodeMie instance URL — press **Enter**
to accept the default (`https://codemie.lab.epam.com`) or type another URL:

```bash
# Open browser for SSO login
/login codemie

# Use a CodeMie model — auto-triggers login if needed
pi --model codemie/gpt-5.1-codex "hello"
```

Credentials persist in `~/.pi/agent/auth.json`. Expired sessions are refreshed automatically.

## Model discovery (non-blocking)

`pi-codemie` registers a **seed** model list synchronously at load (so pi starts instantly) and discovers the full deployed catalog **in the background** after startup — it never blocks on `GET {apiUrl}/v1/llm_models` or the `/v1/user` project lookup.

- The seed list is always available immediately, even with no credentials or offline.
- Background discovery fetches the live `llm_models` catalog and resolves the billing project (`X-CodeMie-Project`) from `/v1/user`; both calls are bounded by an 8s timeout and fall back to the seed list on any failure.
- The discovered catalog is cached to `~/.pi/cache/codemie-models.json` (24h TTL, keyed by API URL) so subsequent starts work offline; a stale/missing cache falls back to the seed list.
- Both `codemie` and `codemie-cli` providers are hot-re-registered with the discovered catalog (same credentials, different billing-channel headers).

## Per-model capabilities (vision / image / tools / reasoning)

Each model is registered with capabilities read from CodeMie's real `GET /v1/llm_models` schema (confirmed against the official `codemie-code` client and a live probe):

- `vision` ← `multimodal` (image **input**). Most chat deployments report `multimodal: true`.
- `image` (generation) ← `supports_image_generation` (a **few** models only; the rest are `false`).
- `tools` ← `features.tools` (function/tool calling). `features` is an **object** (`{ tools, streaming, parallel_tool_calls, … }`), not an array.
- `reasoning` ← derived from the model id (claude / gpt-5 / o1 / deepseek / kimi / …).
- `video` / `audio` ← **not exposed by CodeMie's schema**, so they always stay `false`.

`/codemie-capabilities` shows these per deployment. Image generation is performed through the standard chat/completions endpoint with an image-capable model (e.g. `gemini-3.1-flash-image`): the model returns generated image(s) inline in `message.images[]` (verified live — a real base64 PNG came back). There is **no separate `/images/generations` endpoint** on CodeMie — every such path 404s, and `GET /v1/llm_models/image_generation` only *lists* which models support it. The extension uses a custom stream for image-capable models, saves each image under `~/.pi/cache/codemie-generated-images/`, reports the saved path as a clickable `file://` link in the TUI, and adds a TUI-only `Image` entry so supported terminals can display it inline. Print/RPC mode reports the saved path as plain text. Normal chat models continue using pi's built-in OpenAI adapter.

## Usage

```bash
# OpenAI-compatible models (non-Claude)
pi --model codemie/gpt-5.1-codex "你好"
pi --model codemie/gemini-3-pro "你好"

# Claude models (native Anthropic Messages)
pi --model codemie/claude-sonnet-4-6 "你好"
pi --model codemie/claude-opus-4-6 "你好"
```

## Commands

| Command | Description |
|---|---|
| `/codemie-prices [input\|output\|total\|context] [asc\|desc]` | List CodeMie models (same catalog for both `codemie` and `codemie-cli`) with per-million-token input/output/cache-read/cache-write pricing, sorted by price (default: total cost ascending) or context window. |
| `/codemie-capabilities [image\|video\|audio\|vision\|reasoning\|tools]` | List each CodeMie deployment's capabilities (vision via `multimodal`, image generation via `supports_image_generation`, tools via `features.tools`, reasoning via model id; video/audio are not exposed by CodeMie so always `—`); an optional filter narrows the table to deployments that support that capability. |
| `/codemie-usage` | Show current CodeMie account budget/quota usage — all billing channels/rows (`GET {apiUrl}/v1/analytics/budget_usage`), plus a fast near-real-time CLI-channel summary (`GET {apiUrl}/v1/analytics/cli-summary`) and a link to the [full insights dashboard](https://codemie.lab.epam.com/analytics?tab=insights). It also lists **orphaned spend** — real money counted in the account-wide total (`GET {apiUrl}/v1/analytics/summaries` `total_money_spent`) but absent from every `budget_usage` row (backend/time-dependent: missing `X-CodeMie-Project` orphaned it on 2026-08-27, while on 2026-08-30 the gateway attributed by CLI header + model class; also possible for unmapped model classes or requests resolving to no customer). The `summaries` query is aligned to the current billing period (`time_period=current_month`, with fallback to the default window). |

The footer/status bar shows a compact live indicator per billing channel, refreshed every 10 minutes: `💰 $spent/$limit (pct%)` while a `codemie/*` model is active (sums every row except "(cli)"), and `🖥️ $spent/$limit (pct%)` while a `codemie-cli/*` model is active (sums only the "(cli)" row). Both read the same account's `budget_usage` response — they just report different buckets. Note: `budget_usage` lags real spend by roughly 5-10 minutes (confirmed by timing real requests against repeated polls), so the indicator is not second-by-second live.

Each indicator only shows while a model from its own provider is active — switching to the other provider (via `/model`, `Ctrl+P` cycling, or session restore) swaps which one is shown, since the budget it reports is only relevant to the currently active billing channel.

```bash
/codemie-prices                # cheapest (input+output) first
/codemie-prices output desc    # most expensive output price first
/codemie-prices context desc   # largest context window first
/codemie-capabilities image   # only image-generation deployments

/codemie-usage                 # current account budget/quota usage, all channels
```

## Provider

Registers two providers, backed by the same credentials/session:

| Provider ID | Description |
|---|---|
| `codemie` | All CodeMie-deployed models, using your own OAuth-SSO session (or `CODEMIE_*` env vars). Billed to the Web/Platform bucket. Non-Claude via OpenAI Chat Completions (`/v1`), Claude via native Anthropic Messages (`/v1/messages`). |
| `codemie-cli` | Identical models/routing/credentials to `codemie`. Adds `X-CodeMie-Client`/`X-CodeMie-CLI`/`X-CodeMie-Project` (+ UUID Session-ID/Request-ID) headers — confirmed to bill usage to the "(cli)" bucket instead. See [Two billing channels, same account](#two-billing-channels-same-account-codemie-vs-codemie-cli). |

## Development

This package is published to npm via **GitHub Actions + npm Trusted Publishing (OIDC)** — no long-lived npm tokens are stored anywhere. Publishing is triggered by pushing a version tag:

```bash
npm version patch   # or minor / major
git push && git push --tags
```

The workflow (`.github/workflows/publish.yml`) builds and publishes automatically once the tag lands, using npm's trusted publisher configured for `pgciq/pi-codemie`.

## License

MIT

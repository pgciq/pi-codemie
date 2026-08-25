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
| `/codemie-prices [input\|output\|total\|context] [asc\|desc]` | List CodeMie models with per-million-token input/output/cache-read/cache-write pricing, sorted by price (default: total cost ascending) or context window. |
| `/codemie-usage` | Show current CodeMie account budget/quota usage (`GET {apiUrl}/v1/analytics/budget_usage`). |

The footer/status bar also shows a compact live indicator (`💰 $spent/$limit (pct%)`), refreshed every 10 minutes. It sums the buckets pi's own requests actually charge (the plain account + `(premium)`); the `(cli)` bucket is excluded since it has been observed to always stay at $0 for pi/CodeMie-SSO usage. Note: `budget_usage` lags real spend by roughly 5-10 minutes (confirmed by timing real requests against repeated polls), so the indicator is not second-by-second live.

The indicator only shows while a `codemie/*` model is the active model — switching to another provider (via `/model`, `Ctrl+P` cycling, or session restore) hides it immediately, since the budget it reports is irrelevant to a non-CodeMie model. Switching back to a `codemie/*` model brings it back.

```bash
/codemie-prices                # cheapest (input+output) first
/codemie-prices output desc    # most expensive output price first
/codemie-prices context desc   # largest context window first

/codemie-usage                 # current account budget/quota usage
```

## Provider

Registers a single provider:

| Provider ID | Description |
|---|---|
| `codemie` | All CodeMie-deployed models. Non-Claude via OpenAI Chat Completions (`/v1`), Claude via native Anthropic Messages (`/v1/messages`). |

## Development

This package is published to npm via **GitHub Actions + npm Trusted Publishing (OIDC)** — no long-lived npm tokens are stored anywhere. Publishing is triggered by pushing a version tag:

```bash
npm version patch   # or minor / major
git push && git push --tags
```

The workflow (`.github/workflows/publish.yml`) builds and publishes automatically once the tag lands, using npm's trusted publisher configured for `pgciq/pi-codemie`.

## License

MIT

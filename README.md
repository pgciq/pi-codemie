# pi-codemie

Pi extension for [CodeMie (AI/Run)](https://github.com/codemie-ai/codemie-code) enterprise gateway.

- **Dynamic model discovery** via `{base}/v1/llm_models` — all CodeMie-deployed models are automatically available.
- **OAuth SSO login** — browser-based SSO flow (EPAM OAuth 2 Proxy), no env vars needed for interactive use.
- **CI-friendly** — env var auth (`CODEMIE_JWT_TOKEN`, `CODEMIE_API_KEY`, `CODEMIE_COOKIE`) for service accounts.
- **Protocol routing** — non-Claude models use OpenAI Chat Completions (`/v1`), Claude models use native Anthropic Messages (preserving thinking/caching).

## Install

### From npm (after publish)
```bash
pi install npm:pi-codemie
```

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
| `CODEMIE_BASE_URL` | CodeMie instance URL (e.g. `https://codemie.lab.epam.com`). Auto-normalizes to include `/code-assistant-api`. |
| `CODEMIE_JWT_TOKEN` | JWT bearer token (CI mode). |
| `CODEMIE_API_KEY` | API key bearer token (CI mode). |
| `CODEMIE_COOKIE` | Raw session cookie (CI mode). |
| `CODEMIE_MODEL` | Static fallback model ID when live model discovery fails. |

### OAuth SSO login (recommended)

No browser pop-up at startup. Login happens on first use or via `/login codemie`:

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

## Provider

Registers a single provider:

| Provider ID | Description |
|---|---|
| `codemie` | All CodeMie-deployed models. Non-Claude via OpenAI Chat Completions (`/v1`), Claude via native Anthropic Messages (`/v1/messages`). |

## License

MIT

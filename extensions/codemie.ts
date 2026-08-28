// CodeMie (AI/Run) provider — https://github.com/codemie-ai/codemie-code
//
// Auth modes (checked in order):
//   1. Env vars  – CODEMIE_JWT_TOKEN / CODEMIE_API_KEY (Bearer) or CODEMIE_COOKIE (raw Cookie)
//                  plus optional CODEMIE_BASE_URL override. For CI/service accounts.
//   2. OAuth SSO – Browser-based login, exactly like CodeMie's own CLI:
//                  opens {base}/v1/auth/login/{port}, local server catches the callback,
//                  decodes the base64 token (cookies incl. codemie_access_token JWT),
//                  resolves the real API URL from /config.js.
//                  Credentials persist in ~/.pi/agent/auth.json. Startup never
//                  opens a browser — login happens via /login codemie, or
//                  automatically when an actual CodeMie request needs a refresh.
//   CODEMIE_MODEL – static fallback model id when live model discovery fails.
//
// Billing channel (same account, same session — NOT a second account):
//   CodeMie's backend attributes spend to one of several LiteLLM buckets per
//   user (see `/codemie-usage`: a plain "Web/Platform" row, a "(cli)" row,
//   a "(premium)" row). CONFIRMED by measurement (4 isolated test configs,
//   before/after budget_usage comparisons — see README "Two billing
//   channels"): the header that actually decides bucket attribution is
//   `X-CodeMie-Project` (the account's email/username), PLUS
//   `X-CodeMie-Session-ID`/`X-CodeMie-Request-ID` needing to be *validly
//   formatted UUIDs* (not necessarily unique per request). Sending only
//   `X-CodeMie-Client`/`X-CodeMie-CLI` (no Project, or malformed UUIDs) does
//   nothing — confirmed twice. Sending the full set including a correct
//   `X-CodeMie-Project` reliably shifts spend into the "(cli)" bucket — also
//   confirmed twice, on the SAME SSO-cookie session `codemie` uses, no JWT
//   or second account required. This mirrors codemie-code's own
//   HeaderInjectionPlugin, which sends this exact header set on every
//   request its local proxy forwards.
//
// Registers two providers, both backed by the same credentials:
//   codemie      – all models, billed to the plain Web/Platform bucket.
//                  Non-Claude via OpenAI Chat Completions ({apiUrl}/v1),
//                  Claude via native Anthropic Messages ({apiUrl}/v1/messages).
//   codemie-cli  – identical models/routing/credentials, billed to the "(cli)"
//                  bucket via X-CodeMie-Client/X-CodeMie-CLI/X-CodeMie-Project
//                  (+ valid-UUID Session-ID/Request-ID) headers.
//
// Orphaned spend if X-CodeMie-Project is missing/unresolvable (e.g. the
// /v1/user lookup fails at startup): CONFIRMED that such requests still
// spend real money — they increment the account-wide
// `GET /v1/analytics/summaries` totals (`total_money_spent`, `cli_cost`) —
// but do NOT appear in ANY `/v1/analytics/budget_usage` row (not plain, not
// "(cli)", not "(premium)"). This is why `/codemie-usage` also queries the
// faster `cli-summary` endpoint: as a cross-check for spend that budget_usage
// can't attribute to a project. Whether an enforced $ cap still applies to
// this unattributed spend is UNCONFIRMED — deliberately exhausting a budget
// just to observe the error response was judged too risky to test against a
// real account. Do not treat this as a documented/supported way to dodge
// budget limits.

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Image, Markdown } from "@earendil-works/pi-tui";

// Convert an absolute path to a clickable Markdown link. The TUI renders
// `[label](url)` as an OSC 8 hyperlink, so the saved file opens in one click.
function fileLink(p, label = p) {
  return `[${label}](${pathToFileURL(String(p)).href})`;
}
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const COOKIE_FILE = join(homedir(), ".pi", "agent", "codemie-cookie.txt");
// Both provider ids share one OAuth session/credential set (see the
// "Billing channel" note above) — kept in sync in ~/.pi/agent/auth.json.
const PROVIDER_IDS = ["codemie", "codemie-cli"];
const LOGIN_TIMEOUT_MS = 120_000;
// Default CodeMie instance — override with CODEMIE_BASE_URL.
const DEFAULT_CODEMIE_URL = "https://codemie.lab.epam.com";
// Bound every CodeMie discovery/lookup request so a slow or hung endpoint can
// never stall the (now background) model discovery indefinitely.
const CODIEMIE_FETCH_TIMEOUT_MS = 8_000;

// Merge an optional external abort signal with a hard per-call timeout.
const CODIEME_FETCH_TIMEOUT_MS = 8_000;

function withTimeout(signal, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const clear = () => clearTimeout(timer);
  ac.signal.addEventListener("abort", clear, { once: true });
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac.signal;
}

// Persisted model-discovery cache so an offline/flaky start still registers the
// last-known-good catalog (not just the hardcoded seed list). Keyed by API base
// URL because CodeMie models are instance-specific (CODEMIE_BASE_URL / stored
// SSO session).
const CACHE_DIR = join(homedir(), ".pi", "cache");
const CACHE_FILE = join(CACHE_DIR, "codemie-models.json");
const GENERATED_IMAGE_DIR = join(CACHE_DIR, "codemie-generated-images");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function loadCache(apiUrl) {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    const entry = data?.urls?.[apiUrl];
    if (!entry || typeof entry.timestamp !== "number") return null;
    if (Date.now() - entry.timestamp > CACHE_TTL) return null;
    return entry; // { models, cliProject }
  } catch {
    return null;
  }
}

function saveCache(apiUrl, models, cliProject) {
  try {
    let data = {};
    if (existsSync(CACHE_FILE)) {
      try { data = JSON.parse(readFileSync(CACHE_FILE, "utf-8")); } catch { /* ignore */ }
    }
    data.urls = data.urls ?? {};
    data.urls[apiUrl] = { timestamp: Date.now(), models, cliProject };
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch {
    // best-effort; the cache is an optimization, never required
  }
}

/**
 * Normalize a CodeMie URL to the API base, exactly like codemie-code's
 * `ensureApiBase` (src/providers/core/codemie-auth-helpers.ts): all backend
 * routes live under /code-assistant-api, so "https://host" becomes
 * "https://host/code-assistant-api".
 */
function ensureApiBase(rawUrl) {
  const base = rawUrl.replace(/\/+$/, "");
  return /\/code-assistant-api(\/|$)/i.test(base)
    ? base
    : `${base}/code-assistant-api`;
}

/** Inverse of ensureApiBase: recover the frontend URL from an API base. */
function frontendFromApiBase(apiBase) {
  return apiBase.replace(/\/+$/, "").replace(/\/code-assistant-api\/?$/i, "");
}

// ---------------------------------------------------------------------------
// Model metadata (mirrors codemie-code's src/agents/plugins/pi/pi.models.ts)
// ---------------------------------------------------------------------------

const RESPONSES_API_PATTERNS = [
  /^gpt-5-2-/,
  /^gpt-5\.2-/,
  /^gpt-5-1-codex/,
  /^gpt-5\.1-codex/,
  /^gpt-5-3-codex/,
  /^gpt-5\.3-codex/,
  /^gpt-5-4-/,
  /^gpt-5\.4-/,
  /^gpt-5-5-/,
  /^gpt-5\.5-/,
  /^gpt-5-6-/,
  /^gpt-5\.6-/,
];

function detectLimits(id) {
  if (id.startsWith("claude")) return { contextWindow: 200000, maxTokens: 64000 };
  if (id.startsWith("gemini")) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith("gpt-4.1")) return { contextWindow: 1048576, maxTokens: 32768 };
  if (/^gpt-5\.[56]-/.test(id) || /^gpt-5-[56]-/.test(id)) return { contextWindow: 1050000, maxTokens: 128000 };
  if (id.startsWith("gpt-5")) return { contextWindow: 400000, maxTokens: 128000 };
  if (/^o[134]-/.test(id) || id === "o1") return { contextWindow: 200000, maxTokens: 100000 };
  if (id.startsWith("qwen") || id.startsWith("moonshotai") || id.startsWith("kimi")) {
    return { contextWindow: 262144, maxTokens: 131072 };
  }
  if (id.startsWith("deepseek")) return { contextWindow: 65536, maxTokens: 65536 };
  return { contextWindow: 128000, maxTokens: 4096 };
}

function isReasoningModel(id) {
  return (
    id.startsWith("claude") ||
    id.startsWith("gemini") ||
    id.startsWith("gpt-5") ||
    /^o[134]-/.test(id) ||
    id === "o1" ||
    id.startsWith("deepseek") ||
    id.startsWith("moonshotai") ||
    id.startsWith("kimi")
  );
}

function isValidRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// CodeMie reports cost per token; Pi expects it per million tokens.
function rate(perToken) {
  if (!isValidRate(perToken)) return 0;
  const perMillion = perToken * 1_000_000;
  return isValidRate(perMillion) ? perMillion : 0;
}

function convertLlmModel(model) {
  const id = model.deployment_name || model.base_name || model.label;

  const entry = {
    id,
    name: model.label || id,
    reasoning: false,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: {
      input: rate(model.cost?.input),
      output: rate(model.cost?.output),
      cacheRead: rate(model.cost?.cache_read_input_token_cost),
      cacheWrite: rate(model.cost?.cache_creation_input_token_cost),
    },
    ...detectLimits(id),
  };

  // Newer GPT-5.x/Codex models speak the Responses API instead of Chat Completions.
  if (RESPONSES_API_PATTERNS.some((pattern) => pattern.test(id))) {
    entry.api = "openai-responses";
  }

  if (isReasoningModel(id)) {
    entry.reasoning = true;
    entry.thinkingLevelMap = {
      off: null,
      // The CodeMie gateway only accepts low/medium/high/xhigh/max — there
      // is no "minimal" variant (400 "unknown variant `minimal`").
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    };
  }

  // Adaptive-thinking Claude models require thinking.type: "adaptive".
  if (
    id.startsWith("claude-sonnet-4-6") ||
    id.startsWith("claude-sonnet-5") ||
    /^claude-opus-4-[6-8]/.test(id) ||
    id.startsWith("claude-opus-5")
  ) {
    entry.compat = { forceAdaptiveThinking: true };
  }

  // Surface the deployment's real capabilities so Pi (and /codemie-capabilities)
  // reflects what CodeMie actually reports. The live `GET /v1/llm_models`
  // schema (confirmed against the official codemie-code client + a live
  // probe of this account) exposes per model:
  //   multimodal                 -> vision (image INPUT)
  //   supports_image_generation  -> image *generation* (a few models only)
  //   features.tools             -> function/tool calling (`features` is an
  //                                 OBJECT, not an array: {tools, streaming,
  //                                 parallel_tool_calls, ...})
  // There is NO video/audio-generation field in CodeMie's schema, so those
  // capability flags stay false. (Image generation is flagged here, but this
  // extension does not yet route generation requests to a CodeMie image
  // endpoint — that endpoint is not yet verified.)
  const cmFeatures = model.features ?? {};
  entry.capabilities = {
    tools: cmFeatures.tools === true,
    vision: !!model.multimodal,
    image: model.supports_image_generation === true,
    video: false,
    audio: false,
    reasoning: entry.reasoning,
  };

  return entry;
}

// ---------------------------------------------------------------------------
// SSO login flow (mirrors codemie-code's src/providers/plugins/sso/sso.auth.ts)
// ---------------------------------------------------------------------------

function decodeJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, args, () => {});
  } catch {
    // Browser launch is best-effort; the URL is printed either way.
  }
}

/**
 * Start a local callback server, hand the login URL to `onAuth`, and resolve
 * with the decoded `{ cookies }` payload once the browser calls back.
 */
function waitForSsoCallback(codeMieUrl, onAuth) {
  return new Promise((resolve, reject) => {
    let timeoutHandle;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      server.close();
      fn(value);
    };
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const raw =
          url.searchParams.get("token") ||
          url.searchParams.get("auth") ||
          url.searchParams.get("data");
        if (!raw) throw new Error("Missing token parameter in OAuth callback");

        const token = JSON.parse(Buffer.from(raw, "base64").toString("ascii"));
        if (!token.cookies) throw new Error("Token missing cookies field");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>CodeMie</title></head>" +
            "<body style='font-family:sans-serif;text-align:center;padding:50px'>" +
            "<h2 style='color:#28a745'>&#9989; Authentication Successful</h2>" +
            "<p>Authentication complete. You can close this tab.</p></body></html>"
        );
        finish(resolve, token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`CodeMie authentication failed: ${message}`);
        finish(reject, error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const loginUrl = `${codeMieUrl.replace(/\/+$/, "")}/v1/auth/login/${port}`;
      console.error(`[codemie] Opening browser for SSO login...\n  ${loginUrl}`);
      if (onAuth) onAuth({ url: loginUrl });
      else openBrowser(loginUrl);
    });

    timeoutHandle = setTimeout(() => {
      finish(reject, new Error(`SSO login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);
  });
}

/** Resolve the real API base URL from /config.js (VITE_API_URL), like the CLI does. */
async function resolveApiUrl(codeMieUrl, cookieString) {
  const apiBase = codeMieUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${apiBase}/config.js`, {
      headers: cookieString ? { Cookie: cookieString } : {},
      redirect: "follow",
    });
    if (res.ok) {
      const match = /VITE_API_URL:\s*"([^"]+)"/.exec(await res.text());
      if (match?.[1]) return match[1].replace(/\/+$/, "");
    }
  } catch {
    // Optional step — fall back to the configured base URL.
  }
  return apiBase;
}

/** Full interactive SSO login → pi OAuthCredentials-shaped object. */
async function performLogin(codeMieUrl, onAuth) {
  const { cookies } = await waitForSsoCallback(codeMieUrl, onAuth);
  const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
  const access =
    cookies.codemie_access_token ?? cookieString;
  const expires =
    typeof cookies.codemie_access_token === "string"
      ? decodeJwtExp(cookies.codemie_access_token) ?? Date.now() + 24 * 60 * 60 * 1000
      : Date.now() + 24 * 60 * 60 * 1000;
  const apiUrl = await resolveApiUrl(codeMieUrl, cookieString);

  return {
    // `refresh` carries everything needed to rebuild the session later.
    refresh: JSON.stringify({ cookies, apiUrl }),
    access,
    expires,
    apiUrl,
  };
}

// ---------------------------------------------------------------------------
// Credential storage (same file pi uses: ~/.pi/agent/auth.json)
// ---------------------------------------------------------------------------

function readStoredOauth() {
  try {
    if (!existsSync(AUTH_FILE)) return undefined;
    const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    for (const id of PROVIDER_IDS) {
      const cred = parsed[id];
      if (cred?.type === "oauth" && cred.access) {
        let apiUrl = undefined;
        try {
          apiUrl = JSON.parse(cred.refresh ?? "{}")?.apiUrl;
        } catch {}
        return { ...cred, apiUrl };
      }
    }
  } catch {
    // Corrupted/unreadable auth file — treat as no stored credentials.
  }
  return undefined;
}

function writeStoredOauth(credential) {
  try {
    const existing = existsSync(AUTH_FILE)
      ? JSON.parse(readFileSync(AUTH_FILE, "utf8"))
      : {};
    for (const id of PROVIDER_IDS) {
      existing[id] = {
        type: "oauth",
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
      };
    }
    writeFileSync(AUTH_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
    chmodSync(AUTH_FILE, 0o600);
  } catch (error) {
    console.error(
      `[codemie] Could not persist credentials to ${AUTH_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function isExpired(credential) {
  // Refresh 5 minutes early to avoid mid-session failures.
  return !credential?.expires || Date.now() >= credential.expires - 5 * 60 * 1000;
}

function cookieStringFromCredential(credential) {
  try {
    const cookies = JSON.parse(credential.refresh ?? "{}")?.cookies ?? {};
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join(";");
  } catch {
    return "";
  }
}

/**
 * Persist the OAuth credentials AND export the raw session cookie.
 * The gateway authenticates API calls with the _oauth2_proxy session cookie —
 * a Bearer JWT is rejected (302 to the SSO login page). We expose it to pi's
 * provider config via an environment variable (`Cookie: $CODEMIE_SESSION_COOKIE`):
 * unlike `!command` values, this needs no shell, which matters on Windows where
 * neither `cat` nor cmd built-ins like `type` are reliably spawnable.
 */
function persistSession(credential) {
  writeStoredOauth(credential);
  try {
    const cookieString = cookieStringFromCredential(credential);
    process.env.CODEMIE_SESSION_COOKIE = cookieString;
    writeFileSync(COOKIE_FILE, cookieString, { mode: 0o600 });
    chmodSync(COOKIE_FILE, 0o600);
  } catch (error) {
    console.error(
      `[codemie] Could not write cookie file ${COOKIE_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

async function fetchCodeMieModels(apiUrl, { bearer, cookieString }) {
  const headers = {};
  if (cookieString) headers["Cookie"] = cookieString;
  else if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/llm_models?include_all=true`, {
    headers,
    redirect: "follow",
    signal: withTimeout(undefined, CODIEME_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const models = await res.json();
  if (!Array.isArray(models)) {
    throw new Error("unexpected response shape (expected array)");
  }
  return models
    .filter((m) => m && m.enabled !== false)
    .map(convertLlmModel)
    .filter((m) => m && m.id);
}

/**
 * Resolve the CodeMie project id for the `X-CodeMie-Project` header (see the
 * "Billing channel" note above — this is the header that actually decides
 * bucket attribution). Mirrors codemie-code's `fetchCodeMieUserInfo`
 * (`GET {apiUrl}/v1/user`): `username`/`email` is the account's email, which
 * is also the LiteLLM project name (`<email>`, `<email> (cli)`, ...).
 */
async function fetchCodeMieProject(apiUrl, { bearer, cookieString }) {
  const headers = {};
  if (cookieString) headers["Cookie"] = cookieString;
  else if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/user`, {
    headers,
    redirect: "follow",
    signal: withTimeout(undefined, CODIEME_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const user = await res.json();
  const project = user?.username || user?.email;
  if (!project) {
    throw new Error("user info response missing username/email");
  }
  return project;
}

/**
 * Claude models are flagged to speak the Anthropic Messages protocol at the
 * API root (preserving native thinking/caching), everything else uses
 * OpenAI Chat Completions under /v1. Shared by both the `codemie` and
 * `codemie-cli` providers.
 */
function routeModels(entries, apiUrl) {
  return entries.map((entry) => {
    if (!entry.id.startsWith("claude")) {
      return { ...entry, compat: { ...entry.compat, supportsReasoningEffort: true } };
    }
    return {
      ...entry,
      api: "anthropic-messages",
      baseUrl: apiUrl, // Anthropic endpoint lives at the API root, not /v1
    };
  });
}

/** Seed model list used when no session/model-discovery is available yet. */
function seedModels() {
  const SEED_MODELS = [
    "gpt-5-mini-2025-08-07",
    "gpt-5.1-codex-2025-11-13",
    "gemini-3-pro",
    "deepseek-v4-pro",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
  ];
  return SEED_MODELS.map((id) => convertLlmModel({ deployment_name: id }));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi) {
  // Accept either https://host or https://host/code-assistant-api — normalize
  // to the API base like the CodeMie CLI does. Defaults to the public EPAM lab
  // instance when CODEMIE_BASE_URL is not set.
  const codeMieUrl = ensureApiBase(
    process.env.CODEMIE_BASE_URL || DEFAULT_CODEMIE_URL
  );

  // ---- Mode 1: explicit env-var auth (CI / service accounts) --------------
  const jwt = process.env.CODEMIE_JWT_TOKEN || "";
  const apiKeyEnv = process.env.CODEMIE_API_KEY || "";
  const cookieEnv = process.env.CODEMIE_COOKIE || "";

  let apiUrl = codeMieUrl;
  let envAuth = null; // { headers } | { apiKey, authHeader? }

  if (codeMieUrl && (jwt || apiKeyEnv || cookieEnv)) {
    envAuth = cookieEnv
      ? { headers: { Cookie: cookieEnv } }
      : { apiKey: jwt || apiKeyEnv };
  }

  // ---- Mode 2: OAuth SSO (login/refresh only run on /login) --------------
  let oauthBlock = null;
  let oauthCreds = null;
  let activeBaseUrl = codeMieUrl;

  if (!envAuth) {
    const makeOauthBlock = () => {
      const resolveBaseUrl = async (callbacks) => {
        if (!process.env.CODEMIE_BASE_URL && callbacks?.onPrompt) {
          try {
            const answer = await callbacks.onPrompt({
              message: `CodeMie URL (Enter = ${DEFAULT_CODEMIE_URL}):`,
            });
            const trimmed = typeof answer === "string" ? answer.trim() : "";
            if (trimmed) return ensureApiBase(trimmed);
          } catch {
            // Prompt unavailable/cancelled — fall back to the default.
          }
        }
        return activeBaseUrl;
      };

      return {
        name: "CodeMie (SSO)",
        async login(callbacks) {
          const baseUrl = await resolveBaseUrl(callbacks);
          activeBaseUrl = baseUrl;
          const cred = await performLogin(baseUrl, (info) =>
            callbacks.onAuth(info)
          );
          persistSession(cred);
          apiUrl = cred.apiUrl;
          oauthCreds = cred;
          return { refresh: cred.refresh, access: cred.access, expires: cred.expires };
        },
        async refreshToken(credentials) {
          if (!isExpired(credentials)) return credentials;
          console.error("[codemie] SSO session expired — reopening browser for login...");
          const cred = await performLogin(activeBaseUrl);
          persistSession(cred);
          apiUrl = cred.apiUrl;
          oauthCreds = cred;
          return { refresh: cred.refresh, access: cred.access, expires: cred.expires };
        },
        getApiKey(credentials) { return credentials.access; },
      };
    };
    oauthBlock = makeOauthBlock();

    // Reuse whatever session is already stored — never open a browser at
    // startup. Login happens only when the user asks for it (`/login codemie`)
    // or when an actual CodeMie request needs a refresh.
    const stored = readStoredOauth();
    if (stored) {
      oauthCreds = stored;
      if (stored.apiUrl) {
        apiUrl = stored.apiUrl;
        // Refreshes after a restart must reopen the browser on the SAME
        // instance the stored session belongs to.
        activeBaseUrl = ensureApiBase(frontendFromApiBase(stored.apiUrl));
      }
      persistSession(stored); // keep the cookie file in sync with auth.json
    }
  }

  const authConfig = envAuth
    ? envAuth
    : oauthBlock
      ? {
          // The gateway authenticates with the _oauth2_proxy session cookie
          // (Bearer JWTs get a 302 to the SSO login). persistSession() keeps
          // this env var in sync on every login/refresh; env interpolation
          // needs no shell, so it works identically on Windows and Unix.
          oauth: oauthBlock,
          headers: { Cookie: "$CODEMIE_SESSION_COOKIE" },
        }
      : undefined;

  // ---- codemie-cli: SAME account/session, different billing channel -------
  // (see README "Two billing channels" for the measurement that pinned down
  // X-CodeMie-Project as the bucket-attribution header.)
  const cliSessionId = randomUUID();
  const cliRequestId = randomUUID();
  const cliChannelHeaders = {
    "X-CodeMie-Client": "codemie-pi",
    "X-CodeMie-CLI": "codemie-cli/1.0.0",
    "X-CodeMie-Session-ID": cliSessionId,
    "X-CodeMie-Request-ID": cliRequestId,
  };

  // --- Image-generation echo -------------------------------------------------
  // CodeMie has no dedicated /images endpoint — image generation rides the
  // standard chat/completions path and the model returns the image inline in
  // `message.images[]` (verified live). pi's built-in OpenAI adapter drops
  // `message.images`, so for image-capable models we use a custom streamSimple
  // that calls chat/completions (non-streaming), saves the images, and adds
  // TUI-only Image entries while exposing the saved paths in the assistant text.
  let resolvedCliProject;

  function baseOutput(model, stopReason) {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
  }

  async function saveGeneratedImage(url) {
    if (!url || typeof url !== "string") return null;
    let mimeType = "image/png";
    let data;
    const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (dataUri) {
      mimeType = dataUri[1] || mimeType;
      data = Buffer.from(dataUri[2], "base64");
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to download CodeMie image: HTTP ${response.status}`);
      const contentType = response.headers.get("content-type");
      if (contentType?.startsWith("image/")) mimeType = contentType.split(";", 1)[0];
      data = Buffer.from(await response.arrayBuffer());
    }
    if (!data?.length) throw new Error("CodeMie returned an empty image");
    if (!existsSync(GENERATED_IMAGE_DIR)) mkdirSync(GENERATED_IMAGE_DIR, { recursive: true });
    const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
    const path = join(GENERATED_IMAGE_DIR, `codemie-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
    writeFileSync(path, data);
    return { path, mimeType };
  }

  function textOf(m) {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) {
      return m.content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n");
    }
    return "";
  }

  function contentParts(m) {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) {
      const parts = [];
      for (const p of m.content) {
        if (p?.type === "text") parts.push({ type: "text", text: p.text ?? "" });
        else if (p?.type === "image") {
          const src = p.source;
          const url = src?.type === "base64" ? `data:${src.mediaType || "image/png"};base64,${src.data}` : src?.url ?? src?.uri;
          if (url) parts.push({ type: "image_url", image_url: { url } });
        }
      }
      return parts;
    }
    if (Array.isArray(m?.images)) {
      const parts = [{ type: "text", text: textOf(m) }];
      for (const img of m.images) {
        const url = typeof img === "string" ? img : img?.url ?? img?.image_url?.url ?? "";
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
      return parts;
    }
    return textOf(m);
  }

  function toOpenAIMessages(context) {
    const out = [];
    const hasSystemPrompt = !!context?.systemPrompt;
    if (hasSystemPrompt) out.push({ role: "system", content: context.systemPrompt });
    const msgs = Array.isArray(context?.messages) ? context.messages : [];
    for (const m of msgs) {
      const role = m?.role;
      if (role === "system") {
        if (!hasSystemPrompt) out.push({ role: "system", content: textOf(m) });
        continue;
      }
      if (role === "user") out.push({ role: "user", content: contentParts(m) });
      else if (role === "assistant") out.push({ role: "assistant", content: textOf(m) });
      else if (role === "tool") out.push({ role: "tool", content: textOf(m), tool_call_id: m?.toolCallId });
    }
    return out;
  }

  function streamCodeMieImage(model, context, options, baseUrl, getHeaders) {
    const stream = createAssistantMessageEventStream();
    const output = baseOutput(model, "pending");
    (async () => {
      try {
        stream.push({ type: "start", partial: output });
        const messages = toOpenAIMessages(context);
        const body = { model: model.id, messages, stream: false };
        if (model?.samplingParams?.temperature != null) body.temperature = model.samplingParams.temperature;
        const headers = { "Content-Type": "application/json", ...getHeaders() };
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!response.ok) {
          const txt = await response.text().catch(() => "");
          throw new Error(`CodeMie image API HTTP ${response.status}: ${txt.slice(0, 400)}`);
        }
        const data = await response.json();
        const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
        const msg = choice?.message ?? {};
        const text = typeof msg.content === "string" ? msg.content : "";
        const images = Array.isArray(msg.images) ? msg.images : [];
        const savedImages = [];
        for (const img of images) {
          const url = img?.image_url?.url ?? img?.url ?? "";
          const saved = await saveGeneratedImage(url);
          if (saved) savedImages.push(saved);
        }
        const imageNotice = savedImages.map((image) => `Generated image saved to: ${fileLink(image.path)}`).join("\n");
        const displayText = [text, imageNotice].filter(Boolean).join(text && imageNotice ? "\n\n" : "");

        if (displayText) {
          output.content.push({ type: "text", text: "" });
          const ci = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: ci, partial: output });
          const block = output.content[ci];
          block.text += displayText;
          stream.push({ type: "text_delta", contentIndex: ci, delta: displayText, partial: output });
          stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
        }
        for (const image of savedImages) {
          pi.appendEntry("codemie-generated-image", image);
        }
        if (savedImages.length === 0 && !text) {
          throw new Error("CodeMie returned neither an image nor text");
        }
        output.stopReason = choice?.finish_reason ?? "stop";
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  }

  function streamCodeMie(model, context, options) {
    if (model?.capabilities?.image) {
      const getHeaders =
        model.provider === "codemie-cli"
          ? () => ({
              ...buildAuthHeaders(),
              ...cliChannelHeaders,
              ...(resolvedCliProject ? { "X-CodeMie-Project": resolvedCliProject } : {}),
            })
          : buildAuthHeaders;
      return streamCodeMieImage(model, context, options, `${apiUrl}/v1`, getHeaders);
    }
    return openAICompletionsApi().streamSimple(model, context, options);
  }

  // Register both providers from a model list (+ optional resolved cli project).
  // Called once now with seed models, and again in the background once live
  // model discovery completes — pi applies post-load registrations immediately,
  // so this hot-swaps the catalog without a /reload.
  function registerProviders(modelEntries, cliProject) {
    const routed = routeModels(modelEntries, apiUrl);
    if (routed.length === 0) return;

    pi.registerProvider("codemie", {
      name: "CodeMie",
      baseUrl: `${apiUrl}/v1`,
      ...authConfig,
      api: "openai-completions",
      streamSimple: streamCodeMie,
      models: routed,
    });

    // Clone (deep enough: top-level model + nested cost/compat/thinkingLevelMap
    // objects) rather than reusing `routed`/nested objects by reference across
    // two registerProvider() calls, in case pi/pi-ai attaches per-registration
    // state (e.g. a resolved `provider` id) onto the model objects it's given.
    const cliModels = routed.map((m) => ({
      ...m,
      cost: { ...m.cost },
      ...(m.compat ? { compat: { ...m.compat } } : {}),
      ...(m.thinkingLevelMap ? { thinkingLevelMap: { ...m.thinkingLevelMap } } : {}),
    }));
    pi.registerProvider("codemie-cli", {
      name: "CodeMie (CLI billing channel)",
      baseUrl: `${apiUrl}/v1`,
      ...authConfig,
      headers: {
        ...(authConfig?.headers ?? {}),
        ...cliChannelHeaders,
        ...(cliProject ? { "X-CodeMie-Project": cliProject } : {}),
      },
      api: "openai-completions",
      streamSimple: streamCodeMie,
      models: cliModels,
    });
  }

  // ---- Register immediately with cached (or seed) models (no network) -------
  const cached = loadCache(apiUrl);
  registerProviders(cached?.models ?? seedModels(), cached?.cliProject);

  /** Headers for ad-hoc authenticated requests (usage/analytics), mirroring
   * whichever auth mode is currently active. Re-read on every call so a
   * post-login cookie refresh (persistSession) is picked up immediately. */
  function buildAuthHeaders() {
    if (envAuth?.headers) return { ...envAuth.headers };
    if (envAuth?.apiKey) return { Authorization: `Bearer ${envAuth.apiKey}` };
    const cookieString = process.env.CODEMIE_SESSION_COOKIE || "";
    if (cookieString) return { Cookie: cookieString };
    return {};
  }

  // ---- Commands & status bar (unchanged) ----------------------------------
  registerPricesCommand(pi);
  registerCapabilitiesCommand(pi);
  pi.registerEntryRenderer("codemie-generated-image", (entry, _options, theme) => {
    const image = entry.data ?? {};
    // pi passes an entry-renderer `theme` that lacks `fallbackColor()`, which
    // `Image.render` calls. Wrap it so inline previews render and never throw.
    const imageTheme = theme && typeof theme.fallbackColor === "function"
      ? theme
      : { fallbackColor: (s) => (theme && theme.fg ? theme.fg("toolOutput", s) : s) };
    try {
      const data = readFileSync(image.path).toString("base64");
      return new Image(data, image.mimeType || "image/png", imageTheme, { maxWidthCells: 80, maxHeightCells: 30 });
    } catch {
      return new Markdown(`Generated image unavailable: ${fileLink(image.path ?? "unknown path")}`, 1, 0, getMarkdownTheme());
    }
  });
  registerUsageCommand(pi, () => apiUrl, () => buildAuthHeaders());
  // Both status widgets read the SAME account's budget_usage response (one
  // account, multiple buckets) — they differ only in which row(s) they sum:
  // "codemie" excludes the "(cli)" row (that's the OTHER provider's spend),
  // "codemie-cli" shows ONLY the "(cli)" row.
  registerUsageStatusBar(pi, "codemie", "codemie-usage-status", "💰", "web", () => apiUrl, () => buildAuthHeaders());
  registerUsageStatusBar(pi, "codemie-cli", "codemie-cli-usage-status", "🖥️", "cli", () => apiUrl, () => buildAuthHeaders());

  // ---- Background model discovery (non-blocking) --------------------------
  // Live discovery + cli project resolution run after startup so pi is usable
  // immediately. Failures are silent — the seed list already registered stays.
  setTimeout(() => backgroundDiscover().catch(() => {}), 100);

  async function backgroundDiscover() {
    let bearer;
    let cookieString = "";
    if (envAuth) {
      bearer = envAuth.apiKey;
      cookieString = envAuth.headers?.Cookie ?? "";
    } else if (oauthCreds) {
      bearer = oauthCreds.access;
      cookieString = cookieStringFromCredential(oauthCreds);
    } else {
      return; // no credentials → keep seed list
    }

    let entries;
    try {
      entries = await fetchCodeMieModels(apiUrl, { bearer, cookieString });
    } catch (error) {
      console.error(
        `[codemie] Live model fetch failed (${
          error instanceof Error ? error.message : String(error)
        }). Keeping seed list.`
      );
      return;
    }
    if (!entries || entries.length === 0) return; // keep seed list

    // Best-effort: resolve the account project for the (cli) billing bucket.
    let cliProject;
    try {
      cliProject = await fetchCodeMieProject(apiUrl, { bearer, cookieString });
    } catch {
      // usage still billed for real but won't show in any /codemie-usage row
      // (see summaries.total_money_spent) — acceptable, just less visible.
    }

    resolvedCliProject = cliProject;
    registerProviders(entries, cliProject);
    saveCache(apiUrl, entries, cliProject);
  }
}

// ---------------------------------------------------------------------------
// /codemie-prices — cost-sortable pricing table for CodeMie models
// ---------------------------------------------------------------------------

const SORT_KEYS = { input: "input", output: "output", total: "total", context: "contextWindow" };

function fmtRate(n) {
  if (!n) return "free";
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

function fmtSize(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function buildPricesMarkdown(models, sortKey, desc) {
  const rows = models
    .map((m) => ({
      id: m.id,
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cacheRead ?? 0,
      cacheWrite: m.cost?.cacheWrite ?? 0,
      total: (m.cost?.input ?? 0) + (m.cost?.output ?? 0),
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
    }))
    .sort((a, b) => (desc ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));

  const lines = [
    `# CodeMie model prices (per 1M tokens, sorted by ${sortKey}${desc ? " desc" : " asc"})`,
    "",
    "| Model | Input | Output | Cache Read | Cache Write | Context | Max Out |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${fmtRate(r.input)} | ${fmtRate(r.output)} | ${fmtRate(r.cacheRead)} | ${fmtRate(
          r.cacheWrite
        )} | ${fmtSize(r.contextWindow)} | ${fmtSize(r.maxTokens)} |`
    ),
  ];
  return lines.join("\n");
}

// `codemie` and `codemie-cli` register the exact same model list (only the
// billing-channel headers differ), so pricing is shown once from `codemie`.
function registerPricesCommand(pi) {
  pi.registerCommand("codemie-prices", {
    description:
      "List CodeMie models sorted by price (input/output/total/context); e.g. /codemie-prices output desc",
    getArgumentCompletions(prefix) {
      const items = [
        ...Object.keys(SORT_KEYS).map((k) => ({ value: k, label: k })),
        { value: "asc", label: "asc" },
        { value: "desc", label: "desc" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const sortArg = tokens.find((t) => t in SORT_KEYS) || "total";
      const desc = tokens.includes("desc");
      const sortKey = SORT_KEYS[sortArg];

      const models = ctx.modelRegistry.getAvailable().filter((m) => m.provider === "codemie");
      if (models.length === 0) {
        notifyOrPrint(ctx, "No CodeMie models available (not authenticated yet?).");
        return;
      }

      const markdown = buildPricesMarkdown(models, sortKey, desc);

      if (ctx.mode === "tui") {
        pi.appendEntry("codemie-prices", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        // print/json modes: notify() is a no-op (ctx.hasUI === false) — write directly.
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("codemie-prices", (entry) => {
    const data = entry.data;
    const mdTheme = getMarkdownTheme();
    return new Markdown(data.markdown, 1, 0, mdTheme);
  });
}

// ---------------------------------------------------------------------------
// /codemie-capabilities — per-deployment capability table
// ---------------------------------------------------------------------------

function registerCapabilitiesCommand(pi) {
  const flags = {
    reasoning: "reasoning",
    vision: "vision",
    image: "image",
    video: "video",
    audio: "audio",
    tools: "tools",
  };

  pi.registerCommand("codemie-capabilities", {
    description:
      "List CodeMie deployment capabilities (vision/image/video/audio/tools/reasoning); e.g. /codemie-capabilities image",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in flags);
      const models = ctx.modelRegistry.getAvailable().filter((m) => m.provider === "codemie" || m.provider === "codemie-cli");

      const rows = models
        .map((model) => {
          const caps = model.capabilities ?? {};
          return {
            id: model.id,
            type: model.id.startsWith("claude") ? "claude" : "chat",
            reasoning: caps.reasoning ? "✓" : "",
            vision: caps.vision ? "✓" : "",
            image: caps.image ? "✓" : "",
            video: caps.video ? "✓" : "",
            audio: caps.audio ? "✓" : "",
            tools: caps.tools ? "✓" : "",
          };
        })
        .filter((row) => !filter || row[flags[filter]] === "✓")
        .sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));

      const markdown = [
        `# CodeMie deployment capabilities${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Model | Type | Reasoning | Vision | Image | Video | Audio | Tools |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|",
        ...rows.map(
          (row) =>
            `| ${row.id} | ${row.type} | ${row.reasoning || "—"} | ${row.vision || "—"} | ${row.image || "—"} | ${row.video || "—"} | ${row.audio || "—"} | ${row.tools || "—"} |`,
        ),
        "",
        "_Capabilities are read from each deployment's CodeMie model metadata (multimodal / type / capabilities / supported_features)._",
      ].join("\n");

      if (ctx.mode === "tui") {
        pi.appendEntry("codemie-capabilities", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("codemie-capabilities", (entry) => {
    const mdTheme = getMarkdownTheme();
    return new Markdown(entry.data.markdown, 1, 0, mdTheme);
  });
}

// ---------------------------------------------------------------------------
// /codemie-usage — account budget/quota usage
// (confirmed endpoint, captured from the CodeMie web UI's Network panel:
//  GET {apiUrl}/v1/analytics/budget_usage)
// ---------------------------------------------------------------------------

async function fetchBudgetUsage(apiUrl, headers) {
  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/analytics/budget_usage`, {
    headers,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * `budget_usage` lags real spend by ~5-10 min. The analytics *insights*
 * dashboard (https://{host}/analytics?tab=insights) is backed by a
 * different, much faster endpoint set — confirmed by timing: a token-count
 * bump showed up within ~20-30s of a real request, vs. minutes for
 * `budget_usage`. `cli-summary` reports CLI-proxy-channel traffic only
 * (i.e. requests carrying `X-CodeMie-Client`, like `codemie-cli`'s) — it
 * won't move for plain `codemie` usage. Used as a best-effort supplement to
 * `/codemie-usage`, not a replacement (it has no per-bucket $ breakdown).
 */
async function fetchCliInsightsSummary(apiUrl, headers, timePeriod = "last_24_hours") {
  const res = await fetch(
    `${apiUrl.replace(/\/+$/, "")}/v1/analytics/cli-summary?time_period=${encodeURIComponent(timePeriod)}`,
    { headers, redirect: "follow" }
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Flatten `{ data: { metrics: [{ id, value }, ...] } }` into `{ id: value }`. */
function summarizeCliInsights(payload) {
  const metrics = payload?.data?.metrics;
  if (!Array.isArray(metrics)) return undefined;
  const byId = {};
  for (const m of metrics) {
    if (m && typeof m === "object" && typeof m.id === "string") byId[m.id] = m.value;
  }
  return byId;
}

/** notify() is a no-op outside TUI/RPC (ctx.hasUI === false in print/json) — fall
 * back to stdout so print-mode/CI callers still see the message. */
function notifyOrPrint(ctx, message, level = "warning") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function fmtMoney(n) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : String(n ?? "");
}

function fmtPercent(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}%` : String(n ?? "");
}

function fmtTimestamp(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? "");
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Render an unknown JSON shape as markdown without assuming its schema:
 * a flat array of objects becomes a table, a plain object becomes a
 * key/value list, anything else is pretty-printed as a JSON code block. */
function buildGenericMarkdown(data) {
  const lines = ["# CodeMie budget usage", ""];

  if (Array.isArray(data) && data.length > 0 && data.every((row) => row && typeof row === "object")) {
    const keys = Array.from(new Set(data.flatMap((row) => Object.keys(row))));
    lines.push(`| ${keys.join(" | ")} |`);
    lines.push(`|${keys.map(() => "---").join("|")}|`);
    for (const row of data) {
      lines.push(`| ${keys.map((k) => String(row[k] ?? "")).join(" | ")} |`);
    }
    return lines.join("\n");
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    lines.push("| Field | Value |", "|---|---|");
    for (const [key, value] of Object.entries(data)) {
      const rendered =
        value && typeof value === "object" ? "```json\n" + JSON.stringify(value, null, 2) + "\n```" : String(value);
      lines.push(`| ${key} | ${rendered} |`);
    }
    return lines.join("\n");
  }

  lines.push("```json", JSON.stringify(data, null, 2), "```");
  return lines.join("\n");
}

/**
 * `/v1/analytics/budget_usage` returns `{ data: { columns, rows, totals }, metadata }`
 * (a generic "report table" shape). Render the known `rows` fields
 * (project_name, current_spending, budget_limit, total%, budget_reset_at,
 * time_until_reset) as a friendly table; fall back to the generic renderer
 * for anything that doesn't match this exact shape.
 */
function fmtNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n ?? "");
}

/**
 * Renders the fast `cli-summary` metrics (see fetchCliInsightsSummary) as a
 * compact table, plus a link to the full insights dashboard. `insights` is
 * the flattened `{ id: value }` map from summarizeCliInsights(), or
 * undefined if that fetch failed/was skipped — in which case only the link
 * is shown so /codemie-usage still degrades gracefully.
 */
function buildInsightsSection(insights, dashboardUrl) {
  const lines = [
    "",
    "## CLI channel (fast, near real-time)",
    "",
    `_from \`/v1/analytics/cli-summary\` — updates within ~20-30s of a request, unlike the budget table above. Covers \`codemie-cli/*\` (and any other CLI/agent client) traffic only; not broken out by $ bucket._`,
  ];

  if (insights) {
    lines.push(
      "",
      "| Metric | Value |",
      "|---|---|",
      `| CLI cost (last 24h) | ${fmtMoney(insights.cli_cost)} |`,
      `| Total tokens (last 24h) | ${fmtNumber(insights.total_tokens)} |`,
      `| Sessions (last 24h) | ${fmtNumber(insights.unique_sessions)} |`
    );
  } else {
    lines.push("", "_(could not fetch — see warning above; the dashboard link below still works.)_");
  }

  if (dashboardUrl) {
    lines.push("", `Full breakdown (per-client, per-repo, sessions, tools): ${dashboardUrl}/analytics?tab=insights`);
  }

  return lines.join("\n");
}

function buildUsageMarkdown(payload, insights, dashboardUrl) {
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return buildGenericMarkdown(payload) + "\n" + buildInsightsSection(insights, dashboardUrl);
  }

  const asOf = payload?.metadata?.data_as_of;
  const lines = [
    "# CodeMie budget usage",
    "",
    asOf ? `_as of ${fmtTimestamp(asOf)}_` : undefined,
    "_(budget_usage lags real spend by ~5-10 min. Same account, three billing " +
      "channels: the plain row is Web/Platform, \"(cli)\" is `codemie-cli/*` " +
      "usage, \"(premium)\" is premium-model usage from either. The status bar " +
      "shows the plain+premium total while a `codemie/*` model is active, and " +
      "the \"(cli)\" total while a `codemie-cli/*` model is active.)_",
    "",
    "| Project | Spent | Budget Limit | Used % | Resets At | Time Until Reset |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.project_name ?? ""} | ${fmtMoney(r.current_spending)} | ${fmtMoney(r.budget_limit)} | ${fmtPercent(
        r.total
      )} | ${fmtTimestamp(r.budget_reset_at)} | ${r.time_until_reset ?? ""} |`
    ),
  ].filter((l) => l !== undefined);

  return lines.join("\n") + "\n" + buildInsightsSection(insights, dashboardUrl);
}

/**
 * Registers `/codemie-usage`, showing the full budget_usage table (all
 * buckets/rows: Web/Platform, "(cli)", "(premium)", ...) for the one CodeMie
 * account shared by both `codemie` and `codemie-cli`.
 */
function registerUsageCommand(pi, getApiUrl, getAuthHeaders) {
  pi.registerCommand("codemie-usage", {
    description: "Show current CodeMie account budget/quota usage (all billing channels).",
    handler: async (_args, ctx) => {
      const apiUrl = getApiUrl();
      const headers = getAuthHeaders();
      if (!apiUrl || Object.keys(headers).length === 0) {
        notifyOrPrint(ctx, "Not authenticated with CodeMie yet — run /login codemie first.");
        return;
      }
      let data;
      try {
        data = await fetchBudgetUsage(apiUrl, headers);
      } catch (error) {
        notifyOrPrint(
          ctx,
          `Failed to fetch CodeMie budget usage (${error instanceof Error ? error.message : String(error)}).`
        );
        return;
      }

      // Best-effort supplement: the fast insights endpoint. Its failure
      // should not block showing the (already-fetched) budget table above.
      let insights;
      try {
        insights = summarizeCliInsights(await fetchCliInsightsSummary(apiUrl, headers));
      } catch (error) {
        console.error(
          `[codemie-usage] Could not fetch fast CLI insights (${
            error instanceof Error ? error.message : String(error)
          }); showing budget table only.`
        );
      }
      const dashboardUrl = frontendFromApiBase(apiUrl);

      const markdown = buildUsageMarkdown(data, insights, dashboardUrl);
      if (ctx.mode === "tui") {
        pi.appendEntry("codemie-usage", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        // print/json modes: notify() is a no-op (ctx.hasUI === false) — write directly.
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("codemie-usage", (entry) => {
    const data = entry.data;
    const mdTheme = getMarkdownTheme();
    return new Markdown(data.markdown, 1, 0, mdTheme);
  });
}

// ---------------------------------------------------------------------------
// Status bar — compact budget usage, refreshed periodically + after turns
// ---------------------------------------------------------------------------

// The backend aggregates spend in batches — measured ~5-10 min lag between an
// actual request and budget_usage reflecting it (confirmed empirically: cost
// showed up in the API response immediately, but budget_usage stayed frozen
// for 3+ minutes before updating). Polling more often than that just wastes
// requests, so there is no turn_end-triggered refresh — background poll only.
const USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// One account, several LiteLLM billing buckets (rows), keyed by project_name
// suffix: plain email = Web/Platform, "(cli)" = codemie-cli/* usage, "(premium)"
// = premium-model usage. `bucket: "web"` sums every row EXCEPT "(cli)" (i.e.
// what `codemie/*` spends); `bucket: "cli"` sums ONLY the "(cli)" row (i.e.
// what `codemie-cli/*` spends).
function isCliBucket(projectName) {
  return typeof projectName === "string" && /\(cli\)\s*$/i.test(projectName);
}

/** Aggregate the row(s) belonging to one billing bucket into one compact line. */
function summarizeUsage(payload, theme, emoji, bucket) {
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  const usedRows =
    bucket === "cli" ? rows.filter((r) => isCliBucket(r.project_name)) : rows.filter((r) => !isCliBucket(r.project_name));
  if (usedRows.length === 0) return undefined;

  const spent = usedRows.reduce((s, r) => s + (typeof r.current_spending === "number" ? r.current_spending : 0), 0);
  const limit = usedRows.reduce((s, r) => s + (typeof r.budget_limit === "number" ? r.budget_limit : 0), 0);
  const pct = limit > 0 ? (spent / limit) * 100 : 0;

  const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
  const text = `${emoji} $${spent.toFixed(2)}/$${limit.toFixed(2)} (${pct.toFixed(1)}%)`;
  return theme ? theme.fg(color, text) : text;
}

function isProviderModel(model, providerId) {
  return model?.provider === providerId;
}

/**
 * Registers a status-bar widget showing compact budget usage for one
 * billing bucket, visible only while a model from `providerId` is active.
 * Called once for `codemie` (bucket: "web") and once for `codemie-cli`
 * (bucket: "cli") — both read the SAME account's budget_usage response
 * (same getApiUrl/getAuthHeaders), just summing different row(s), so both
 * can be shown side by side without clobbering each other.
 */
function registerUsageStatusBar(pi, providerId, statusKey, emoji, bucket, getApiUrl, getAuthHeaders) {
  let timer;
  let inFlight = false;
  // Only show/refresh the widget while a model from this provider is
  // actually active — switching to another provider hides it, since the
  // budget it reports is irrelevant to whatever model is now active.
  // Switching back brings it back.
  let active = false;

  async function refresh(ctx) {
    if (!active || inFlight) return;

    const apiUrl = getApiUrl();
    const headers = getAuthHeaders();
    if (!apiUrl || Object.keys(headers).length === 0) return; // not authenticated yet

    inFlight = true;
    try {
      const payload = await fetchBudgetUsage(apiUrl, headers);
      const summary = summarizeUsage(payload, ctx.ui.theme, emoji, bucket);
      if (summary) ctx.ui.setStatus(statusKey, summary);
    } catch {
      // Best-effort background refresh — keep whatever status was shown before.
    } finally {
      inFlight = false;
    }
  }

  function setActive(nowActive, ctx) {
    if (active === nowActive) return;
    active = nowActive;
    if (active) {
      refresh(ctx);
    } else {
      ctx.ui.setStatus(statusKey, undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    active = isProviderModel(ctx.model, providerId);
    if (active) refresh(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => refresh(ctx), USAGE_REFRESH_INTERVAL_MS);
  });

  pi.on("model_select", async (event, ctx) => {
    setActive(isProviderModel(event.model, providerId), ctx);
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}

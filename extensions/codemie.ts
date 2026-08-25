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
// Registers a single provider:
//   codemie – all models; non-Claude via OpenAI Chat Completions ({apiUrl}/v1),
//   claude-* via native Anthropic Messages ({apiUrl}/v1/messages).

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const COOKIE_FILE = join(homedir(), ".pi", "agent", "codemie-cookie.txt");
const PROVIDER_IDS = ["codemie"];
const LOGIN_TIMEOUT_MS = 120_000;
// Default CodeMie instance — override with CODEMIE_BASE_URL.
const DEFAULT_CODEMIE_URL = "https://codemie.lab.epam.com";

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
  /^gpt-5-5-/,
  /^gpt-5-6-/,
  /^gpt-5-6-/,
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
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const models = await res.json();
  if (!Array.isArray(models)) {
    throw new Error("unexpected response shape (expected array)");
  }
  return models.filter((m) => m && m.enabled !== false).map(convertLlmModel);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi) {
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
  let entries = [];
  let envAuth = null; // { headers } | { apiKey, authHeader? }

  if (codeMieUrl && (jwt || apiKeyEnv || cookieEnv)) {
    envAuth = cookieEnv
      ? { headers: { Cookie: cookieEnv } }
      : { apiKey: jwt || apiKeyEnv };
    try {
      entries = await fetchCodeMieModels(apiUrl, {
        bearer: jwt || apiKeyEnv,
        cookieString: cookieEnv,
      });
    } catch (error) {
      console.error(
        `[codemie] Live model fetch failed (${
          error instanceof Error ? error.message : String(error)
        }).`
      );
    }
  }

  // ---- Mode 2: OAuth SSO ---------------------------------------------------
  let oauthBlock = null;
  let oauthCreds = null;

  if (!envAuth) {

    // Base URL used by login/refresh. Defaults to CODEMIE_BASE_URL or the
    // public instance; /login lets the user override it interactively.
    let activeBaseUrl = codeMieUrl;

    const makeOauthBlock = () => {
      // Ask which CodeMie instance to log into. Pressing Enter accepts the
      // default — same UX as the built-in provider logins.
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
          // Still valid? Keep it (prevents redundant browser pop-ups).
          if (!isExpired(credentials)) return credentials;
          console.error("[codemie] SSO session expired — reopening browser for login...");
          const cred = await performLogin(activeBaseUrl);
          persistSession(cred);
          apiUrl = cred.apiUrl;
          oauthCreds = cred;
          return { refresh: cred.refresh, access: cred.access, expires: cred.expires };
        },
        getApiKey(credentials) {
          return credentials.access;
        },
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

    // Discover models with the stored session, if any. A stale session may
    // fail here — that's fine, we just fall back to the seed model list.
    if (oauthCreds) {
      let cookies = {};
      try {
        cookies = JSON.parse(oauthCreds.refresh ?? "{}")?.cookies ?? {};
      } catch {}
      const cookieString = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      const loadEntries = () =>
        fetchCodeMieModels(apiUrl, {
          bearer: oauthCreds.access,
          cookieString,
        });
      try {
        entries = await loadEntries();
      } catch (firstError) {
        // One retry for transient network hiccups before falling back quietly.
        try {
          entries = await loadEntries();
        } catch {
          const detail =
            firstError instanceof Error ? firstError.message : String(error);
          console.error(
            `[codemie] Model discovery failed (${detail}); showing a reduced ` +
              "list. /login codemie or restart to reload the full catalog."
          );
        }
      }
    }
  }

  // ---- Fallback / seed models --------------------------------------------
  if (entries.length === 0 && process.env.CODEMIE_MODEL) {
    entries = [convertLlmModel({ deployment_name: process.env.CODEMIE_MODEL })];
  }
  if (entries.length === 0) {
    // No session yet — still register the provider (so /login codemie exists
    // and models are selectable); after login the real list loads on restart.
    const SEED_MODELS = [
      "gpt-5-mini-2025-08-07",
      "gpt-5.1-codex-2025-11-13",
      "gemini-3-pro",
      "deepseek-v4-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ];
    entries = SEED_MODELS.map((id) => convertLlmModel({ deployment_name: id }));
  }

  // ---- Provider registration ----------------------------------------------

  // Single provider: Claude models are flagged to speak the Anthropic
  // Messages protocol at the API root (preserving native thinking/caching),
  // everything else uses OpenAI Chat Completions under /v1.
  const routedModels = entries.map((entry) => {
    if (!entry.id.startsWith("claude")) {
      return { ...entry, compat: { ...entry.compat, supportsReasoningEffort: true } };
    }
    return {
      ...entry,
      api: "anthropic-messages",
      baseUrl: apiUrl, // Anthropic endpoint lives at the API root, not /v1
    };
  });

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

  if (routedModels.length > 0) {
    pi.registerProvider("codemie", {
      name: "CodeMie",
      baseUrl: `${apiUrl}/v1`,
      ...authConfig,
      api: "openai-completions",
      models: routedModels,
    });
  }
}

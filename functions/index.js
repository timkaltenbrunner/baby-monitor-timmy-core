const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();

const cfTurnToken = defineSecret("CLOUDFLARE_TURN_TOKEN");
const cfTurnKeyId = defineSecret("CLOUDFLARE_TURN_KEY_ID");
const cfAnalyticsToken = defineSecret("CLOUDFLARE_ANALYTICS_TOKEN");
const cfAccountId = defineString("CLOUDFLARE_ACCOUNT_ID");
const adminUid = defineString("ADMIN_UID");
const localTurnApiBaseUrl = defineString("LOCAL_TURN_API_BASE_URL");
const localTurnPublicUrls = defineString("LOCAL_TURN_PUBLIC_URLS");
const webCompanionAppIds = defineString("WEB_COMPANION_APP_IDS");
const appStoreSharedSecret = defineString("APP_STORE_SHARED_SECRET");
const localTurnApiKey = defineSecret("LOCAL_TURN_API_KEY");
const localTurnHmacSecret = defineSecret("LOCAL_TURN_HMAC_SECRET");

const CLOUDFLARE_TURN_BUILTIN_ID = "cloudflare-builtin";
const LOCAL_TURN_BUILTIN_ID = "local-turn-builtin";
const DEFAULT_LOCAL_TURN_TIMEOUT_MS = 1500;
const DEFAULT_LOCAL_TURN_TTL_SECONDS = 3600;
const DEFAULT_CLIENT_CACHE_TTL_SECONDS = 3600;
const DUAL_PROVIDER_CLIENT_CACHE_TTL_SECONDS = 300;

// ─── Debug E2E billing short-circuit ─────────────────────────────────────────
// When GIFT_DEBUG_TOKENS_ALLOWED is "true" (set per env, dev/staging only),
// purchase tokens starting with `debug-e2e-` short-circuit the Play Developer
// API in getPlaySubscription / deferPlaySubscription so the E2E subscription
// test (scripts/test_emulators_subscription.js) can drive the gift / campaign
// flows without a live Play account. Production must keep this flag unset.
const GIFT_DEBUG_TOKENS_ALLOWED =
  process.env.GIFT_DEBUG_TOKENS_ALLOWED === "true";
const DEBUG_TOKEN_PREFIX = "debug-e2e-";
const TEST_RUN_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

function isDebugPurchaseToken(tok) {
  return (
    GIFT_DEBUG_TOKENS_ALLOWED &&
    typeof tok === "string" &&
    tok.startsWith(DEBUG_TOKEN_PREFIX)
  );
}

/**
 * Returns a sanitized testRunId if the request meets every guard:
 *   - GIFT_DEBUG_TOKENS_ALLOWED is true,
 *   - the call carries a debug token,
 *   - request.data.testRunId is a string matching TEST_RUN_ID_REGEX.
 * Returns null otherwise (production callers always get null).
 */
function pickTestRunId(request, purchaseToken) {
  if (!GIFT_DEBUG_TOKENS_ALLOWED) return null;
  if (!isDebugPurchaseToken(purchaseToken)) return null;
  const id = request && request.data && request.data.testRunId;
  if (typeof id !== "string") return null;
  if (!TEST_RUN_ID_REGEX.test(id)) return null;
  return id;
}

// ─── App Check (admin bypasses) ──────────────────────────────────────────────

function requireAppCheck(request) {
  if (request.auth && request.auth.uid === adminUid.value()) return;
  if (!request.app) {
    throw new HttpsError("failed-precondition", "App Check token missing");
  }
}

function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }
  if (request.auth.uid !== adminUid.value()) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const configRateLimitMap = new Map();
const CONFIG_RATE_LIMIT_MAX = 60;

const clientAuthRateLimitMap = new Map();
const MOBILE_AUTH_RATE_LIMIT_MAX = 30;
const WEB_ACCESS_RATE_LIMIT_MAX = 20;

const WEB_COMPANION_DEFAULT_APP_IDS = [
  "1:335595248113:web:a1e763f1862f4847214c50",
];
const WEB_ID_REGEX = /^[A-Za-z0-9_-]{12,128}$/;
const UID_REGEX = /^[A-Za-z0-9:_-]{6,128}$/;
const PAIRING_DOC_KEY_REGEX = /^[a-f0-9]{64}$/;
const WEB_AUTH_LEASE_MS = 30 * 60 * 1000;
const WEB_AUTH_MAX_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(map, uid, max) {
  const now = Date.now();
  const entry = map.get(uid);

  if (!entry || now >= entry.resetAt) {
    map.set(uid, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= max) {
    return false;
  }

  entry.count++;
  return true;
}

// ─── In-memory config cache ──────────────────────────────────────────────────

let _turnConfigCache = null;
let _turnConfigCacheAt = 0;
const TURN_CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// Config cache-bust marker: 9

function safeParamValue(param) {
  try {
    return param.value();
  } catch (error) {
    return "";
  }
}

function getConfiguredWebCompanionAppIds() {
  const configured = String(safeParamValue(webCompanionAppIds) || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : WEB_COMPANION_DEFAULT_APP_IDS;
}

function isWebCompanionAppCheck(request) {
  const appId = request.app?.appId || request.app?.app_id || "";
  return appId && getConfiguredWebCompanionAppIds().includes(appId);
}

function validatePairingDocKey(value) {
  if (typeof value !== "string" || !PAIRING_DOC_KEY_REGEX.test(value)) {
    throw new HttpsError("invalid-argument", "Invalid pairingDocKey");
  }
}

function validateWebField(value, fieldName) {
  if (typeof value !== "string" || !WEB_ID_REGEX.test(value)) {
    throw new HttpsError("invalid-argument", `Invalid ${fieldName}`);
  }
}

function validateUid(value, fieldName = "uid") {
  if (typeof value !== "string" || !UID_REGEX.test(value)) {
    throw new HttpsError("invalid-argument", `Invalid ${fieldName}`);
  }
}

function normalizeStringArray(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }
  const value = String(rawValue || "").trim();
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function renumberProviders(providers) {
  return providers.map((provider, index) => ({
    ...provider,
    priority: index + 1,
  }));
}

function buildCloudflareBuiltinProvider(priority = 2) {
  return {
    id: CLOUDFLARE_TURN_BUILTIN_ID,
    name: "Cloudflare TURN",
    type: "cloudflare",
    enabled: true,
    priority,
    builtin: true,
    config: {
      ttl: 86400,
    },
  };
}

function buildLocalBuiltinProvider(priority = 1) {
  const apiBaseUrl = String(safeParamValue(localTurnApiBaseUrl) || "").trim();
  const hmacSecret = String(safeParamValue(localTurnHmacSecret) || "").trim();
  if (!apiBaseUrl && !hmacSecret) {
    return null;
  }
  const urls = normalizeStringArray(safeParamValue(localTurnPublicUrls));

  return {
    id: LOCAL_TURN_BUILTIN_ID,
    name: "Lokaler TURN",
    type: "local-rest",
    enabled: true,
    priority,
    builtin: true,
    config: {
      urls,
      ttl: DEFAULT_LOCAL_TURN_TTL_SECONDS,
      timeoutMs: DEFAULT_LOCAL_TURN_TIMEOUT_MS,
    },
  };
}

function mergeProviderWithDefaults(provider, defaults) {
  return {
    ...defaults,
    ...provider,
    builtin: defaults.builtin === true,
    config: {
      ...(defaults.config || {}),
      ...(provider.config || {}),
    },
  };
}

function sanitizeTurnProvider(provider) {
  if (!provider || typeof provider !== "object") {
    return null;
  }

  const id = String(provider.id || "").trim();
  const type = String(provider.type || "").trim();
  const name = String(provider.name || "").trim();
  const enabled = provider.enabled !== false;
  const priority = parsePositiveInt(provider.priority, 99);

  if (id === CLOUDFLARE_TURN_BUILTIN_ID || type === "cloudflare") {
    return {
      id: CLOUDFLARE_TURN_BUILTIN_ID,
      name: name || "Cloudflare TURN",
      type: "cloudflare",
      enabled,
      priority,
      builtin: true,
      config: {
        ttl: parsePositiveInt(provider.config?.ttl, 86400),
      },
    };
  }

  if (id === LOCAL_TURN_BUILTIN_ID || type === "local-rest") {
    return {
      id: LOCAL_TURN_BUILTIN_ID,
      name: name || "Lokaler TURN",
      type: "local-rest",
      enabled,
      priority,
      builtin: true,
      config: {
        urls: normalizeStringArray(provider.config?.urls),
        ttl: parsePositiveInt(
          provider.config?.ttl,
          DEFAULT_LOCAL_TURN_TTL_SECONDS
        ),
        timeoutMs: parsePositiveInt(
          provider.config?.timeoutMs,
          DEFAULT_LOCAL_TURN_TIMEOUT_MS
        ),
      },
    };
  }

  if (type === "hmac-secret") {
    return {
      id: id || `turn-hmac-${Date.now()}`,
      name: name || "TURN (HMAC)",
      type: "hmac-secret",
      enabled,
      priority,
      builtin: false,
      config: {
        urls: normalizeStringArray(provider.config?.urls),
        secret: String(provider.config?.secret || "").trim(),
        ttl: parsePositiveInt(provider.config?.ttl, 86400),
        realm: String(provider.config?.realm || "").trim(),
      },
    };
  }

  if (type === "static") {
    return {
      id: id || `turn-${Date.now()}`,
      name: name || "Custom TURN",
      type: "static",
      enabled,
      priority,
      builtin: false,
      config: {
        urls: normalizeStringArray(provider.config?.urls),
        username: String(provider.config?.username || "").trim(),
        credential: String(provider.config?.credential || "").trim(),
      },
    };
  }

  return null;
}

function buildProviderList(storedProviders = []) {
  const sanitizedStoredProviders = Array.isArray(storedProviders)
    ? [...storedProviders]
        .map((provider) => sanitizeTurnProvider(provider))
        .filter(Boolean)
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    : [];

  const localBuiltin = buildLocalBuiltinProvider();
  let providers = sanitizedStoredProviders.map((provider) => {
    if (provider.id === CLOUDFLARE_TURN_BUILTIN_ID) {
      return mergeProviderWithDefaults(provider, buildCloudflareBuiltinProvider());
    }
    if (provider.id === LOCAL_TURN_BUILTIN_ID && localBuiltin) {
      return mergeProviderWithDefaults(provider, localBuiltin);
    }
    return provider;
  });

  const hasCloudflareBuiltin = providers.some(
    (provider) => provider.id === CLOUDFLARE_TURN_BUILTIN_ID
  );
  if (!hasCloudflareBuiltin) {
    providers.push(buildCloudflareBuiltinProvider(2));
    providers = renumberProviders(providers);
  }

  const hasLocalBuiltin = providers.some(
    (provider) => provider.id === LOCAL_TURN_BUILTIN_ID
  );
  if (localBuiltin && !hasLocalBuiltin) {
    providers.unshift(localBuiltin);
    providers = renumberProviders(providers);
  }

  return [...providers].sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

function getTurnRuntimeInfo() {
  const localApiBaseUrlValue = String(
    safeParamValue(localTurnApiBaseUrl) || ""
  ).trim();
  const localPublicUrlsValue = normalizeStringArray(
    safeParamValue(localTurnPublicUrls)
  );

  return {
    localApiConfigured: Boolean(localApiBaseUrlValue),
    localPublicUrlsConfigured: localPublicUrlsValue.length > 0,
  };
}

async function getTurnConfigFromFirestore(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    _turnConfigCache &&
    (now - _turnConfigCacheAt) < TURN_CONFIG_CACHE_TTL
  ) {
    return _turnConfigCache;
  }

  const db = getFirestore();
  const doc = await db.collection("admin").doc("turn_config").get();
  if (doc.exists) {
    _turnConfigCache = doc.data();
    _turnConfigCacheAt = now;
    return _turnConfigCache;
  }

  _turnConfigCache = null;
  _turnConfigCacheAt = now;
  return null;
}

async function saveTurnConfigToFirestore(providers) {
  const db = getFirestore();
  const data = {
    providers,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection("admin").doc("turn_config").set(data);
  _turnConfigCache = { providers };
  _turnConfigCacheAt = Date.now();
}

function normalizeReturnedIceServers(rawIceServers, providerId) {
  const entries = Array.isArray(rawIceServers)
    ? rawIceServers
    : rawIceServers
    ? [rawIceServers]
    : [];

  return entries
    .map((entry) => {
      const urls = normalizeStringArray(entry.urls);
      if (urls.length === 0) {
        return null;
      }
      return {
        urls,
        username: String(entry.username || "").trim(),
        credential: String(entry.credential || "").trim(),
        provider: providerId,
      };
    })
    .filter(Boolean);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getLocalTurnApiHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${localTurnApiKey.value()}`,
  };
}

// ─── Local TURN load probe (cached) ─────────────────────────────────────────
// Polls the authenticated /load endpoint of the local TURN REST API. Result is
// cached in-memory: ~30s on healthy responses, ~5s on failures (so a recovered
// router is picked up quickly without violating the failover SLA).
//   { ok: true,  overloaded, allocations_active, capacity_max, ... }  — alive
//   { ok: false, reason: 'no_api_base_url'|'unreachable'|'timeout'|'http_NNN' }
let _localTurnLoadCache = { value: null, at: 0, ttlMs: 0 };
const LOCAL_TURN_LOAD_CACHE_TTL_MS = 30 * 1000;
const LOCAL_TURN_LOAD_CACHE_TTL_FAIL_MS = 5 * 1000;
const LOCAL_TURN_LOAD_TIMEOUT_MS = 6000;

async function probeLocalTurnLoad(apiBaseUrl) {
  const now = Date.now();
  if (
    _localTurnLoadCache.value &&
    now - _localTurnLoadCache.at < _localTurnLoadCache.ttlMs
  ) {
    return _localTurnLoadCache.value;
  }
  if (!apiBaseUrl) {
    const result = { ok: false, reason: "no_api_base_url" };
    _localTurnLoadCache = {
      value: result,
      at: now,
      ttlMs: LOCAL_TURN_LOAD_CACHE_TTL_FAIL_MS,
    };
    return result;
  }
  try {
    const url = `${apiBaseUrl.replace(/\/+$/, "")}/load`;
    const resp = await fetchWithTimeout(
      url,
      { method: "GET", headers: getLocalTurnApiHeaders() },
      LOCAL_TURN_LOAD_TIMEOUT_MS
    );
    if (!resp.ok) {
      const result = { ok: false, reason: `http_${resp.status}` };
      _localTurnLoadCache = {
        value: result,
        at: now,
        ttlMs: LOCAL_TURN_LOAD_CACHE_TTL_FAIL_MS,
      };
      return result;
    }
    const data = await resp.json();
    const result = {
      ok: true,
      allocations_active: Number(data.allocations_active) || 0,
      capacity_max: Number(data.capacity_max) || 0,
      load_pct: Number(data.load_pct) || 0,
      state: String(data.state || "unknown"),
      overloaded: data.overloaded === true,
    };
    _localTurnLoadCache = {
      value: result,
      at: now,
      ttlMs: LOCAL_TURN_LOAD_CACHE_TTL_MS,
    };
    return result;
  } catch (e) {
    // AbortError → timeout; everything else (ECONNREFUSED, DNS, TLS) →
    // unreachable. Either way: do NOT serve local TURN.
    const isTimeout = e && e.name === "AbortError";
    const result = {
      ok: false,
      reason: isTimeout ? "timeout" : "unreachable",
      error: e.message || String(e),
    };
    _localTurnLoadCache = {
      value: result,
      at: now,
      ttlMs: LOCAL_TURN_LOAD_CACHE_TTL_FAIL_MS,
    };
    return result;
  }
}

// Exposed for admin UI: most recent probe (without forcing a fresh fetch).
function getCachedLocalTurnLoad() {
  return _localTurnLoadCache.value;
}

function updateLocalTurnLoadCacheFromData(data) {
  _localTurnLoadCache = {
    value: {
      ok: true,
      allocations_active: Number(data.allocations_active) || 0,
      capacity_max: Number(data.capacity_max) || 0,
      load_pct: Number(data.load_pct) || 0,
      state: String(data.load_state || data.state || "unknown"),
      overloaded: data.overloaded === true,
    },
    at: Date.now(),
    ttlMs: LOCAL_TURN_LOAD_CACHE_TTL_MS,
  };
}

async function fetchLocalTurnAdminEndpoint(endpoint, timeoutMs = 2000) {
  const apiBaseUrl = String(safeParamValue(localTurnApiBaseUrl) || "").trim();
  if (!apiBaseUrl) {
    return { ok: false, error: "no_api_base_url" };
  }
  try {
    const url = `${apiBaseUrl.replace(/\/+$/, "")}/${endpoint}`;
    const resp = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: getLocalTurnApiHeaders(),
      },
      timeoutMs
    );
    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }
    const data = await resp.json();
    if (
      data &&
      typeof data === "object" &&
      "allocations_active" in data &&
      "capacity_max" in data
    ) {
      updateLocalTurnLoadCacheFromData(data);
    }
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message || "probe_failed" };
  }
}

async function resolveLocalRestProvider(provider, uid) {
  const cfg = provider.config || {};
  const urls = normalizeStringArray(cfg.urls);
  if (urls.length === 0) {
    console.warn(`[TURN] local TURN provider ${provider.id} has no public URLs`);
    return [];
  }

  const ttl = parsePositiveInt(cfg.ttl, DEFAULT_LOCAL_TURN_TTL_SECONDS);
  const apiBaseUrl = String(safeParamValue(localTurnApiBaseUrl) || "").trim();

  // ── Health gate ──────────────────────────────────────────────────────────
  // The HMAC fallback path can fabricate "valid-looking" credentials for the
  // public TURN URLs even when the router is dead. Without a fresh health
  // check that gives a positive answer, the caller (getTurnCredentials) would
  // pick up these zombie credentials, never try Cloudflare, and the client
  // would hang on TURN allocation. Therefore: a failed /load probe MUST cause
  // resolveLocalRestProvider to return [] so the next provider in the loop
  // (Cloudflare) is attempted.
  if (!apiBaseUrl) {
    console.warn(
      `[TURN] skip local ${provider.id}: probe.ok=false reason=no_api_base_url`
    );
    return [];
  }
  const load = await probeLocalTurnLoad(apiBaseUrl);
  if (!load.ok) {
    console.warn(
      `[TURN] skip local ${provider.id}: probe.ok=false reason=${load.reason}` +
        (load.error ? ` (${load.error})` : "")
    );
    return [];
  }
  if (load.overloaded) {
    console.warn(
      `[TURN] skip local ${provider.id}: OVERLOADED ` +
        `(${load.allocations_active}/${load.capacity_max}, state=${load.state})`
    );
    return [];
  }

  // ── REST credentials ────────────────────────────────────────────────────
  // From here on the router is known healthy — it is safe to try /credentials
  // and (if that 5xx's) the HMAC fallback, because the TURN URLs we hand back
  // really are reachable.
  try {
    const timeoutMs = parsePositiveInt(
      cfg.timeoutMs,
      DEFAULT_LOCAL_TURN_TIMEOUT_MS
    );
    const requestUrl =
      `${apiBaseUrl.replace(/\/+$/, "")}/credentials` +
      `?ttl=${ttl}&user=${encodeURIComponent(`timmy-${uid}`)}`;

    const response = await fetchWithTimeout(
      requestUrl,
        {
          method: "GET",
          headers: getLocalTurnApiHeaders(),
        },
        timeoutMs
      );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `local TURN API error ${response.status}${details ? `: ${details}` : ""}`
      );
    }

    const data = await response.json();
    const returnedServers = normalizeReturnedIceServers(
      data.iceServers,
      provider.id
    );
    if (returnedServers.length > 0) {
      return returnedServers;
    }

    const username = String(data.username || "").trim();
    const credential = String(
      data.credential || data.password || ""
    ).trim();
    if (!username || !credential) {
      throw new Error("local TURN API returned no credentials");
    }

    return [{ urls, username, credential, provider: provider.id }];
  } catch (e) {
    console.warn(
      `[TURN] REST API failed for ${provider.id}: ${e.message}, trying HMAC fallback (probe was healthy)`
    );
  }

  // HMAC fallback: only reached when /load was healthy but /credentials 5xx'd.
  // Safe because the TURN URLs themselves are known reachable.
  const hmacSecret = String(safeParamValue(localTurnHmacSecret) || "").trim();
  if (hmacSecret) {
    const { username, credential } = generateHmacCredentials(
      hmacSecret,
      `timmy-${uid}`,
      ttl
    );
    console.log(`[TURN] HMAC fallback credentials generated for ${provider.id}`);
    return [{ urls, username, credential, provider: provider.id }];
  }

  console.warn(
    `[TURN] local TURN provider ${provider.id}: REST failed and no HMAC secret`
  );
  return [];
}

// Generate coturn-compatible HMAC-SHA1 credentials (use-auth-secret mode).
// username = "timestamp:user", credential = Base64(HMAC-SHA1(secret, username))
function generateHmacCredentials(secret, user, ttlSeconds) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${user}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential };
}

async function resolveHmacSecretProvider(provider, uid) {
  const cfg = provider.config || {};
  const urls = normalizeStringArray(cfg.urls);
  if (urls.length === 0) {
    console.warn(`[TURN] hmac-secret provider ${provider.id} has no URLs`);
    return [];
  }

  const secret = String(cfg.secret || "").trim();
  if (!secret) {
    console.warn(`[TURN] hmac-secret provider ${provider.id} has no secret`);
    return [];
  }

  const ttl = parsePositiveInt(cfg.ttl, 86400);
  const { username, credential } = generateHmacCredentials(
    secret,
    `timmy-${uid}`,
    ttl
  );

  return [
    {
      urls,
      username,
      credential,
      provider: provider.id,
    },
  ];
}

async function resolveCloudflareProvider(provider) {
  const keyId = cfTurnKeyId.value();
  const token = cfTurnToken.value();

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: provider.config?.ttl || 86400 }),
    }
  );

  if (!response.ok) {
    await response.text();
    throw new Error(`Cloudflare TURN API error: status ${response.status}`);
  }

  const data = await response.json();
  return normalizeReturnedIceServers(data.iceServers, provider.id);
}

function resolveStaticProvider(provider) {
  const cfg = provider.config || {};
  const urls = normalizeStringArray(cfg.urls);
  if (urls.length === 0) return [];
  return [
    {
      urls,
      username: cfg.username || "",
      credential: cfg.credential || "",
      provider: provider.id,
    },
  ];
}

// Registry of provider type → resolver function.
// Adding a new provider type only requires a new entry here.
const providerResolvers = {
  cloudflare: resolveCloudflareProvider,
  "local-rest": resolveLocalRestProvider,
  "hmac-secret": resolveHmacSecretProvider,
  static: resolveStaticProvider,
};

// ─── getTurnCredentials ──────────────────────────────────────────────────────

exports.getTurnCredentials = onCall(
  { secrets: [cfTurnToken, cfTurnKeyId, localTurnApiKey, localTurnHmacSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }
    requireAppCheck(request);

    if (!checkRateLimit(rateLimitMap, request.auth.uid, RATE_LIMIT_MAX)) {
      throw new HttpsError("resource-exhausted", "Rate limit exceeded");
    }

    const excludedProviderIds = new Set(
      normalizeStringArray(request.data?.excludeProviderIds)
    );

    // Load config from Firestore and merge it with the built-in providers.
    const turnConfig = await getTurnConfigFromFirestore();
    const configuredProviders = buildProviderList(turnConfig?.providers || [])
      .filter((p) => p.enabled)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
    const providers = configuredProviders.filter(
      (p) => !excludedProviderIds.has(p.id)
    );

    if (excludedProviderIds.size > 0) {
      console.log(
        `[TURN] excluding provider(s): ${Array.from(excludedProviderIds).join(", ")}`
      );
    }

    const allServers = [];
    const attemptedProviders = [];
    const availableProviders = [];

    // Exclusive delivery: return only the FIRST successful provider so WebRTC
    // does not race local TURN against Cloudflare in ICE checks (Cloudflare
    // UDP/Anycast almost always wins → unwanted CF egress costs). The next
    // provider in priority order acts as a real fallback only when the
    // current one returns no credentials (e.g. local TURN overloaded per
    // /load probe, or REST + HMAC both failed).
    for (const provider of providers) {
      attemptedProviders.push(provider.id);
      try {
        const resolver = providerResolvers[provider.type];
        if (!resolver) {
          console.warn(`[TURN] unknown provider type: ${provider.type}`);
          continue;
        }
        const providerServers = await resolver(provider, request.auth.uid);
        if (providerServers.length > 0) {
          allServers.push(...providerServers);
          availableProviders.push(provider.id);
          console.log(
            `[TURN] choose ${provider.id}: exclusive delivery ` +
              `(skipped ${providers.length - attemptedProviders.length} fallback provider(s))`
          );
          break;
        } else {
          console.log(
            `[TURN] skip ${provider.id}: resolver returned no servers`
          );
        }
      } catch (e) {
        console.error(`TURN provider ${provider.id} failed: ${e.message}`);
      }
    }

    if (allServers.length === 0) {
      throw new HttpsError("internal", "Failed to generate TURN credentials");
    }

    return {
      iceServers: allServers,
      providerMetadata: {
        primary: allServers[0]?.provider || null,
        attempted: attemptedProviders,
        available: availableProviders,
        excluded: Array.from(excludedProviderIds),
        generatedAt: Date.now(),
        localTurnLoad: getCachedLocalTurnLoad(),
      },
      cacheTtlSeconds:
        configuredProviders.length > 1
          ? DUAL_PROVIDER_CLIENT_CACHE_TTL_SECONDS
          : DEFAULT_CLIENT_CACHE_TTL_SECONDS,
    };
  }
);

// Admin-only: fetch fresh local TURN status (bypasses 30s cache for load).
exports.getLocalTurnStatus = onCall(
  { secrets: [localTurnApiKey] },
  async (request) => {
    requireAdmin(request);
    requireAppCheck(request);
    return fetchLocalTurnAdminEndpoint("status");
  }
);

exports.getLocalTurnLoadAdmin = onCall(
  { secrets: [localTurnApiKey] },
  async (request) => {
    requireAdmin(request);
    requireAppCheck(request);
    return fetchLocalTurnAdminEndpoint("load");
  }
);

exports.getTurnConfigAdmin = onCall(
  {},
  async (request) => {
    requireAdmin(request);
    requireAppCheck(request);

    const turnConfig = await getTurnConfigFromFirestore(true);
    return {
      providers: buildProviderList(turnConfig?.providers || []),
      runtime: getTurnRuntimeInfo(),
    };
  }
);

exports.checkTurnHealth = onCall(
  { secrets: [cfTurnToken, cfTurnKeyId, localTurnApiKey, localTurnHmacSecret] },
  async (request) => {
    requireAdmin(request);
    requireAppCheck(request);

    const turnConfig = await getTurnConfigFromFirestore(true);
    const providers = buildProviderList(turnConfig?.providers || []);
    const results = {};

    for (const provider of providers) {
      const start = Date.now();
      const result = {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        enabled: provider.enabled,
        status: "unknown",
        latencyMs: 0,
        details: "",
      };

      if (!provider.enabled) {
        result.status = "disabled";
        result.details = "Provider ist deaktiviert";
        results[provider.id] = result;
        continue;
      }

      try {
        if (provider.type === "cloudflare") {
          const keyId = cfTurnKeyId.value();
          const token = cfTurnToken.value();
          const response = await fetchWithTimeout(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ttl: 60 }),
            },
            5000,
          );
          result.latencyMs = Date.now() - start;

          if (response.ok) {
            const data = await response.json();
            const servers = normalizeReturnedIceServers(
              data.iceServers,
              provider.id,
            );
            result.status = servers.length > 0 ? "healthy" : "degraded";
            result.details = servers.length > 0
              ? `${servers.length} ICE server(s), ${servers[0].urls?.length || 0} URL(s)`
              : "Credentials returned but no ICE servers";
          } else {
            result.status = "error";
            result.details = `HTTP ${response.status}`;
          }
        } else if (provider.type === "local-rest") {
          const apiBaseUrl = String(
            safeParamValue(localTurnApiBaseUrl) || "",
          ).trim();
          const hmacSecret = String(
            safeParamValue(localTurnHmacSecret) || "",
          ).trim();
          let restStatus = null;
          let restDetails = "";

          // Check REST API health endpoint
          if (apiBaseUrl) {
            try {
              const healthUrl = `${apiBaseUrl.replace(/\/+$/, "")}/health`;
              const healthResp = await fetchWithTimeout(
                healthUrl,
                {
                  method: "GET",
                  headers: { Accept: "application/json" },
                },
                3000,
              );
              result.latencyMs = Date.now() - start;

              if (healthResp.ok) {
                const credStart = Date.now();
                const credUrl =
                  `${apiBaseUrl.replace(/\/+$/, "")}/credentials?ttl=60&user=health-check`;
                const credResp = await fetchWithTimeout(
                  credUrl,
                  {
                    method: "GET",
                    headers: getLocalTurnApiHeaders(),
                  },
                  3000,
                );
                const credLatency = Date.now() - credStart;

                if (credResp.ok) {
                  restStatus = "healthy";
                  restDetails =
                    `REST API: ${result.latencyMs}ms, Credentials: ${credLatency}ms`;
                } else {
                  restStatus = "degraded";
                  restDetails =
                    `REST API OK (${result.latencyMs}ms) aber Credentials HTTP ${credResp.status}`;
                }
              } else {
                restStatus = "error";
                restDetails = `REST API HTTP ${healthResp.status}`;
              }
            } catch (e) {
              result.latencyMs = Date.now() - start;
              restStatus = "error";
              restDetails = e.name === "AbortError"
                ? `REST API Timeout (${result.latencyMs}ms)`
                : `REST API: ${e.message}`;
            }
          }

          // Check HMAC fallback availability
          const hmacAvailable = hmacSecret.length > 0;
          if (hmacAvailable) {
            const { username, credential } = generateHmacCredentials(
              hmacSecret,
              "health-check",
              60,
            );
            if (!username || !credential) {
              result.status = "error";
              result.details = "HMAC-Credential-Generierung fehlgeschlagen";
              results[provider.id] = result;
              continue;
            }
          }

          // Determine overall status
          if (restStatus === "healthy") {
            result.status = "healthy";
            result.details = restDetails +
              (hmacAvailable ? " (HMAC-Fallback bereit)" : "");
          } else if (hmacAvailable) {
            result.status = "healthy";
            result.details = "HMAC-Credentials aktiv" +
              (restDetails ? ` — ${restDetails}` : " (keine REST API)");
          } else if (restStatus) {
            result.status = "error";
            result.details = restDetails;
          } else {
            result.status = "error";
            result.details =
              "Keine REST API URL und kein HMAC-Secret konfiguriert";
          }
        } else if (provider.type === "hmac-secret") {
          const cfg = provider.config || {};
          const urls = normalizeStringArray(cfg.urls);
          const secret = String(cfg.secret || "").trim();
          result.latencyMs = Date.now() - start;
          if (!secret) {
            result.status = "error";
            result.details = "HMAC-Secret fehlt";
          } else if (urls.length === 0) {
            result.status = "error";
            result.details = "Keine TURN-URLs konfiguriert";
          } else {
            // Verify credential generation works
            const { username, credential } = generateHmacCredentials(secret, "health-check", 60);
            result.status = username && credential ? "healthy" : "degraded";
            result.details = `${urls.length} URL(s), HMAC-Credentials generiert`;
          }
        } else if (provider.type === "static") {
          result.status = "static";
          result.details = "Statische Credentials (kein Health-Check)";
          result.latencyMs = 0;
        }
      } catch (e) {
        result.latencyMs = Date.now() - start;
        result.status = "error";
        result.details = e.name === "AbortError"
          ? `Timeout nach ${result.latencyMs}ms`
          : e.message;
      }

      results[provider.id] = result;
    }

    return { results, checkedAt: Date.now() };
  },
);

exports.setTurnConfigAdmin = onCall(
  {},
  async (request) => {
    requireAdmin(request);
    requireAppCheck(request);

    const providersInput = Array.isArray(request.data?.providers)
      ? request.data.providers
      : [];
    const providers = renumberProviders(
      providersInput
        .map((provider) => sanitizeTurnProvider(provider))
        .filter(Boolean)
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    );

    await saveTurnConfigToFirestore(providers);

    return {
      providers: buildProviderList(providers),
      runtime: getTurnRuntimeInfo(),
    };
  }
);

// ─── getAppConfig ────────────────────────────────────────────────────────────

exports.getAppConfig = onCall(
  {},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }
    requireAppCheck(request);

    if (
      !checkRateLimit(
        configRateLimitMap,
        request.auth.uid,
        CONFIG_RATE_LIMIT_MAX
      )
    ) {
      throw new HttpsError("resource-exhausted", "Rate limit exceeded");
    }

    const db = getFirestore();

    // Read feature flags + notifications in parallel
    const [flagsDoc, notifDoc] = await Promise.all([
      db.collection("admin").doc("feature_flags").get(),
      db.collection("admin").doc("notifications").get(),
    ]);

    // Feature flags — single restriction level for ALL users (no free/premium
    // split). Backward-compatible: prefer scalar `restrictionLevel`, else fall
    // back to legacy `restrictionLevel.premium` map (used until v1.x).
    // Levels: 0=all, 1=SD+HD only, 2=SD only, 3=video off, 4=TURN off.
    let restrictionLevel = 0;
    let restrictionMessage = null;
    let featureFlagsEnabled = false;

    if (flagsDoc.exists) {
      const flags = flagsDoc.data();
      featureFlagsEnabled = flags.enabled === true;
      if (featureFlagsEnabled) {
        const rl = flags.restrictionLevel;
        if (typeof rl === "number") {
          restrictionLevel = rl;
        } else if (rl && typeof rl === "object") {
          restrictionLevel = rl.premium || rl.free || 0;
        }
        if (restrictionLevel > 0 && flags.message) {
          restrictionMessage = flags.message;
        }
      }
    }

    // Notifications — filter active ones
    let banners = [];
    if (notifDoc.exists) {
      const notifData = notifDoc.data();
      const now = new Date();

      banners = (notifData.banners || []).filter((b) => {
        if (!b.active) return false;

        // Date range check
        if (b.startDate) {
          const start = b.startDate.toDate
            ? b.startDate.toDate()
            : new Date(b.startDate);
          if (now < start) return false;
        }
        if (b.endDate) {
          const end = b.endDate.toDate
            ? b.endDate.toDate()
            : new Date(b.endDate);
          if (now > end) return false;
        }

        // Audience filter — `free`/`premium` audiences are deprecated since
        // the product is premium-only; treat all users as premium so legacy
        // `premium` banners still show, while legacy `free` banners hide.
        if (b.targetAudience === "free") return false;

        return true;
      });
    }

    return {
      restrictionLevel,
      restrictionMessage,
      banners,
    };
  }
);

// ─── getTurnUsage (admin only) ───────────────────────────────────────────────

exports.getTurnUsage = onCall(
  { secrets: [cfAnalyticsToken] },
  async (request) => {
    if (!request.auth || request.auth.uid !== adminUid.value()) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const period = request.data?.period || "month";
    const token = cfAnalyticsToken.value();
    const accountId = cfAccountId.value();

    // Calculate date range
    const now = new Date();
    let since;
    if (period === "day") {
      since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (period === "week") {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      since = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    try {
      // Cloudflare TURN analytics via GraphQL
      const response = await fetch(
        "https://api.cloudflare.com/client/v4/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `{
              viewer {
                accounts(filter: { accountTag: "${accountId}" }) {
                  callsTurnUsageAdaptiveGroups(
                    filter: {
                      datetimeHour_geq: "${since.toISOString()}"
                      datetimeHour_leq: "${now.toISOString()}"
                    }
                    limit: 1000
                    orderBy: [datetimeHour_ASC]
                  ) {
                    dimensions {
                      datetimeHour
                    }
                    sum {
                      egressBytes
                      ingressBytes
                    }
                  }
                }
              }
            }`,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        console.error(`Cloudflare analytics error: ${response.status} ${text}`);
        throw new HttpsError("internal", "Cloudflare analytics API error");
      }

      const data = await response.json();

      if (data.errors && data.errors.length > 0) {
        console.error("Cloudflare GraphQL errors:", JSON.stringify(data.errors));
        throw new HttpsError(
          "internal",
          `Cloudflare API: ${data.errors[0].message}`
        );
      }

      const groups =
        data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];

      // Aggregate
      let totalEgressBytes = 0;
      let totalIngressBytes = 0;
      const daily = {};

      for (const g of groups) {
        totalEgressBytes += g.sum.egressBytes || 0;
        totalIngressBytes += g.sum.ingressBytes || 0;

        const day = g.dimensions.datetimeHour.substring(0, 10);
        if (!daily[day]) {
          daily[day] = { egressBytes: 0, ingressBytes: 0 };
        }
        daily[day].egressBytes += g.sum.egressBytes || 0;
        daily[day].ingressBytes += g.sum.ingressBytes || 0;
      }

      const totalBytes = totalEgressBytes + totalIngressBytes;
      return {
        period,
        totalEgressBytes,
        totalIngressBytes,
        totalBandwidthMB: Math.round(totalBytes / (1024 * 1024)),
        daily,
      };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(`getTurnUsage error: ${e.message}`);
      throw new HttpsError("internal", "Failed to fetch TURN usage data");
    }
  }
);

// ─── cacheTurnUsage (scheduled daily at 3:00 UTC) ────────────────────────────

exports.cacheTurnUsage = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "UTC",
    secrets: [cfAnalyticsToken],
    timeoutSeconds: 120,
  },
  async () => {
    const db = getFirestore();
    const accountId = cfAccountId.value();
    const token = cfAnalyticsToken.value();

    // Fetch yesterday's data
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateStr = yesterday.toISOString().substring(0, 10);
    const dayStart = new Date(dateStr + "T00:00:00Z");
    const dayEnd = new Date(dateStr + "T23:59:59Z");

    try {
      const response = await fetch(
        "https://api.cloudflare.com/client/v4/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `{
              viewer {
                accounts(filter: { accountTag: "${accountId}" }) {
                  callsTurnUsageAdaptiveGroups(
                    filter: {
                      datetimeHour_geq: "${dayStart.toISOString()}"
                      datetimeHour_leq: "${dayEnd.toISOString()}"
                    }
                    limit: 100
                  ) {
                    sum {
                      egressBytes
                      ingressBytes
                    }
                  }
                }
              }
            }`,
          }),
        }
      );

      if (!response.ok) {
        console.error(`cacheTurnUsage: Cloudflare API ${response.status}`);
        return;
      }

      const data = await response.json();
      const groups =
        data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];

      let egressBytes = 0;
      let ingressBytes = 0;

      for (const g of groups) {
        egressBytes += g.sum.egressBytes || 0;
        ingressBytes += g.sum.ingressBytes || 0;
      }

      // Store daily summary
      await db
        .collection("admin")
        .doc("turn_usage")
        .collection("daily")
        .doc(dateStr)
        .set({
          date: dateStr,
          egressBytes,
          ingressBytes,
          bandwidthMB: Math.round(
            (egressBytes + ingressBytes) / (1024 * 1024)
          ),
          cachedAt: FieldValue.serverTimestamp(),
        });

      // Update monthly aggregate
      const monthKey = dateStr.substring(0, 7);
      const monthDocs = await db
        .collection("admin")
        .doc("turn_usage")
        .collection("daily")
        .where("date", ">=", monthKey + "-01")
        .where("date", "<=", monthKey + "-31")
        .get();

      let monthBytes = 0;

      for (const doc of monthDocs.docs) {
        const d = doc.data();
        monthBytes += (d.egressBytes || 0) + (d.ingressBytes || 0);
      }

      await db
        .collection("admin")
        .doc("turn_usage")
        .set(
          {
            currentMonth: monthKey,
            monthBandwidthMB: Math.round(monthBytes / (1024 * 1024)),
            lastUpdated: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      console.log(
        `cacheTurnUsage: ${dateStr} — ${Math.round((egressBytes + ingressBytes) / (1024 * 1024))}MB (egress: ${egressBytes}, ingress: ${ingressBytes})`
      );
    } catch (e) {
      console.error(`cacheTurnUsage error: ${e.message}`);
    }
  }
);

// ─── cleanupStaleSessions ────────────────────────────────────────────────────

/**
 * Scheduled cleanup of stale sessions, pairings, and pairing codes.
 * Runs every 30 minutes.
 *
 * Retention policy (privacy: see Datenschutz / Privacy):
 * - Session documents: kept up to 24 hours after creation, then deleted
 *   (regardless of status). Active SDP/ICE candidate data is cleared by the
 *   client immediately after the WebRTC connection is established.
 * - Pairing_codes (ECDH meeting points): kept up to 24 hours.
 * - Pairings: kept up to 24 hours; ended pairings older than 1 hour are
 *   removed earlier to allow re-pairing.
 */
exports.cleanupStaleSessions = onSchedule(
  { schedule: "every 30 minutes", timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let deletedSessions = 0;
    let deletedPairingCodes = 0;
    let deletedPairings = 0;

    // 1. Delete sessions older than 24 hours (any status).
    const sessionsSnap = await db.collection("sessions").get();
    for (const doc of sessionsSnap.docs) {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate?.();

      if (createdAt && createdAt < oneDayAgo) {
        await deleteSubcollection(db, `sessions/${doc.id}/candidates_baby`);
        await deleteSubcollection(db, `sessions/${doc.id}/candidates_parent`);
        await doc.ref.delete();
        deletedSessions++;
      }
    }

    // 2. Delete pairing codes older than 24 hours.
    const pairingSnap = await db.collection("pairing_codes").get();
    for (const doc of pairingSnap.docs) {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate?.();

      if (createdAt && createdAt < oneDayAgo) {
        await doc.ref.delete();
        deletedPairingCodes++;
      }
    }

    // 3. Delete stale pairings (ended > 1 hour OR any > 24 hours)
    const pairingsSnap = await db.collection("pairings").get();
    for (const doc of pairingsSnap.docs) {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate?.();
      const updatedAt = data.updatedAt?.toDate?.();
      const status = data.status;

      const isEndedAndStale =
        status === "ended" && updatedAt && updatedAt < oneHourAgo;
      const isVeryOld = createdAt && createdAt < oneDayAgo;

      if (isEndedAndStale || isVeryOld) {
        await doc.ref.delete();
        deletedPairings++;
      }
    }

    // 4. Delete expired gift codes (per-doc expiresAt).
    let deletedGiftCodes = 0;
    const giftSnap = await db.collection("gift_codes").get();
    for (const doc of giftSnap.docs) {
      const data = doc.data();
      const expiresAt = data.expiresAt?.toDate?.();
      if (expiresAt && expiresAt < now) {
        await doc.ref.delete();
        deletedGiftCodes++;
      }
    }

    // 5. Delete campaign_redemptions older than 90 days.
    let deletedCampaignRedemptions = 0;
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const redempSnap = await db.collection("campaign_redemptions").get();
    for (const doc of redempSnap.docs) {
      const data = doc.data();
      const redeemedAt = data.redeemedAt?.toDate?.();
      if (redeemedAt && redeemedAt < ninetyDaysAgo) {
        await doc.ref.delete();
        deletedCampaignRedemptions++;
      }
    }

    console.log(
      `Cleanup: ${deletedSessions} sessions, ${deletedPairingCodes} pairing codes, ${deletedPairings} pairings, ${deletedGiftCodes} gift codes, ${deletedCampaignRedemptions} campaign redemptions deleted`
    );
  }
);

async function deleteSubcollection(db, path) {
  const snap = await db.collection(path).limit(500).get();
  if (snap.empty) return;

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  // Recurse if there were 500 docs (more may remain)
  if (snap.size === 500) {
    await deleteSubcollection(db, path);
  }
}

// ─── snapshotSessionStats (every 10 minutes) ─────────────────────────────────
//
// Records active session count + per-TURN-provider breakdown into
// /admin/session_stats/snapshots/{ts}. Consumed by the admin dashboard.
// Older snapshots (>30 days) are pruned in the same run.

const ACTIVE_SESSION_STATUSES = new Set(["waiting", "active", "connected"]);
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function bumpProvider(map, key) {
  const id = (key && String(key).trim()) || "unknown";
  map[id] = (map[id] || 0) + 1;
}

exports.snapshotSessionStats = onSchedule(
  { schedule: "every 10 minutes", timeoutSeconds: 120 },
  async () => {
    const db = getFirestore();
    const now = new Date();

    let total = 0;
    let connected = 0;
    let waiting = 0;
    let active = 0;
    let premium = 0;
    let free = 0;
    let connectionIssues = 0;
    let turnChanges = 0;
    const byBabyProvider = {};
    const byParentProvider = {};
    const byProvider = {}; // any side using a given provider (union)

    try {
      const snap = await db.collection("sessions").get();
      for (const doc of snap.docs) {
        const d = doc.data() || {};
        if (!ACTIVE_SESSION_STATUSES.has(d.status)) continue;
        total++;
        if (d.status === "connected") connected++;
        else if (d.status === "waiting") waiting++;
        else if (d.status === "active") active++;
        if (d.babyPremium === true || d.parentPremium === true) premium++;
        else free++;
        connectionIssues += Number(d.connectionInterruptionCount || 0);
        turnChanges += Number(d.turnChangeCount || 0);

        const babyP = d.babyTurnProvider;
        const parentP = d.parentTurnProvider;
        bumpProvider(byBabyProvider, babyP);
        bumpProvider(byParentProvider, parentP);

        const seen = new Set();
        if (babyP) seen.add(String(babyP));
        if (parentP) seen.add(String(parentP));
        if (seen.size === 0) seen.add("unknown");
        for (const p of seen) bumpProvider(byProvider, p);
      }

      const tsIso = now.toISOString();
      const docId = tsIso.replace(/[:.]/g, "-");
      await db
        .collection("admin")
        .doc("session_stats")
        .collection("snapshots")
        .doc(docId)
        .set({
          ts: now,
          total,
          connected,
          waiting,
          active,
          premium,
          free,
          connectionIssues,
          turnChanges,
          byProvider,
          byBabyProvider,
          byParentProvider,
        });

      // Update latest summary
      await db
        .collection("admin")
        .doc("session_stats")
        .set(
          {
            lastSnapshotAt: now,
            lastTotal: total,
            lastConnectionIssues: connectionIssues,
            lastTurnChanges: turnChanges,
            lastByProvider: byProvider,
          },
          { merge: true },
        );

      // Prune old snapshots
      const cutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_MS);
      const oldSnap = await db
        .collection("admin")
        .doc("session_stats")
        .collection("snapshots")
        .where("ts", "<", cutoff)
        .limit(500)
        .get();

      if (!oldSnap.empty) {
        const batch = db.batch();
        oldSnap.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }

      console.log(
        `[stats] snapshot: total=${total}, byProvider=${JSON.stringify(byProvider)}, pruned=${oldSnap.size}`,
      );
    } catch (e) {
      console.error(`snapshotSessionStats error: ${e.message}`);
    }
  },
);

// ─── getSessionStats (admin only) ────────────────────────────────────────────
//
// Returns recent session-stat snapshots for charting in the admin dashboard.

exports.getSessionStats = onCall({}, async (request) => {
  requireAdmin(request);
  requireAppCheck(request);

  const db = getFirestore();
  const hours = Math.max(
    1,
    Math.min(24 * 30, parseInt(request.data?.hours, 10) || 24),
  );
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const snap = await db
    .collection("admin")
    .doc("session_stats")
    .collection("snapshots")
    .where("ts", ">=", since)
    .orderBy("ts", "asc")
    .limit(2000)
    .get();

  const snapshots = snap.docs.map((doc) => {
    const d = doc.data() || {};
    return {
      id: doc.id,
      ts: d.ts?.toDate?.()?.toISOString() || null,
      total: d.total || 0,
      connected: d.connected || 0,
      waiting: d.waiting || 0,
      active: d.active || 0,
      premium: d.premium || 0,
      free: d.free || 0,
      connectionIssues: d.connectionIssues || 0,
      turnChanges: d.turnChanges || 0,
      byProvider: d.byProvider || {},
      byBabyProvider: d.byBabyProvider || {},
      byParentProvider: d.byParentProvider || {},
    };
  });

  return { hours, snapshots };
});

// ─── Referral / Entitlement system (Phase A) ─────────────────────────────────
// ─── Referral / Trial Extension system (v2: gift codes + campaigns) ─────────
//
// Collections:
//   /gift_codes/{nonce}           — single-use sharer→recipient codes (dual credit)
//   /campaign_codes/{slug}        — admin-curated multi-use ad codes
//   /campaign_redemptions/{id}    — per-purchase idempotency ledger for campaigns
//
// Play Store owns the trial. Codes call purchases.subscriptions.defer to add
// 30 days to next billing date. Idempotent via absolute desiredExpiryTimeMillis.

const { GoogleAuth } = require("google-auth-library");

const giftCodeHmacSecret = defineSecret("GIFT_CODE_HMAC_SECRET");
const playServiceAccountJson = defineSecret("PLAY_DEVELOPER_SERVICE_ACCOUNT_JSON");

const GIFT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GIFT_NONCE_LEN = 8;
const GIFT_HMAC_LEN = 4;
const GIFT_CODE_REGEX = /^TIMMY-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const CAMPAIGN_SLUG_REGEX = /^[A-Z0-9_-]{3,32}$/;
const PURCHASE_TOKEN_REGEX = /^[A-Za-z0-9._~+/=:-]{16,512}$/;
const SUBSCRIPTION_ID_REGEX = /^[a-z0-9._-]{3,64}$/;
const PACKAGE_NAME = "com.babymonitortimmy.app";
const GIFT_DEFER_DAYS = 30;
const GIFT_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const giftMintRateLimitMap = new Map();
const giftRedeemRateLimitMap = new Map();
const giftCheckRateLimitMap = new Map();
const campaignRedeemRateLimitMap = new Map();
const GIFT_MINT_MAX = 5;
const GIFT_REDEEM_MAX = 3;
const GIFT_CHECK_MAX = 60;
const CAMPAIGN_REDEEM_MAX = 3;

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }
}

function validateReceiptData(s) {
  if (typeof s !== "string" || s.length < 16 || s.length > 200000) {
    throw new HttpsError("invalid-argument", "Invalid receiptData");
  }
}

function randomFromAlphabet(len) {
  const out = [];
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    out.push(GIFT_CODE_ALPHABET[buf[i] % GIFT_CODE_ALPHABET.length]);
  }
  return out.join("");
}

function bytesToBase32Custom(bytes, len) {
  // Map bytes to GIFT_CODE_ALPHABET chars (32-symbol alphabet).
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(GIFT_CODE_ALPHABET[bytes[i] % GIFT_CODE_ALPHABET.length]);
  }
  return out.join("");
}

function computeGiftHmac(nonce, secret) {
  const mac = crypto.createHmac("sha256", secret).update(nonce).digest();
  return bytesToBase32Custom(mac, GIFT_HMAC_LEN);
}

function formatGiftCode(nonce, secret) {
  const hmac = computeGiftHmac(nonce, secret);
  return `TIMMY-${nonce}-${hmac}`;
}

function parseGiftCode(code, secret) {
  if (typeof code !== "string" || !GIFT_CODE_REGEX.test(code)) {
    throw new HttpsError("invalid-argument", "Invalid gift code format");
  }
  const parts = code.split("-");
  const nonce = parts[1];
  const expectedHmac = computeGiftHmac(nonce, secret);
  if (parts[2] !== expectedHmac) {
    throw new HttpsError("invalid-argument", "Invalid gift code checksum");
  }
  return nonce;
}

function validatePurchaseToken(t) {
  if (typeof t !== "string" || !PURCHASE_TOKEN_REGEX.test(t)) {
    throw new HttpsError("invalid-argument", "Invalid purchaseToken");
  }
}

function validateSubscriptionId(s) {
  if (typeof s !== "string" || !SUBSCRIPTION_ID_REGEX.test(s)) {
    throw new HttpsError("invalid-argument", "Invalid subscriptionId");
  }
}

function validateCampaignSlug(s) {
  if (typeof s !== "string" || !CAMPAIGN_SLUG_REGEX.test(s)) {
    throw new HttpsError("invalid-argument", "Invalid campaign slug");
  }
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ─── Play Developer API helpers ─────────────────────────────────────────────

let _playAuthClient = null;
let _playAuthClientLoadedAt = 0;
let _playServiceAccountEmail = "unknown-service-account";
const PLAY_AUTH_CACHE_MS = 50 * 60 * 1000;

function playApiPermissionHint(status) {
  const base =
    `Play API unauthorized (${status}) for ${_playServiceAccountEmail}. ` +
    "Grant this service account access to com.babymonitortimmy.app in Play Console -> Users and permissions";
  return status === 401 || status === 403 ?
    `${base} and enable \"View financial data\" for Purchases API access. ` +
    "\"Manage orders and subscriptions\" is still needed for gift/campaign defer flows." :
    null;
}

async function getPlayApiClient() {
  const now = Date.now();
  if (_playAuthClient && now - _playAuthClientLoadedAt < PLAY_AUTH_CACHE_MS) {
    return _playAuthClient;
  }
  const raw = playServiceAccountJson.value();
  if (!raw) {
    throw new HttpsError("failed-precondition", "Play service account not configured");
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new HttpsError("failed-precondition", "Play service account JSON malformed");
  }
  _playServiceAccountEmail = credentials.client_email || "unknown-service-account";
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  _playAuthClient = await auth.getClient();
  _playAuthClientLoadedAt = now;
  return _playAuthClient;
}

async function getPlaySubscription(packageName, subscriptionId, purchaseToken) {
  if (isDebugPurchaseToken(purchaseToken)) {
    console.warn("[GIFT][DEBUG-TOKEN] getPlaySubscription short-circuit", {
      packageName,
      subId: subscriptionId,
      tokenPrefix: purchaseToken.slice(0, 16),
    });
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    return { expiryTimeMillis: String(Date.now() + thirtyDays) };
  }
  const client = await getPlayApiClient();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await client.request({ url, method: "GET", validateStatus: () => true });
  if (res.status === 404 || res.status === 410) {
    throw new HttpsError("not-found", "Play subscription not found");
  }
  if (res.status >= 400) {
    console.error("[Play] getSubscription failed", res.status, res.data);
    const hint = playApiPermissionHint(res.status);
    throw new HttpsError(hint ? "failed-precondition" : "internal", hint || ("Play API error: " + res.status));
  }
  return res.data;
}

async function deferPlaySubscription(packageName, subscriptionId, purchaseToken, expectedExpiryMillis, desiredExpiryMillis) {
  if (isDebugPurchaseToken(purchaseToken)) {
    console.warn("[GIFT][DEBUG-TOKEN] deferPlaySubscription short-circuit", {
      packageName,
      subId: subscriptionId,
      tokenPrefix: purchaseToken.slice(0, 16),
      expectedExpiryMillis,
      desiredExpiryMillis,
    });
    return { newExpiryTimeMillis: String(desiredExpiryMillis) };
  }
  const client = await getPlayApiClient();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}:defer`;
  const body = {
    deferralInfo: {
      expectedExpiryTimeMillis: String(expectedExpiryMillis),
      desiredExpiryTimeMillis: String(desiredExpiryMillis),
    },
  };
  const res = await client.request({
    url,
    method: "POST",
    data: body,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    console.error("[Play] defer failed", res.status, res.data);
    const hint = playApiPermissionHint(res.status);
    throw new HttpsError(hint ? "failed-precondition" : "internal", hint || ("Play defer failed: " + res.status));
  }
  return res.data; // { newExpiryTimeMillis }
}

function readSubExpiryMillis(sub) {
  const v = sub && (sub.expiryTimeMillis || sub.expiryTime || sub.lineItems?.[0]?.expiryTime);
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  if (typeof v === "number") return v;
  // ISO fallback
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!isNaN(t)) return t;
  }
  return null;
}

async function verifyAppStoreSubscription(receiptData, subscriptionId) {
  if (isDebugPurchaseToken(receiptData)) {
    console.warn("[WEB-AUTH][DEBUG-TOKEN] App Store receipt short-circuit", {
      subId: subscriptionId,
      tokenPrefix: receiptData.slice(0, 16),
    });
    return { expiryMillis: Date.now() + 30 * 24 * 60 * 60 * 1000, source: "debug" };
  }

  const password = String(safeParamValue(appStoreSharedSecret) || "").trim();
  if (!password) {
    throw new HttpsError(
      "failed-precondition",
      "App Store shared secret is not configured"
    );
  }

  const body = {
    "receipt-data": receiptData,
    password,
    "exclude-old-transactions": true,
  };
  let response = await fetch("https://buy.itunes.apple.com/verifyReceipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = await response.json();
  if (json.status === 21007) {
    response = await fetch("https://sandbox.itunes.apple.com/verifyReceipt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    json = await response.json();
  }
  if (json.status !== 0) {
    throw new HttpsError("failed-precondition", `App Store receipt status ${json.status}`);
  }

  const latest = Array.isArray(json.latest_receipt_info)
    ? json.latest_receipt_info
    : [];
  const expiryMillis = latest
    .filter((item) => item.product_id === subscriptionId)
    .map((item) => Number(item.expires_date_ms || 0))
    .filter((expiry) => Number.isFinite(expiry))
    .sort((a, b) => b - a)[0];
  if (!expiryMillis || expiryMillis < Date.now()) {
    throw new HttpsError("failed-precondition", "App Store subscription is not active");
  }
  return { expiryMillis, source: "app-store" };
}

async function verifyPremiumProof(proof) {
  if (!proof || typeof proof !== "object") {
    throw new HttpsError("invalid-argument", "Premium proof required");
  }
  const platform = String(proof.platform || "").trim().toLowerCase();
  const subscriptionId = proof.subscriptionId || proof.productId || "timmy_support_monthly";
  validateSubscriptionId(subscriptionId);

  if (platform === "android") {
    const purchaseToken = proof.purchaseToken;
    validatePurchaseToken(purchaseToken);
    const sub = await getPlaySubscription(PACKAGE_NAME, subscriptionId, purchaseToken);
    const expiryMillis = readSubExpiryMillis(sub);
    if (!expiryMillis || expiryMillis < Date.now()) {
      throw new HttpsError("failed-precondition", "Play subscription is not active");
    }
    return { expiryMillis, source: isDebugPurchaseToken(purchaseToken) ? "debug" : "play" };
  }

  if (platform === "ios") {
    const receiptData = proof.receiptData || proof.purchaseToken;
    validateReceiptData(receiptData);
    return verifyAppStoreSubscription(receiptData, subscriptionId);
  }

  throw new HttpsError("invalid-argument", "Unsupported premium proof platform");
}

async function setClientClaims(uid, patch) {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const existing = user.customClaims || {};
  await auth.setCustomUserClaims(uid, { ...existing, ...patch });
}

function requireMobileClient(request) {
  requireAuth(request);
  if (request.auth.token?.clientType !== "mobile") {
    throw new HttpsError("permission-denied", "Mobile client claim required");
  }
}

async function writeActiveWebClientSession({
  mobileUid,
  webUid,
  webSessionId,
  pairingDocKey,
  premium,
}) {
  const db = getFirestore();
  const now = Date.now();
  const leaseExpiresAt = new Date(now + WEB_AUTH_LEASE_MS);
  const maxExpiresAt = new Date(now + WEB_AUTH_MAX_MS);
  const mobileRef = db.collection("web_client_mobiles").doc(mobileUid);
  const newSessionRef = db.collection("web_client_sessions").doc(webUid);

  await db.runTransaction(async (tx) => {
    const mobileSnap = await tx.get(mobileRef);
    const previousUid = mobileSnap.exists ? mobileSnap.get("activeWebUid") : null;
    if (previousUid && previousUid !== webUid) {
      tx.set(
        db.collection("web_client_sessions").doc(previousUid),
        {
          status: "revoked",
          revokedAt: FieldValue.serverTimestamp(),
          replacedByWebUid: webUid,
        },
        { merge: true }
      );
    }

    tx.set(newSessionRef, {
      status: "active",
      mobileUid,
      webUid,
      webSessionId,
      pairingDocKey,
      premiumSource: premium.source,
      premiumExpiresAt: new Date(premium.expiryMillis),
      authorizedAt: FieldValue.serverTimestamp(),
      refreshedAt: FieldValue.serverTimestamp(),
      leaseExpiresAt,
      maxExpiresAt,
    });
    tx.set(mobileRef, {
      activeWebUid: webUid,
      activeWebSessionId: webSessionId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  await setClientClaims(webUid, {
    clientType: "web",
    webSessionId,
  });

  return {
    leaseExpiresAtMillis: leaseExpiresAt.getTime(),
    maxExpiresAtMillis: maxExpiresAt.getTime(),
  };
}

exports.registerMobileClient = onCall(
  {},
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    if (isWebCompanionAppCheck(request)) {
      throw new HttpsError("permission-denied", "Web clients cannot register as mobile clients");
    }
    if (
      !checkRateLimit(
        clientAuthRateLimitMap,
        `mobile:${request.auth.uid}`,
        MOBILE_AUTH_RATE_LIMIT_MAX
      )
    ) {
      throw new HttpsError("resource-exhausted", "Too many mobile auth requests");
    }

    await setClientClaims(request.auth.uid, {
      clientType: "mobile",
    });
    return { ok: true, clientType: "mobile" };
  }
);

exports.authorizeWebClient = onCall(
  { secrets: [playServiceAccountJson] },
  async (request) => {
    requireAppCheck(request);
    requireMobileClient(request);
    if (
      !checkRateLimit(
        clientAuthRateLimitMap,
        `web:${request.auth.uid}`,
        WEB_ACCESS_RATE_LIMIT_MAX
      )
    ) {
      throw new HttpsError("resource-exhausted", "Too many web authorization requests");
    }

    const pairingDocKey = request.data?.pairingDocKey;
    const webUid = request.data?.webUid;
    const webSessionId = request.data?.webSessionId;
    validatePairingDocKey(pairingDocKey);
    validateUid(webUid, "webUid");
    validateWebField(webSessionId, "webSessionId");

    const premium = await verifyPremiumProof(request.data?.premiumProof);
    const session = await writeActiveWebClientSession({
      mobileUid: request.auth.uid,
      webUid,
      webSessionId,
      pairingDocKey,
      premium,
    });

    return {
      ok: true,
      webUid,
      webSessionId,
      premiumSource: premium.source,
      premiumExpiresAtMillis: premium.expiryMillis,
      ...session,
    };
  }
);

exports.refreshWebClientAuth = onCall(
  {},
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    const webSessionId = request.auth.token?.webSessionId;
    if (request.auth.token?.clientType !== "web" || typeof webSessionId !== "string") {
      throw new HttpsError("permission-denied", "Web client claim required");
    }

    const db = getFirestore();
    const ref = db.collection("web_client_sessions").doc(request.auth.uid);
    const snap = await ref.get();
    if (!snap.exists || snap.get("status") !== "active") {
      throw new HttpsError("permission-denied", "Web session is not active");
    }
    if (snap.get("webSessionId") !== webSessionId) {
      throw new HttpsError("permission-denied", "Web session was replaced");
    }

    const max = snap.get("maxExpiresAt");
    const maxMs = max?.toMillis ? max.toMillis() : 0;
    const nextMs = Math.min(Date.now() + WEB_AUTH_LEASE_MS, maxMs);
    if (!nextMs || nextMs <= Date.now()) {
      await ref.set({
        status: "expired",
        expiredAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw new HttpsError("permission-denied", "Web session expired");
    }

    await ref.set({
      refreshedAt: FieldValue.serverTimestamp(),
      leaseExpiresAt: new Date(nextMs),
    }, { merge: true });
    return { ok: true, leaseExpiresAtMillis: nextMs };
  }
);

// ─── mintGiftCode ────────────────────────────────────────────────────────────

exports.mintGiftCode = onCall(
  { secrets: [giftCodeHmacSecret, playServiceAccountJson] },
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    if (!checkRateLimit(giftMintRateLimitMap, request.auth.uid, GIFT_MINT_MAX)) {
      throw new HttpsError("resource-exhausted", "Too many mint requests");
    }

    const purchaseToken = request.data?.purchaseToken;
    const subscriptionId = request.data?.subscriptionId;
    validatePurchaseToken(purchaseToken);
    validateSubscriptionId(subscriptionId);

    // Verify the sharer really owns an active sub.
    const sub = await getPlaySubscription(PACKAGE_NAME, subscriptionId, purchaseToken);
    const expiry = readSubExpiryMillis(sub);
    if (!expiry || expiry < Date.now()) {
      throw new HttpsError("failed-precondition", "Sharer subscription is not active");
    }

    const secret = giftCodeHmacSecret.value();
    if (!secret) {
      throw new HttpsError("failed-precondition", "Gift HMAC secret not configured");
    }

    const db = getFirestore();
    const now = Date.now();
    const expiresAt = new Date(now + GIFT_CODE_TTL_MS);
    const testRunId = pickTestRunId(request, purchaseToken);

    // Try a few nonces until we find one that doesn't collide.
    for (let attempt = 0; attempt < 5; attempt++) {
      const nonce = randomFromAlphabet(GIFT_NONCE_LEN);
      const code = formatGiftCode(nonce, secret);
      const ref = db.collection("gift_codes").doc(nonce);
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists) {
            throw new Error("nonce-collision");
          }
          const doc = {
            mintedAt: FieldValue.serverTimestamp(),
            expiresAt,
            status: "active",
            sharerUid: request.auth.uid,
            sharerPackageName: PACKAGE_NAME,
            sharerSubscriptionId: subscriptionId,
            sharerPurchaseToken: purchaseToken,
            sharerDeferApplied: false,
            recipientPackageName: null,
            recipientSubscriptionId: null,
            recipientPurchaseToken: null,
            recipientDeferApplied: false,
            redeemedAt: null,
          };
          if (testRunId) doc.testRunId = testRunId;
          tx.set(ref, doc);
        });
        console.log(`[Gift] minted code=${code.substring(0, 12)}…`);
        return { code, expiresAt: expiresAt.toISOString() };
      } catch (e) {
        if (e && e.message === "nonce-collision") continue;
        throw e;
      }
    }
    throw new HttpsError("internal", "Failed to mint code");
  }
);

// ─── redeemGiftCode ──────────────────────────────────────────────────────────

exports.redeemGiftCode = onCall(
  { secrets: [giftCodeHmacSecret, playServiceAccountJson] },
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    if (!checkRateLimit(giftRedeemRateLimitMap, request.auth.uid, GIFT_REDEEM_MAX)) {
      throw new HttpsError("resource-exhausted", "Too many redemption attempts");
    }

    const code = request.data?.code;
    const purchaseToken = request.data?.purchaseToken;
    const subscriptionId = request.data?.subscriptionId;
    const secret = giftCodeHmacSecret.value();
    if (!secret) {
      throw new HttpsError("failed-precondition", "Gift HMAC secret not configured");
    }
    const nonce = parseGiftCode(code, secret);
    validatePurchaseToken(purchaseToken);
    validateSubscriptionId(subscriptionId);

    const db = getFirestore();
    const ref = db.collection("gift_codes").doc(nonce);

    // Verify recipient owns an active subscription.
    const recipientSub = await getPlaySubscription(PACKAGE_NAME, subscriptionId, purchaseToken);
    const recipientExpiry = readSubExpiryMillis(recipientSub);
    if (!recipientExpiry) {
      throw new HttpsError("failed-precondition", "Recipient subscription has no expiry");
    }
    if (recipientExpiry < Date.now()) {
      throw new HttpsError("failed-precondition", "Recipient subscription is not active");
    }

    // Snapshot read first to surface friendly errors.
    const preSnap = await ref.get();
    if (!preSnap.exists) {
      throw new HttpsError("not-found", "Gift code not found");
    }
    const preData = preSnap.data();
    if (preData.expiresAt && preData.expiresAt.toDate && preData.expiresAt.toDate() < new Date()) {
      throw new HttpsError("deadline-exceeded", "Gift code expired");
    }
    if (preData.status === "redeemed") {
      throw new HttpsError("already-exists", "Gift code already used");
    }
    if (preData.sharerPurchaseToken === purchaseToken) {
      throw new HttpsError("failed-precondition", "Cannot redeem own gift code");
    }
    if (preData.sharerUid && preData.sharerUid === request.auth.uid) {
      throw new HttpsError("failed-precondition", "Cannot redeem own gift code");
    }

    // Compute desired new expiry; defer recipient first inside txn-coupled flow.
    const desiredRecipientExpiry = recipientExpiry + GIFT_DEFER_DAYS * 24 * 60 * 60 * 1000;
    const playResult = await deferPlaySubscription(
      PACKAGE_NAME,
      subscriptionId,
      purchaseToken,
      recipientExpiry,
      desiredRecipientExpiry
    );

    // Mark redemption atomically.
    try {
      const testRunId = pickTestRunId(request, purchaseToken);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Gift code vanished");
        const d = snap.data();
        if (d.status === "redeemed") {
          throw new HttpsError("already-exists", "Gift code already used");
        }
        const update = {
          status: "redeemed",
          recipientUid: request.auth.uid,
          recipientPackageName: PACKAGE_NAME,
          recipientSubscriptionId: subscriptionId,
          recipientPurchaseToken: purchaseToken,
          recipientDeferApplied: true,
          redeemedAt: FieldValue.serverTimestamp(),
        };
        if (testRunId) update.recipientTestRunId = testRunId;
        tx.update(ref, update);
      });
    } catch (e) {
      console.error("[Gift] state flip failed after defer", e);
      throw e instanceof HttpsError ? e : new HttpsError("internal", "Redemption failed");
    }

    // Best-effort sharer defer.
    try {
      const sharerSub = await getPlaySubscription(
        PACKAGE_NAME,
        preData.sharerSubscriptionId,
        preData.sharerPurchaseToken
      );
      const sharerExpiry = readSubExpiryMillis(sharerSub);
      if (sharerExpiry && sharerExpiry > Date.now()) {
        const desiredSharerExpiry = sharerExpiry + GIFT_DEFER_DAYS * 24 * 60 * 60 * 1000;
        await deferPlaySubscription(
          PACKAGE_NAME,
          preData.sharerSubscriptionId,
          preData.sharerPurchaseToken,
          sharerExpiry,
          desiredSharerExpiry
        );
        await ref.update({ sharerDeferApplied: true });
      } else {
        console.warn("[Gift] sharer sub no longer active; skipping sharer defer");
      }
    } catch (e) {
      console.error("[Gift] sharer defer failed (non-fatal)", e);
    }

    return {
      ok: true,
      newExpiryMillis: playResult?.newExpiryTimeMillis
        ? parseInt(playResult.newExpiryTimeMillis, 10)
        : desiredRecipientExpiry,
    };
  }
);

// ─── checkGiftCodeStatus ─────────────────────────────────────────────────────

exports.checkGiftCodeStatus = onCall(
  { secrets: [giftCodeHmacSecret] },
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    if (!checkRateLimit(giftCheckRateLimitMap, request.auth.uid, GIFT_CHECK_MAX)) {
      throw new HttpsError("resource-exhausted", "Too many status checks");
    }
    const codes = Array.isArray(request.data?.codes) ? request.data.codes : [];
    if (codes.length > 50) {
      throw new HttpsError("invalid-argument", "Too many codes");
    }
    const secret = giftCodeHmacSecret.value();
    const db = getFirestore();
    const redeemed = [];
    for (const c of codes) {
      try {
        const nonce = parseGiftCode(c, secret);
        const snap = await db.collection("gift_codes").doc(nonce).get();
        if (snap.exists && snap.data().status === "redeemed") {
          redeemed.push(c);
        }
      } catch (_) {
        // Skip malformed
      }
    }
    return { redeemed };
  }
);

// ─── redeemCampaignCode ──────────────────────────────────────────────────────

exports.redeemCampaignCode = onCall(
  { secrets: [playServiceAccountJson] },
  async (request) => {
    requireAppCheck(request);
    requireAuth(request);
    if (!checkRateLimit(campaignRedeemRateLimitMap, request.auth.uid, CAMPAIGN_REDEEM_MAX)) {
      throw new HttpsError("resource-exhausted", "Too many redemption attempts");
    }

    const slug = request.data?.slug;
    const purchaseToken = request.data?.purchaseToken;
    const subscriptionId = request.data?.subscriptionId;
    validateCampaignSlug(slug);
    validatePurchaseToken(purchaseToken);
    validateSubscriptionId(subscriptionId);

    const db = getFirestore();
    const campaignRef = db.collection("campaign_codes").doc(slug);
    const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) {
      throw new HttpsError("not-found", "Campaign code not found");
    }
    const c = campaignSnap.data();
    if (!c.active) {
      throw new HttpsError("failed-precondition", "Campaign inactive");
    }
    if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < new Date()) {
      throw new HttpsError("deadline-exceeded", "Campaign expired");
    }
    if (c.maxRedemptions && (c.redemptionCount || 0) >= c.maxRedemptions) {
      throw new HttpsError("resource-exhausted", "Campaign limit reached");
    }
    const deferDays = c.deferDays > 0 ? c.deferDays : 30;

    const tokenHash = sha256Hex(purchaseToken);
    const redeemId = `${slug}_${tokenHash}`;
    const redeemRef = db.collection("campaign_redemptions").doc(redeemId);
    const existing = await redeemRef.get();
    if (existing.exists && existing.data().deferApplied) {
      return {
        ok: true,
        idempotent: true,
        deferDays,
        newExpiryMillis: existing.data().newExpiryMillis ?? null,
      };
    }

    // Verify the recipient sub is active.
    const sub = await getPlaySubscription(PACKAGE_NAME, subscriptionId, purchaseToken);
    const expiry = readSubExpiryMillis(sub);
    if (!expiry || expiry < Date.now()) {
      throw new HttpsError("failed-precondition", "Subscription not active");
    }
    const desired = expiry + deferDays * 24 * 60 * 60 * 1000;

    // Reserve idempotency record before defer.
    const testRunId = pickTestRunId(request, purchaseToken);
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(redeemRef);
      if (cur.exists && cur.data().deferApplied) {
        throw new Error("already-applied");
      }
      const doc = {
        slug,
        purchaseTokenSha256: tokenHash,
        redeemedAt: FieldValue.serverTimestamp(),
        deferApplied: false,
        newExpiryMillis: null,
      };
      if (testRunId) doc.testRunId = testRunId;
      tx.set(redeemRef, doc);
    }).catch((e) => {
      if (e && e.message === "already-applied") return;
      throw e;
    });

    const playResult = await deferPlaySubscription(
      PACKAGE_NAME,
      subscriptionId,
      purchaseToken,
      expiry,
      desired
    );
    const newExpiryMillis = playResult?.newExpiryTimeMillis
      ? parseInt(playResult.newExpiryTimeMillis, 10)
      : desired;

    await redeemRef.update({ deferApplied: true, newExpiryMillis });
    await campaignRef.update({ redemptionCount: FieldValue.increment(1) });

    return { ok: true, deferDays, newExpiryMillis };
  }
);

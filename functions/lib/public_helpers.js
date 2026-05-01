const CLOUDFLARE_TURN_BUILTIN_ID = "cloudflare-builtin";
const LOCAL_TURN_BUILTIN_ID = "local-turn-builtin";
const DEFAULT_LOCAL_TURN_TIMEOUT_MS = 1500;
const DEFAULT_LOCAL_TURN_TTL_SECONDS = 3600;
const DEBUG_TOKEN_PREFIX = "debug-e2e-";
const TEST_RUN_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function isDebugPurchaseToken(token, debugTokensAllowed = false) {
  return (
    debugTokensAllowed &&
    typeof token === "string" &&
    token.startsWith(DEBUG_TOKEN_PREFIX)
  );
}

function pickTestRunId(request, purchaseToken, debugTokensAllowed = false) {
  if (!debugTokensAllowed) return null;
  if (!isDebugPurchaseToken(purchaseToken, debugTokensAllowed)) return null;
  const id = request && request.data && request.data.testRunId;
  if (typeof id !== "string") return null;
  if (!TEST_RUN_ID_REGEX.test(id)) return null;
  return id;
}

function checkRateLimit(map, uid, max, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const entry = map.get(uid);

  if (!entry || now >= entry.resetAt) {
    map.set(uid, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= max) {
    return false;
  }

  entry.count++;
  return true;
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

function sanitizeTurnProvider(provider, options = {}) {
  const {
    cloudflareBuiltinId = CLOUDFLARE_TURN_BUILTIN_ID,
    localTurnBuiltinId = LOCAL_TURN_BUILTIN_ID,
    defaultLocalTurnTimeoutMs = DEFAULT_LOCAL_TURN_TIMEOUT_MS,
    defaultLocalTurnTtlSeconds = DEFAULT_LOCAL_TURN_TTL_SECONDS,
    now = () => Date.now(),
  } = options;

  if (!provider || typeof provider !== "object") {
    return null;
  }

  const id = String(provider.id || "").trim();
  const type = String(provider.type || "").trim();
  const name = String(provider.name || "").trim();
  const enabled = provider.enabled !== false;
  const priority = parsePositiveInt(provider.priority, 99);

  if (id === cloudflareBuiltinId || type === "cloudflare") {
    return {
      id: cloudflareBuiltinId,
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

  if (id === localTurnBuiltinId || type === "local-rest") {
    return {
      id: localTurnBuiltinId,
      name: name || "Lokaler TURN",
      type: "local-rest",
      enabled,
      priority,
      builtin: true,
      config: {
        urls: normalizeStringArray(provider.config?.urls),
        ttl: parsePositiveInt(
          provider.config?.ttl,
          defaultLocalTurnTtlSeconds
        ),
        timeoutMs: parsePositiveInt(
          provider.config?.timeoutMs,
          defaultLocalTurnTimeoutMs
        ),
      },
    };
  }

  if (type === "hmac-secret") {
    return {
      id: id || `turn-hmac-${now()}`,
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
      id: id || `turn-${now()}`,
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

module.exports = {
  CLOUDFLARE_TURN_BUILTIN_ID,
  LOCAL_TURN_BUILTIN_ID,
  DEFAULT_LOCAL_TURN_TIMEOUT_MS,
  DEFAULT_LOCAL_TURN_TTL_SECONDS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEBUG_TOKEN_PREFIX,
  TEST_RUN_ID_REGEX,
  checkRateLimit,
  isDebugPurchaseToken,
  normalizeStringArray,
  parsePositiveInt,
  pickTestRunId,
  renumberProviders,
  sanitizeTurnProvider,
};

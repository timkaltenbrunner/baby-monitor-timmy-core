const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOCAL_TURN_BUILTIN_ID,
  checkRateLimit,
  isDebugPurchaseToken,
  normalizeStringArray,
  parsePositiveInt,
  pickTestRunId,
  sanitizeTurnProvider,
} = require("../lib/public_helpers");

test("normalizeStringArray handles arrays and comma-separated strings", () => {
  assert.deepEqual(normalizeStringArray([" stun:a ", "", "turn:b "]), [
    "stun:a",
    "turn:b",
  ]);
  assert.deepEqual(normalizeStringArray(" stun:a, turn:b ,, "), [
    "stun:a",
    "turn:b",
  ]);
  assert.deepEqual(normalizeStringArray(null), []);
});

test("parsePositiveInt returns fallback for invalid values", () => {
  assert.equal(parsePositiveInt("7", 99), 7);
  assert.equal(parsePositiveInt("0", 99), 99);
  assert.equal(parsePositiveInt("-1", 99), 99);
  assert.equal(parsePositiveInt("abc", 99), 99);
});

test("debug token helpers stay disabled unless explicitly allowed", () => {
  const request = { data: { testRunId: "debug_run-1234" } };

  assert.equal(isDebugPurchaseToken("debug-e2e-token", false), false);
  assert.equal(isDebugPurchaseToken("debug-e2e-token", true), true);
  assert.equal(pickTestRunId(request, "debug-e2e-token", false), null);
  assert.equal(
    pickTestRunId(request, "debug-e2e-token", true),
    "debug_run-1234"
  );
  assert.equal(
    pickTestRunId({ data: { testRunId: "bad id" } }, "debug-e2e-token", true),
    null
  );
});

test("sanitizeTurnProvider normalizes local TURN providers", () => {
  const provider = sanitizeTurnProvider({
    id: LOCAL_TURN_BUILTIN_ID,
    type: "local-rest",
    enabled: true,
    priority: "2",
    config: {
      urls: " turn:timmy.example.org?transport=udp , turns:timmy.example.org ",
      ttl: "7200",
      timeoutMs: "2500",
    },
  });

  assert.deepEqual(provider, {
    id: LOCAL_TURN_BUILTIN_ID,
    name: "Lokaler TURN",
    type: "local-rest",
    enabled: true,
    priority: 2,
    builtin: true,
    config: {
      urls: [
        "turn:timmy.example.org?transport=udp",
        "turns:timmy.example.org",
      ],
      ttl: 7200,
      timeoutMs: 2500,
    },
  });
});

test("sanitizeTurnProvider assigns stable defaults to custom providers", () => {
  const provider = sanitizeTurnProvider(
    {
      type: "hmac-secret",
      config: {
        urls: ["turn:relay.timmy.example.org"],
        secret: " shared-secret ",
        realm: " timmy ",
      },
    },
    { now: () => 42 }
  );

  assert.deepEqual(provider, {
    id: "turn-hmac-42",
    name: "TURN (HMAC)",
    type: "hmac-secret",
    enabled: true,
    priority: 99,
    builtin: false,
    config: {
      urls: ["turn:relay.timmy.example.org"],
      secret: "shared-secret",
      ttl: 86400,
      realm: "timmy",
    },
  });
});

test("checkRateLimit enforces a rolling window", () => {
  const map = new Map();
  const options = { windowMs: 100 };

  assert.equal(checkRateLimit(map, "user-1", 2, { ...options, now: 0 }), true);
  assert.equal(checkRateLimit(map, "user-1", 2, { ...options, now: 50 }), true);
  assert.equal(checkRateLimit(map, "user-1", 2, { ...options, now: 60 }), false);
  assert.equal(
    checkRateLimit(map, "user-1", 2, { ...options, now: 101 }),
    true
  );
});

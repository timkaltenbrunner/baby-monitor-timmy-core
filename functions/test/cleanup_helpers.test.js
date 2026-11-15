const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldDeleteCleanupDoc } = require("../lib/cleanup_helpers");

test("cleanup keeps campaign redemption hash ledger indefinitely", () => {
  const now = new Date("2026-04-01T00:00:00Z");
  const oldRedemption = {
    redeemedAt: new Date("2025-01-01T00:00:00Z"),
    purchaseTokenHash: "hash-only-ledger-entry",
  };

  assert.equal(
    shouldDeleteCleanupDoc("campaign_redemptions", oldRedemption, now),
    false
  );
});

test("cleanup still deletes expired gift codes and stale session docs", () => {
  const now = new Date("2026-04-01T00:00:00Z");

  assert.equal(
    shouldDeleteCleanupDoc("gift_codes", {
      expiresAt: new Date("2026-03-31T23:59:59Z"),
    }, now),
    true
  );
  assert.equal(
    shouldDeleteCleanupDoc("sessions", {
      createdAt: new Date("2026-03-30T23:59:59Z"),
    }, now),
    true
  );
});

test("cleanup purges pairing_codes after 1h but keeps fresh ones", () => {
  const now = new Date("2026-04-01T00:00:00Z");

  // Older than 1h → delete (previously survived under the 24h threshold).
  assert.equal(
    shouldDeleteCleanupDoc("pairing_codes", {
      createdAt: new Date("2026-03-31T22:30:00Z"), // 90 min ago
    }, now),
    true
  );
  // Younger than 1h → keep (a live handshake must not be purged).
  assert.equal(
    shouldDeleteCleanupDoc("pairing_codes", {
      createdAt: new Date("2026-03-31T23:30:00Z"), // 30 min ago
    }, now),
    false
  );
  // Guard: the 1h threshold must NOT bleed into sessions (still 24h).
  assert.equal(
    shouldDeleteCleanupDoc("sessions", {
      createdAt: new Date("2026-03-31T22:30:00Z"), // 90 min ago
    }, now),
    false
  );
});

test("active pairing retention follows updatedAt rather than createdAt", () => {
  const now = new Date("2026-04-02T00:00:00Z");

  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T23:59:00Z"),
    }, now),
    false
  );
  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-03-31T23:59:59Z"),
    }, now),
    true
  );
});

test("fresh reset tombstone is retained", () => {
  const now = new Date("2026-04-02T00:00:00Z");

  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "reset",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T23:30:00Z"),
    }, now),
    false
  );
});

test("ended pairing expires after one hour from updatedAt", () => {
  const now = new Date("2026-04-02T00:00:00Z");

  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "ended",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T23:01:00Z"),
    }, now),
    false
  );
  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "ended",
      createdAt: new Date("2026-04-01T23:59:00Z"),
      updatedAt: new Date("2026-04-01T22:59:00Z"),
    }, now),
    true
  );
});

test("historical pairing without updatedAt falls back to createdAt", () => {
  const now = new Date("2026-04-02T00:00:00Z");

  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "selecting",
      createdAt: new Date("2026-03-31T23:59:59Z"),
    }, now),
    true
  );
  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "cancelled",
      createdAt: new Date("2026-04-01T23:59:00Z"),
    }, now),
    false
  );
  assert.equal(
    shouldDeleteCleanupDoc("pairings", {
      status: "ended",
      createdAt: new Date("2026-04-01T22:59:00Z"),
    }, now),
    true
  );
});

test("inventory finds only old legacy timestamps and scoped orphan candidates", async () => {
  const { inventory } = require("../scripts/firestore_cleanup_inventory");
  const now = new Date("2026-04-02T00:00:00Z");
  const prefix = "projects/baby-monitor-timmy/databases/(default)/documents/";
  const older = "2026-03-30T00:00:00.123456789Z";
  const fresh = "2026-04-01T23:00:00Z";
  const row = (path, updateTime, fields = {}) => ({ name: prefix + path, updateTime, fields });
  const responses = {
    sessions: [row("sessions/live", fresh), row("sessions/missing")],
    pairings: [row("pairings/good", older, {
      createdAt: { timestampValue: older }, updatedAt: { timestampValue: older },
    })],
    pairing_codes: [row("pairing_codes/old", older), row("pairing_codes/recent", fresh)],
    "sessions/missing/candidates_baby": [
      row("sessions/missing/candidates_baby/old", older),
      row("sessions/missing/candidates_baby/recent", fresh),
    ],
  };
  const client = {
    async request({ url }) {
      const parsed = new URL(url);
      const path = parsed.pathname.split("/documents/")[1];
      if (path === "sessions") assert.equal(parsed.searchParams.get("showMissing"), "true");
      return { data: { documents: responses[path] || [] } };
    },
  };
  const result = await inventory(client, now);
  assert.deepEqual(result.operations, [
    { kind: "orphan", path: "sessions/missing/candidates_baby/old", updateTime: older },
    { kind: "legacy", path: "pairing_codes/old", updateTime: older },
  ]);
});

test("cleanup manifest validation preserves update-time precision and limits target paths", () => {
  const { isOperation, timestampParts } = require("../scripts/firestore_cleanup_inventory");
  const updateTime = "2026-04-01T00:00:00.123456789Z";
  assert.deepEqual(timestampParts(updateTime), {
    seconds: Date.parse("2026-04-01T00:00:00Z") / 1000,
    nanoseconds: 123456789,
  });
  assert.equal(isOperation({ kind: "legacy", path: "pairing_codes/old", updateTime }), true);
  assert.equal(isOperation({ kind: "legacy", path: "campaign_redemptions/a", updateTime }), false);
  assert.equal(isOperation({ kind: "orphan", path: "sessions/a/other/b", updateTime }), false);
});

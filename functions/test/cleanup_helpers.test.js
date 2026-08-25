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

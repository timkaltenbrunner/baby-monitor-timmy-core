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

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_FUTURE_EXTENSION_DAYS,
  DAY_MS,
  hasReachedRedemptionLimit,
  maxAllowedFutureExpiryMillis,
  normalizeMaxFutureExtensionDays,
  wouldExceedFutureExpiryLimit,
} = require("../lib/referral_helpers");

test("normalizeMaxFutureExtensionDays falls back for invalid values", () => {
  assert.equal(
    normalizeMaxFutureExtensionDays(undefined),
    DEFAULT_MAX_FUTURE_EXTENSION_DAYS
  );
  assert.equal(
    normalizeMaxFutureExtensionDays("abc"),
    DEFAULT_MAX_FUTURE_EXTENSION_DAYS
  );
  assert.equal(normalizeMaxFutureExtensionDays("730"), 730);
});

test("hasReachedRedemptionLimit respects configured quota", () => {
  assert.equal(hasReachedRedemptionLimit(null, 10), false);
  assert.equal(hasReachedRedemptionLimit(50, 49), false);
  assert.equal(hasReachedRedemptionLimit(50, 50), true);
  assert.equal(hasReachedRedemptionLimit(50, 80), true);
});

test("future expiry helper allows exactly-at-limit and rejects beyond-limit", () => {
  const now = 1_700_000_000_000;
  const atLimit = maxAllowedFutureExpiryMillis(now, 600);
  const beyondLimit = atLimit + 1;

  assert.equal(
    wouldExceedFutureExpiryLimit(atLimit, 600, now),
    false
  );
  assert.equal(
    wouldExceedFutureExpiryLimit(beyondLimit, 600, now),
    true
  );
  assert.equal(
    maxAllowedFutureExpiryMillis(now, 365),
    now + 365 * DAY_MS
  );
});

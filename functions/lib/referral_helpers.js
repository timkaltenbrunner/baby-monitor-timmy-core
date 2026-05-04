const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FUTURE_EXTENSION_DAYS = 600;

function normalizeMaxFutureExtensionDays(
  rawValue,
  fallback = DEFAULT_MAX_FUTURE_EXTENSION_DAYS
) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxAllowedFutureExpiryMillis(
  nowMillis,
  maxFutureExtensionDays = DEFAULT_MAX_FUTURE_EXTENSION_DAYS
) {
  return nowMillis + normalizeMaxFutureExtensionDays(maxFutureExtensionDays) * DAY_MS;
}

function wouldExceedFutureExpiryLimit(
  desiredExpiryMillis,
  maxFutureExtensionDays = DEFAULT_MAX_FUTURE_EXTENSION_DAYS,
  nowMillis = Date.now()
) {
  if (!Number.isFinite(desiredExpiryMillis)) return true;
  return desiredExpiryMillis > maxAllowedFutureExpiryMillis(
    nowMillis,
    maxFutureExtensionDays
  );
}

function hasReachedRedemptionLimit(maxRedemptions, redemptionCount) {
  const max = Number.parseInt(String(maxRedemptions ?? ""), 10);
  if (!Number.isFinite(max) || max <= 0) return false;
  const count = Number.parseInt(String(redemptionCount ?? ""), 10);
  return (Number.isFinite(count) ? count : 0) >= max;
}

module.exports = {
  DAY_MS,
  DEFAULT_MAX_FUTURE_EXTENSION_DAYS,
  hasReachedRedemptionLimit,
  maxAllowedFutureExpiryMillis,
  normalizeMaxFutureExtensionDays,
  wouldExceedFutureExpiryLimit,
};

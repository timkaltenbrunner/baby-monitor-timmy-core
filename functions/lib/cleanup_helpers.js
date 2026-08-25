"use strict";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function toDate(value) {
  const date = value?.toDate?.() || (value instanceof Date ? value : null);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function olderThan(value, cutoff) {
  const date = toDate(value);
  return Boolean(date && date < cutoff);
}

function shouldDeleteCleanupDoc(collection, data = {}, now = new Date()) {
  const oneHourAgo = new Date(now.getTime() - HOUR_MS);
  const oneDayAgo = new Date(now.getTime() - DAY_MS);

  switch (collection) {
    case "sessions":
      return olderThan(data.createdAt, oneDayAgo);
    case "pairing_codes":
      // Meeting points are only live during the seconds-long ECDH handshake.
      // Purge after 1h so a day of testing can't accumulate dozens of stale
      // docs that pollute Nearby discovery (bogus SAS on a re-pair).
      return olderThan(data.createdAt, oneHourAgo);
    case "pairings":
      if (data.status === "ended") {
        return olderThan(data.updatedAt ?? data.createdAt, oneHourAgo);
      }
      // Pairings represent long-lived saved connections. Keep any non-ended
      // pairing for 24 hours after its latest activity so an active monitoring
      // session is never deleted merely because the devices were paired long
      // ago. The createdAt fallback only covers historical/synthetic records;
      // production clients already write updatedAt.
      return olderThan(data.updatedAt ?? data.createdAt, oneDayAgo);
    case "gift_codes":
      return olderThan(data.expiresAt, now);
    case "campaign_redemptions":
      return false;
    default:
      return false;
  }
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  shouldDeleteCleanupDoc,
};

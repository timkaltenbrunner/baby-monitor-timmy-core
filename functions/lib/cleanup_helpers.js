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
    case "pairing_codes":
      return olderThan(data.createdAt, oneDayAgo);
    case "pairings":
      return (
        (data.status === "ended" && olderThan(data.updatedAt, oneHourAgo)) ||
        olderThan(data.createdAt, oneDayAgo)
      );
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

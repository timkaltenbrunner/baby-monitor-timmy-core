"use strict";

const crypto = require("crypto");

const ANALYTICS_TIME_ZONE = "Europe/Zurich";
const SEGMENT_RETENTION_DAYS = 35;
const AGGREGATE_RETENTION_DAYS = 365;
const NORMAL_RECONNECT_GAP_MS = 3 * 60 * 1000;
const FULL_RECONNECT_GAP_MS = 10 * 60 * 1000;
const MAX_RAW_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

const CLASSIFICATIONS = new Set([
  "likely_real",
  "test",
  "uncertain",
  "unclassified",
]);

function timestampToMs(value) {
  const date = value?.toDate?.() || (value instanceof Date ? value : null);
  if (date && Number.isFinite(date.getTime())) return date.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
  }
  return null;
}

function toDate(value) {
  const ms = timestampToMs(value);
  return ms === null ? null : new Date(ms);
}

function minDate(...values) {
  const times = values.map(timestampToMs).filter((value) => value !== null);
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

function maxDate(...values) {
  const times = values.map(timestampToMs).filter((value) => value !== null);
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

function addUtcDays(day, amount) {
  const [year, month, date] = String(day).split("-").map(Number);
  if (![year, month, date].every(Number.isInteger)) return null;
  const shifted = new Date(Date.UTC(year, month - 1, date + amount));
  return shifted.toISOString().slice(0, 10);
}

function formatDayInZurich(value) {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ANALYTICS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Converts a Zurich civil time to an instant without relying on the host's
// timezone. The short fixed-point iteration also handles the DST boundaries.
function zurichCivilToDate(day, hour = 0, minute = 0, second = 0) {
  const [year, month, date] = String(day).split("-").map(Number);
  if (![year, month, date, hour, minute, second].every(Number.isInteger)) {
    return null;
  }
  const desiredAsUtc = Date.UTC(year, month - 1, date, hour, minute, second);
  let candidate = desiredAsUtc;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ANALYTICS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value])
    );
    const displayedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const delta = displayedAsUtc - desiredAsUtc;
    candidate -= delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

function getZurichDayRange(day) {
  const start = zurichCivilToDate(day);
  const nextDay = addUtcDays(day, 1);
  const end = nextDay ? zurichCivilToDate(nextDay) : null;
  if (!start || !end) return null;
  return { start, end };
}

function normalizePremium(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "missing";
}

function mergePremium(previous, next) {
  if (previous === "true" || next === "true") return "true";
  if (previous === "false" || next === "false") return "false";
  return "missing";
}

function normalizeAnalyticsSecret(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 128) return null;
  // Never trim: trigger and backfill must hash byte-for-byte identical secret
  // material. Whitespace usually means a trailing stdin newline at secret set.
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

function qualityEvidence(data = {}) {
  const events = Array.isArray(data.qualityEventsTail)
    ? data.qualityEventsTail
    : [];
  let fullReconnect = false;
  let explicitUserEnd = false;
  let latestEventAt = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "full_reconnect") fullReconnect = true;
    if (event.type === "session_end" && event.reason === "user") {
      explicitUserEnd = true;
    }
    latestEventAt = maxDate(latestEventAt, event.timestamp, event.at);
  }
  return { fullReconnect, explicitUserEnd, latestEventAt };
}

function hasActiveTurn(data = {}) {
  return [
    data.babyActiveTurnUrl,
    data.babyActiveTurnProvider,
    data.parentActiveTurnUrl,
    data.parentActiveTurnProvider,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}

function relevantProjection(data = {}) {
  const quality = qualityEvidence(data);
  return {
    pairingDocKey: typeof data.pairingDocKey === "string" ? data.pairingDocKey : "",
    createdAt: timestampToMs(data.createdAt),
    status: String(data.status || ""),
    signalingClearedAt: timestampToMs(data.signalingClearedAt),
    activeTurnObserved: hasActiveTurn(data),
    babyPremium: normalizePremium(data.babyPremium),
    parentPremium: normalizePremium(data.parentPremium),
    fullReconnect: quality.fullReconnect,
    explicitUserEnd: quality.explicitUserEnd,
  };
}

// Keeps only fields needed by the short in-memory capture debounce. In
// particular, SDP/ICE, TURN addresses and quality-event detail payloads are
// discarded immediately rather than retained until the coalesced write.
function sanitizeSessionAnalyticsSource(data = {}) {
  const qualityEventsTail = Array.isArray(data.qualityEventsTail)
    ? data.qualityEventsTail.map((event) => ({
      type: event?.type,
      reason: event?.reason,
      timestamp: event?.timestamp,
      at: event?.at,
    }))
    : [];
  return {
    pairingDocKey: data.pairingDocKey,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    status: data.status,
    signalingClearedAt: data.signalingClearedAt,
    babyPremium: data.babyPremium,
    parentPremium: data.parentPremium,
    // Presence is the only analytical fact retained; addresses/providers are
    // deliberately replaced with a constant marker.
    ...(hasActiveTurn(data) ? { babyActiveTurnProvider: "observed" } : {}),
    qualityEventsTail,
  };
}

function hasRelevantSessionChange(before, after) {
  if (!before) return true;
  return JSON.stringify(relevantProjection(before)) !== JSON.stringify(relevantProjection(after));
}

function pseudonymizePairing(pairingDocKey, secret, keyVersion) {
  if (typeof pairingDocKey !== "string" || pairingDocKey.length === 0) return null;
  const normalizedSecret = normalizeAnalyticsSecret(secret);
  if (!normalizedSecret) return null;
  if (!Number.isInteger(keyVersion) || keyVersion < 1) return null;
  return crypto
    .createHmac("sha256", normalizedSecret)
    .update(`v${keyVersion}:pairing:${pairingDocKey}`)
    .digest("hex");
}

function buildReviewId(pairingId) {
  return crypto.createHash("sha256").update(`review:${pairingId}`).digest("hex").slice(0, 16);
}

function buildSegmentProjection(data, options = {}) {
  const observedAt = toDate(options.sourceUpdateTime);
  if (!observedAt || !options.pairingId) return null;
  // Firestore's document update time is server-observed. Client-writable
  // timestamps may refine the start only inside the raw document's 24-hour
  // lifetime; they can never move analytics into the future or evade TTL.
  const rawCreatedAt = toDate(data?.createdAt);
  const createdAt = rawCreatedAt &&
    rawCreatedAt.getTime() <= observedAt.getTime() &&
    rawCreatedAt.getTime() >= observedAt.getTime() - MAX_RAW_SESSION_AGE_MS
    ? rawCreatedAt
    : observedAt;
  const quality = qualityEvidence(data);
  const signalingClearedAt = toDate(data?.signalingClearedAt);
  const everConnected = data?.status === "connected";
  const activeTurnObserved = hasActiveTurn(data);
  // The evidence value is existing client data, but its analytical time is the
  // trusted instant at which Firestore observed that value.
  const successAt = signalingClearedAt || everConnected || activeTurnObserved
    ? observedAt
    : null;
  const lastRelevantAt = observedAt;
  return {
    pairingId: options.pairingId,
    reviewId: buildReviewId(options.pairingId),
    keyVersion: options.keyVersion,
    createdAt,
    createdDay: formatDayInZurich(createdAt),
    lastRelevantAt,
    successAt,
    successDay: successAt ? formatDayInZurich(successAt) : null,
    everConnected,
    signalingCleared: Boolean(signalingClearedAt),
    activeTurnObserved,
    babyPremium: normalizePremium(data?.babyPremium),
    parentPremium: normalizePremium(data?.parentPremium),
    fullReconnect: quality.fullReconnect,
    explicitUserEnd: quality.explicitUserEnd,
    captureSource: options.captureSource === "backfill" ? "backfill" : "live",
    sourceUpdateTime: observedAt,
  };
}

function derivedSegmentDays(segment) {
  const createdDay = formatDayInZurich(segment.createdAt);
  const successDay = segment.successAt ? formatDayInZurich(segment.successAt) : null;
  const lastRelevantDay = formatDayInZurich(segment.lastRelevantAt);
  const continuedDays = [];
  if (createdDay && lastRelevantDay && createdDay < lastRelevantDay) {
    const firstContinuedDay = addUtcDays(createdDay, 1);
    const retainedWindowStart = addUtcDays(
      lastRelevantDay,
      -(SEGMENT_RETENTION_DAYS - 1)
    );
    const firstIndexedDay = firstContinuedDay > retainedWindowStart
      ? firstContinuedDay
      : retainedWindowStart;
    for (
      let day = firstIndexedDay;
      day && day <= lastRelevantDay && continuedDays.length < SEGMENT_RETENTION_DAYS;
      day = addUtcDays(day, 1)
    ) {
      continuedDays.push(day);
    }
  }
  return { ...segment, createdDay, successDay, continuedDays };
}

function mergeSegment(existing, incoming) {
  if (!existing) return derivedSegmentDays(incoming);
  const existingUpdateMs = timestampToMs(existing.sourceUpdateTime) || 0;
  const incomingUpdateMs = timestampToMs(incoming.sourceUpdateTime) || 0;
  const incomingIsOlder = incomingUpdateMs < existingUpdateMs;
  const promotedToPaired = !existing.pairingId && Boolean(incoming.pairingId);

  const successAt = minDate(existing.successAt, incoming.successAt);
  const merged = {
    pairingId: promotedToPaired ? incoming.pairingId : (existing.pairingId || incoming.pairingId),
    reviewId: promotedToPaired ? incoming.reviewId : (existing.reviewId || incoming.reviewId),
    keyVersion: promotedToPaired ? incoming.keyVersion : (existing.keyVersion || incoming.keyVersion),
    createdAt: minDate(existing.createdAt, incoming.createdAt),
    lastRelevantAt: maxDate(existing.lastRelevantAt, incoming.lastRelevantAt),
    successAt,
    everConnected: existing.everConnected === true || incoming.everConnected === true,
    signalingCleared: existing.signalingCleared === true || incoming.signalingCleared === true,
    activeTurnObserved: existing.activeTurnObserved === true || incoming.activeTurnObserved === true,
    babyPremium: mergePremium(existing.babyPremium, incoming.babyPremium),
    parentPremium: mergePremium(existing.parentPremium, incoming.parentPremium),
    fullReconnect: existing.fullReconnect === true || incoming.fullReconnect === true,
    explicitUserEnd: existing.explicitUserEnd === true || incoming.explicitUserEnd === true,
    captureSource:
      existing.captureSource === "live" || incoming.captureSource === "live"
        ? "live"
        : "backfill",
    captureStatus: existing.pairingId || incoming.pairingId
      ? "materialized"
      : "invalid_source",
    // An older delivery may still add monotone evidence (for example an
    // observed `connected` snapshot arriving after a newer `ended` snapshot),
    // but it can never move the source version backwards.
    sourceUpdateTime: incomingIsOlder
      ? toDate(existing.sourceUpdateTime)
      : maxDate(existing.sourceUpdateTime, incoming.sourceUpdateTime),
  };
  return derivedSegmentDays(merged);
}

function segmentEvidenceSignature(segment) {
  if (!segment) return "";
  return JSON.stringify({
    pairingId: segment.pairingId,
    keyVersion: segment.keyVersion,
    createdAt: timestampToMs(segment.createdAt),
    lastRelevantAt: timestampToMs(segment.lastRelevantAt),
    successAt: timestampToMs(segment.successAt),
    everConnected: segment.everConnected === true,
    signalingCleared: segment.signalingCleared === true,
    activeTurnObserved: segment.activeTurnObserved === true,
    babyPremium: segment.babyPremium,
    parentPremium: segment.parentPremium,
    fullReconnect: segment.fullReconnect === true,
    explicitUserEnd: segment.explicitUserEnd === true,
    captureSource: segment.captureSource,
    captureStatus: segment.captureStatus || "materialized",
    continuedDays: Array.isArray(segment.continuedDays) ? segment.continuedDays : [],
  });
}

function isSuccessfulSegment(segment) {
  return Boolean(
    segment?.signalingCleared || segment?.everConnected || segment?.activeTurnObserved
  );
}

function groupSegments(segments) {
  const byPairing = new Map();
  for (const segment of segments || []) {
    if (!segment?.pairingId || timestampToMs(segment.createdAt) === null) continue;
    if (!byPairing.has(segment.pairingId)) byPairing.set(segment.pairingId, []);
    byPairing.get(segment.pairingId).push(segment);
  }
  const groups = [];
  for (const [pairingId, entries] of byPairing) {
    entries.sort((a, b) => timestampToMs(a.createdAt) - timestampToMs(b.createdAt));
    let current = null;
    for (const segment of entries) {
      const createdMs = timestampToMs(segment.createdAt);
      if (!current) {
        current = { pairingId, segments: [segment] };
        groups.push(current);
        continue;
      }
      const previous = current.segments[current.segments.length - 1];
      const previousRelevantMs = timestampToMs(previous.lastRelevantAt) ?? timestampToMs(previous.createdAt);
      const groupRelevantMs = Math.max(
        ...current.segments.map((entry) =>
          timestampToMs(entry.lastRelevantAt) ?? timestampToMs(entry.createdAt)
        )
      );
      const normalReconnect = createdMs - groupRelevantMs <= NORMAL_RECONNECT_GAP_MS;
      const observedFullReconnect = previous.fullReconnect === true &&
        createdMs - previousRelevantMs <= FULL_RECONNECT_GAP_MS;
      if (!previous.explicitUserEnd && (normalReconnect || observedFullReconnect)) {
        current.segments.push(segment);
      } else {
        current = { pairingId, segments: [segment] };
        groups.push(current);
      }
    }
  }
  return groups.map((group) => {
    const successful = group.segments.filter(isSuccessfulSegment);
    const successAt = minDate(...successful.map((segment) => segment.successAt));
    const hasPremium = group.segments.some(
      (segment) => segment.babyPremium === "true" || segment.parentPremium === "true"
    );
    const hasExplicitTrial = successful.some(
      (segment) => segment.babyPremium === "false" && segment.parentPremium === "false"
    );
    return {
      ...group,
      successful: successful.length > 0,
      successAt,
      successDay: successAt ? formatDayInZurich(successAt) : null,
      access: hasPremium ? "premium" : (hasExplicitTrial ? "trial" : "unknown"),
    };
  });
}

function classifyPairingDay(metrics) {
  const rawDocuments = Number(metrics.rawDocuments || 0);
  const successfulRuns = Number(metrics.successfulRuns || 0);
  const shortGapRatio = Number(metrics.shortGapRatio || 0);
  const rules = [];
  if (rawDocuments >= 100) rules.push("raw_documents_gte_100");
  if (successfulRuns >= 20) rules.push("successful_runs_gte_20");
  if (rawDocuments >= 40 && successfulRuns >= 10) {
    rules.push("raw_documents_gte_40_and_successful_runs_gte_10");
  }
  if (rules.length > 0) return { classification: "test", rules };

  if (rawDocuments >= 20) rules.push("raw_documents_gte_20");
  if (successfulRuns >= 8) rules.push("successful_runs_gte_8");
  const gaps = Math.max(0, rawDocuments - 1);
  const requiredShortGaps = Math.ceil(0.7 * gaps);
  if (
    rawDocuments >= 10 &&
    Number(metrics.shortGaps || 0) >= requiredShortGaps &&
    shortGapRatio >= 0.7
  ) {
    rules.push("raw_documents_gte_10_and_short_gap_ratio_gte_70pct");
  }
  if (rules.length > 0) return { classification: "uncertain", rules };
  return { classification: "likely_real", rules: ["no_exclusion_rule_matched"] };
}

function findOverride(overrides, pairingId, day) {
  return (overrides || [])
    .filter((override) => {
      if (!override || override.pairingId !== pairingId) return false;
      if (override.effectiveFromDay > day) return false;
      if (override.effectiveToDay && override.effectiveToDay < day) return false;
      return ["test", "likely_real", "auto"].includes(override.classification);
    })
    .sort((a, b) => {
      const aMs = timestampToMs(a.createdAt) || 0;
      const bMs = timestampToMs(b.createdAt) || 0;
      return bMs - aMs;
    })[0] || null;
}

function buildPairingDaySummaries(segments, targetDay, options = {}) {
  const autoExclusionEnabled = options.autoExclusionEnabled === true;
  const grouped = groupSegments(segments);
  const pairingIds = new Set();
  for (const segment of segments || []) {
    if (segment?.pairingId &&
      (segment.createdDay === targetDay || segment.successDay === targetDay)) {
      pairingIds.add(segment.pairingId);
    }
  }

  const summaries = [];
  for (const pairingId of pairingIds) {
    const raw = (segments || [])
      .filter((segment) => segment.pairingId === pairingId && segment.createdDay === targetDay)
      .sort((a, b) => timestampToMs(a.createdAt) - timestampToMs(b.createdAt));
    const successfulGroups = grouped.filter(
      (group) => group.pairingId === pairingId && group.successful && group.successDay === targetDay
    );
    let shortGaps = 0;
    for (let i = 1; i < raw.length; i++) {
      if (timestampToMs(raw[i].createdAt) - timestampToMs(raw[i - 1].createdAt) <= NORMAL_RECONNECT_GAP_MS) {
        shortGaps++;
      }
    }
    const gapCount = Math.max(0, raw.length - 1);
    const metrics = {
      rawDocuments: raw.length,
      successfulRuns: successfulGroups.length,
      shortGaps,
      gapCount,
      shortGapRatio: gapCount > 0 ? shortGaps / gapCount : 0,
    };
    const automatic = classifyPairingDay(metrics);
    const override = findOverride(options.overrides, pairingId, targetDay);
    let effectiveClassification;
    if (override && override.classification !== "auto") {
      effectiveClassification = override.classification;
    } else if (autoExclusionEnabled) {
      effectiveClassification = automatic.classification;
    } else {
      effectiveClassification = "unclassified";
    }
    summaries.push({
      day: targetDay,
      pairingId,
      reviewId: buildReviewId(pairingId),
      ...metrics,
      premiumRuns: successfulGroups.filter((group) => group.access === "premium").length,
      trialRuns: successfulGroups.filter((group) => group.access === "trial").length,
      unknownAccessRuns: successfulGroups.filter((group) => group.access === "unknown").length,
      automaticClassification: automatic.classification,
      automaticRules: automatic.rules,
      effectiveClassification,
      overrideId: override?.id || null,
      overrideClassification: override?.classification || null,
      overrideReason: override?.reason || null,
      backfillSegments: raw.filter((segment) => segment.captureSource === "backfill").length,
    });
  }

  summaries.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  const daily = {
    day: targetDay,
    likelyReal: { premium: 0, trial: 0, unknown: 0, total: 0 },
    test: 0,
    uncertain: 0,
    unclassified: 0,
    successfulRuns: 0,
    rawDocuments: 0,
    pairingDays: summaries.length,
    backfillSegments: 0,
    activeOverrides: 0,
  };
  for (const summary of summaries) {
    daily.rawDocuments += summary.rawDocuments;
    daily.successfulRuns += summary.successfulRuns;
    daily.backfillSegments += summary.backfillSegments;
    if (summary.overrideId) daily.activeOverrides++;
    if (summary.effectiveClassification === "likely_real") {
      daily.likelyReal.premium += summary.premiumRuns;
      daily.likelyReal.trial += summary.trialRuns;
      daily.likelyReal.unknown += summary.unknownAccessRuns;
      daily.likelyReal.total += summary.successfulRuns;
    } else if (CLASSIFICATIONS.has(summary.effectiveClassification)) {
      daily[summary.effectiveClassification] += summary.successfulRuns;
    }
  }
  const knownAccess = daily.likelyReal.premium + daily.likelyReal.trial;
  daily.premiumShare = knownAccess > 0 ? daily.likelyReal.premium / knownAccess : null;
  daily.backfillShare = daily.rawDocuments > 0
    ? daily.backfillSegments / daily.rawDocuments
    : 0;
  return { summaries, daily };
}

function parseAnalyticsConfig(data = {}) {
  const keyVersion = data.hmacKeyVersion;
  const switchNames = [
    "captureEnabled",
    "aggregationEnabled",
    "autoExclusionEnabled",
    "adminVisible",
  ];
  const valid = switchNames.every((name) => typeof data[name] === "boolean") &&
    Number.isInteger(keyVersion) && keyVersion > 0;
  if (!valid) {
    return {
      captureEnabled: false,
      aggregationEnabled: false,
      autoExclusionEnabled: false,
      adminVisible: false,
      hmacKeyVersion: null,
    };
  }
  return {
    captureEnabled: data.captureEnabled,
    aggregationEnabled: data.aggregationEnabled,
    autoExclusionEnabled: data.autoExclusionEnabled,
    adminVisible: data.adminVisible,
    hmacKeyVersion: keyVersion,
  };
}

module.exports = {
  AGGREGATE_RETENTION_DAYS,
  ANALYTICS_TIME_ZONE,
  CLASSIFICATIONS,
  FULL_RECONNECT_GAP_MS,
  NORMAL_RECONNECT_GAP_MS,
  SEGMENT_RETENTION_DAYS,
  addUtcDays,
  buildPairingDaySummaries,
  buildReviewId,
  buildSegmentProjection,
  classifyPairingDay,
  formatDayInZurich,
  getZurichDayRange,
  groupSegments,
  hasRelevantSessionChange,
  isSuccessfulSegment,
  maxDate,
  mergeSegment,
  normalizeAnalyticsSecret,
  parseAnalyticsConfig,
  pseudonymizePairing,
  sanitizeSessionAnalyticsSource,
  segmentEvidenceSignature,
  timestampToMs,
  toDate,
  zurichCivilToDate,
};

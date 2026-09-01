"use strict";

const crypto = require("crypto");
const {
  AGGREGATE_RETENTION_DAYS,
  FULL_RECONNECT_GAP_MS,
  NORMAL_RECONNECT_GAP_MS,
  SEGMENT_RETENTION_DAYS,
  addUtcDays,
  buildPairingDaySummaries,
  buildSegmentProjection,
  formatDayInZurich,
  getZurichDayRange,
  groupSegments,
  isSuccessfulSegment,
  mergeSegment,
  parseAnalyticsConfig,
  pseudonymizePairing,
  segmentEvidenceSignature,
  timestampToMs,
  toDate,
} = require("./session_analytics_helpers");

const COLLECTIONS = Object.freeze({
  segments: "session_analytics_segments",
  pairingDays: "session_analytics_pairing_days",
  daily: "session_analytics_daily",
  overrides: "session_analytics_overrides",
  audit: "session_analytics_override_audit",
  rebuildJobs: "session_analytics_rebuild_jobs",
  dirtyDays: "session_analytics_dirty_days",
  dayLeases: "session_analytics_day_leases",
});

const CONFIG_PATH = "admin/session_analytics_config";
const MAX_PAIRING_DAYS_PER_DAY = 500;
const MAX_SEGMENTS_PER_DAY = 5000;
const MAX_OVERRIDES = 500;
const REBUILD_CHUNK_DAYS = 14;
const REBUILD_LEASE_MS = 15 * 60 * 1000;
const DAY_LEASE_MS = 15 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 400;
const MAX_CLEANUP_PER_COLLECTION = 5000;
const RETENTION_DELETE_BUFFER_DAYS = 1;
const SUCCESSOR_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

function adminFirestoreSymbols() {
  // Lazy so pure helper/unit tests do not need the production Admin SDK loaded.
  return require("firebase-admin/firestore");
}

function addDaysToDate(value, days) {
  const date = toDate(value) || new Date();
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function retentionExpiry(value, promisedDays) {
  // Cleanup is daily. Expiring one day before the public maximum keeps normal
  // deletion within the promised 35/365-day windows instead of after them.
  return addDaysToDate(value, promisedDays - RETENTION_DELETE_BUFFER_DAYS);
}

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return normalized === value && getZurichDayRange(value) !== null;
}

function compareDays(a, b) {
  return String(a).localeCompare(String(b));
}

function daySpanInclusive(fromDay, toDay) {
  if (!validDay(fromDay) || !validDay(toDay) || compareDays(fromDay, toDay) > 0) {
    return null;
  }
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function normalizeOverrideRange(input, resolvedDay, now = new Date()) {
  const effectiveFromDay = String(input.effectiveFromDay || resolvedDay);
  const effectiveToDay = input.effectiveToDay === null
    ? null
    : String(input.effectiveToDay || "");
  const today = formatDayInZurich(now);
  const earliestAllowedDay = addUtcDays(today, -(AGGREGATE_RETENTION_DAYS - 1));
  if (
    !validDay(effectiveFromDay) ||
    compareDays(effectiveFromDay, earliestAllowedDay) < 0 ||
    compareDays(effectiveFromDay, today) > 0
  ) {
    throw new Error("Override start must be within the rolling 365-day analytics window");
  }
  if (effectiveToDay !== null) {
    const span = daySpanInclusive(effectiveFromDay, effectiveToDay);
    if (
      !span ||
      span > AGGREGATE_RETENTION_DAYS ||
      compareDays(effectiveToDay, today) > 0
    ) {
      throw new Error("Override range must be between 1 and 365 days");
    }
  }
  return { effectiveFromDay, effectiveToDay };
}

async function loadAnalyticsConfig(db) {
  const snap = await db.doc(CONFIG_PATH).get();
  const raw = snap.exists ? snap.data() : {};
  return {
    ...parseAnalyticsConfig(raw),
    captureStartedAt: toDate(raw.captureStartedAt),
  };
}

function dirtyDaysForSegment(segment) {
  const days = [
    segment.createdDay,
    segment.successDay,
    formatDayInZurich(segment.lastRelevantAt),
  ].filter(Boolean);
  // A document created just after midnight can still continue a run from the
  // preceding day. Mark that day too, otherwise a late update to this boundary
  // document could leave yesterday's already-materialised access/classification
  // stale.
  const createdAtMs = timestampToMs(segment.createdAt);
  const createdRange = segment.createdDay && getZurichDayRange(segment.createdDay);
  if (
    createdAtMs !== null &&
    createdRange &&
    createdAtMs >= createdRange.start.getTime() &&
    createdAtMs <= createdRange.start.getTime() + FULL_RECONNECT_GAP_MS
  ) {
    days.push(addUtcDays(segment.createdDay, -1));
  }
  return Array.from(new Set(days));
}

async function markDirtyDays(db, days, reason, now = new Date(), refresh = false) {
  const uniqueDays = Array.from(new Set((days || []).filter(validDay)));
  if (uniqueDays.length === 0) return;
  for (const day of uniqueDays) {
    const ref = db.collection(COLLECTIONS.dirtyDays).doc(day);
    const marker = {
      day,
      reason: String(reason || "session_update").slice(0, 64),
      dirtyAt: now,
      expiresAt: retentionExpiry(now, AGGREGATE_RETENTION_DAYS),
    };
    if (refresh) {
      // A new segment evidence version must advance dirtyAt. Otherwise an
      // aggregation that started before this change could delete an older
      // marker and permanently miss the concurrent evidence.
      await ref.set(marker);
      continue;
    }
    try {
      // Eventarc retries for unchanged evidence only ensure that a marker
      // exists; they do not refresh it or create another write.
      await ref.create(marker);
    } catch (error) {
      if (![6, "already-exists"].includes(error?.code)) throw error;
    }
  }
}

async function ensureDirtyDaysAtLeast(db, days, reason, factCapturedAt, now = new Date()) {
  const factTime = toDate(factCapturedAt);
  const uniqueDays = Array.from(new Set((days || []).filter(validDay)));
  if (!factTime || uniqueDays.length === 0) return;
  for (const day of uniqueDays) {
    const ref = db.collection(COLLECTIONS.dirtyDays).doc(day);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const currentDirtyAt = snap.exists
        ? (timestampToMs(snap.data()?.dirtyAt) || 0)
        : 0;
      if (currentDirtyAt >= factTime.getTime()) return;
      transaction.set(ref, {
        day,
        reason: String(reason || "session_update").slice(0, 64),
        // The comparison proves whether this fact ever refreshed the marker;
        // the repair value records when the retry observed the missing/stale
        // marker, which is necessarily after its fact transaction.
        dirtyAt: now,
        expiresAt: retentionExpiry(now, AGGREGATE_RETENTION_DAYS),
      });
    });
  }
}

async function captureSessionSnapshot({
  db,
  sessionId,
  data,
  sourceUpdateTime,
  captureSource = "live",
  hmacSecret,
  config,
  now = new Date(),
  markerNow,
}) {
  return captureSessionSnapshots({
    db,
    sessionId,
    snapshots: [{ data, sourceUpdateTime, captureSource }],
    hmacSecret,
    config,
    now,
    markerNow,
  });
}

async function captureSessionSnapshots({
  db,
  sessionId,
  snapshots,
  hmacSecret,
  config,
  now = new Date(),
  markerNow,
}) {
  if (!config?.captureEnabled || !config?.hmacKeyVersion) {
    return { status: "disabled" };
  }
  let incoming = null;
  for (const snapshot of snapshots || []) {
    const pairingId = pseudonymizePairing(
      snapshot?.data?.pairingDocKey,
      hmacSecret,
      config.hmacKeyVersion
    );
    if (!pairingId) continue;
    const projected = buildSegmentProjection(snapshot.data, {
      pairingId,
      keyVersion: config.hmacKeyVersion,
      captureSource: snapshot.captureSource,
      sourceUpdateTime: snapshot.sourceUpdateTime,
    });
    if (projected) incoming = mergeSegment(incoming, projected);
  }
  if (!incoming) {
    const sourceTimes = (snapshots || [])
      .map((snapshot) => timestampToMs(snapshot?.sourceUpdateTime))
      .filter((value) => value !== null);
    if (sourceTimes.length === 0) return { status: "invalid_source" };
    const observedAt = new Date(Math.max(...sourceTimes));
    const successfulSnapshots = (snapshots || []).filter((snapshot) => {
      const data = snapshot?.data || {};
      return data.status === "connected" ||
        timestampToMs(data.signalingClearedAt) !== null ||
        Boolean(data.babyActiveTurnProvider || data.parentActiveTurnProvider);
    });
    const successTimes = successfulSnapshots
      .map((snapshot) => timestampToMs(snapshot.sourceUpdateTime))
      .filter((value) => value !== null);
    const successAt = successTimes.length > 0 ? new Date(Math.min(...successTimes)) : null;
    incoming = {
      pairingId: null,
      reviewId: null,
      keyVersion: config.hmacKeyVersion,
      createdAt: observedAt,
      createdDay: formatDayInZurich(observedAt),
      lastRelevantAt: observedAt,
      successAt,
      successDay: successAt ? formatDayInZurich(successAt) : null,
      everConnected: successfulSnapshots.some((snapshot) => snapshot.data?.status === "connected"),
      signalingCleared: successfulSnapshots.some(
        (snapshot) => timestampToMs(snapshot.data?.signalingClearedAt) !== null
      ),
      activeTurnObserved: successfulSnapshots.some(
        (snapshot) => Boolean(
          snapshot.data?.babyActiveTurnProvider || snapshot.data?.parentActiveTurnProvider
        )
      ),
      babyPremium: "missing",
      parentPremium: "missing",
      fullReconnect: false,
      explicitUserEnd: false,
      captureSource: (snapshots || []).some((snapshot) => snapshot.captureSource === "live")
        ? "live"
        : "backfill",
      captureStatus: "invalid_source",
      sourceUpdateTime: observedAt,
    };
  } else {
    incoming.captureStatus = "materialized";
  }

  const segmentRef = db.collection(COLLECTIONS.segments).doc(sessionId);
  let storedSegment = null;
  const result = await db.runTransaction(async (transaction) => {
    const existingSnap = await transaction.get(segmentRef);
    const existing = existingSnap.exists ? existingSnap.data() : null;
    const merged = mergeSegment(existing, incoming);
    if (!merged) return "stale";
    if (existing && segmentEvidenceSignature(existing) === segmentEvidenceSignature(merged)) {
      // Keep the materialised value so an Eventarc retry can repeat the
      // idempotent dirty-marker step if the original segment transaction
      // committed but marking the affected day failed afterwards.
      storedSegment = existing;
      return "unchanged";
    }
    const sourceMs = timestampToMs(merged.sourceUpdateTime) || now.getTime();
    storedSegment = {
      ...merged,
      capturedAt: now,
      captureLagMs: Math.max(0, now.getTime() - sourceMs),
      // Retention is anchored to server processing time, never to a
      // client-writable session timestamp.
      expiresAt: retentionExpiry(now, SEGMENT_RETENTION_DAYS),
    };
    transaction.set(segmentRef, storedSegment);
    return existing ? "updated" : "created";
  });

  if (storedSegment) {
    // Capture `dirtyAt` only after the fact transaction has committed. A time
    // fixed before that commit could sort before a concurrent aggregation's
    // cutoff even though the marker itself was written after its query.
    const dirtyObservedAt = markerNow instanceof Date ? markerNow : new Date();
    const reason = incoming.captureSource === "backfill" ? "backfill" : "live";
    const dirtyDays = dirtyDaysForSegment(storedSegment);
    if (["created", "updated"].includes(result)) {
      await markDirtyDays(db, dirtyDays, reason, dirtyObservedAt, true);
    } else {
      // If the fact transaction committed but its marker refresh failed, an
      // Eventarc retry observes unchanged evidence. Bring an older marker up
      // to the fact's capturedAt without writing when it is already current.
      await ensureDirtyDaysAtLeast(
        db,
        dirtyDays,
        reason,
        storedSegment.capturedAt,
        dirtyObservedAt
      );
    }
  }
  return {
    status: storedSegment?.captureStatus === "invalid_source" ? "invalid_source" : result,
    segment: storedSegment,
  };
}

function successorDeadlineForDay(segments, day) {
  let deadlineMs = null;
  const successfulGroups = groupSegments(segments)
    .filter((group) => group.successful && group.successDay === day);
  for (const group of successfulGroups) {
    const last = group.segments[group.segments.length - 1];
    if (!last || last.explicitUserEnd) continue;
    const relevantMs = Math.max(...group.segments.map((segment) =>
      timestampToMs(segment.lastRelevantAt) ?? timestampToMs(segment.createdAt) ?? 0
    ));
    const lastRelevantMs = timestampToMs(last.lastRelevantAt) ??
      timestampToMs(last.createdAt) ?? 0;
    const candidate = last.fullReconnect
      ? lastRelevantMs + FULL_RECONNECT_GAP_MS
      : relevantMs + NORMAL_RECONNECT_GAP_MS;
    deadlineMs = deadlineMs === null ? candidate : Math.max(deadlineMs, candidate);
  }
  return deadlineMs;
}

async function querySegmentsForDay(db, day) {
  const range = getZurichDayRange(day);
  if (!range) throw new Error(`Invalid analytics day: ${day}`);
  const boundaryStart = new Date(range.start.getTime() - FULL_RECONNECT_GAP_MS);
  // Helper grouping accepts exactly ten minutes (`<=`), so range boundaries
  // must include that exact millisecond as well.
  const ref = db.collection(COLLECTIONS.segments);
  const [createdSnap, successSnap, beforeBoundarySnap, continuedSnap] = await Promise.all([
    ref.where("createdDay", "==", day).limit(MAX_SEGMENTS_PER_DAY + 1).get(),
    ref.where("successDay", "==", day).limit(MAX_SEGMENTS_PER_DAY + 1).get(),
    ref.where("lastRelevantAt", ">=", boundaryStart).where("lastRelevantAt", "<", range.start)
      .limit(MAX_SEGMENTS_PER_DAY + 1).get(),
    // `continuedDays` is materialised only for days after createdDay. It finds
    // a previous-day segment whose reconnect fact arrives after midnight
    // without rereading every current-day segment a third time.
    ref.where("continuedDays", "array-contains", day).limit(MAX_SEGMENTS_PER_DAY + 1).get(),
  ]);
  if ([createdSnap, successSnap, beforeBoundarySnap, continuedSnap]
    .some((snap) => snap.size > MAX_SEGMENTS_PER_DAY)) {
    throw new Error(`Daily segment safety cap exceeded (${MAX_SEGMENTS_PER_DAY})`);
  }
  const documents = new Map();
  for (const snap of [createdSnap, successSnap, beforeBoundarySnap, continuedSnap]) {
    for (const doc of snap.docs) documents.set(doc.id, doc.data());
  }

  // Resolve successor chains transitively. A reconnect fact may arrive after
  // midnight and allow its next raw document later than the fixed +10-minute
  // wall-clock boundary. Query only until the deadline implied by successful
  // target-day groups, and never beyond the approved 24-hour finalisation
  // horizon or the global segment cap.
  let successorCursorMs = range.end.getTime();
  const successorLimitMs = successorCursorMs + SUCCESSOR_LOOKAHEAD_MS;
  while (documents.size <= MAX_SEGMENTS_PER_DAY) {
    let successorDeadlineMs = successorDeadlineForDay(
      Array.from(documents.values()),
      day
    ) ?? (successorCursorMs - 1);
    successorDeadlineMs = Math.min(successorDeadlineMs, successorLimitMs);
    if (successorDeadlineMs < successorCursorMs) break;
    const remaining = MAX_SEGMENTS_PER_DAY - documents.size;
    const successorSnap = await ref
      .where("createdAt", ">=", new Date(successorCursorMs))
      .where("createdAt", "<", new Date(successorDeadlineMs + 1))
      .limit(remaining + 1)
      .get();
    if (successorSnap.size > remaining) {
      throw new Error(`Daily segment safety cap exceeded (${MAX_SEGMENTS_PER_DAY})`);
    }
    for (const doc of successorSnap.docs) documents.set(doc.id, doc.data());
    successorCursorMs = successorDeadlineMs + 1;
  }
  if (documents.size > MAX_SEGMENTS_PER_DAY) {
    throw new Error(`Daily segment safety cap exceeded (${MAX_SEGMENTS_PER_DAY})`);
  }
  return Array.from(documents.values());
}

async function loadOverrides(db) {
  const snap = await db.collection(COLLECTIONS.overrides).limit(MAX_OVERRIDES + 1).get();
  if (snap.size > MAX_OVERRIDES) {
    throw new Error(`Override safety cap exceeded (${MAX_OVERRIDES})`);
  }
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function pairingDayDocumentId(day, pairingId) {
  return `${day}_${pairingId}`;
}

function summaryFingerprint(summary) {
  return crypto.createHash("sha256").update(JSON.stringify({
    day: summary.day,
    pairingId: summary.pairingId,
    rawDocuments: summary.rawDocuments,
    successfulRuns: summary.successfulRuns,
    shortGaps: summary.shortGaps,
    gapCount: summary.gapCount,
    premiumRuns: summary.premiumRuns,
    trialRuns: summary.trialRuns,
    unknownAccessRuns: summary.unknownAccessRuns,
    automaticClassification: summary.automaticClassification,
    automaticRules: summary.automaticRules,
    effectiveClassification: summary.effectiveClassification,
    overrideId: summary.overrideId,
    backfillSegments: summary.backfillSegments,
    captureLagMs: summary.captureLagMs,
  })).digest("hex");
}

async function commitOperations(db, operations) {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 400)) {
      if (operation.type === "delete") batch.delete(operation.ref);
      else if (operation.type === "update") batch.update(operation.ref, operation.data);
      else if (operation.type === "set") {
        batch.set(operation.ref, operation.data, operation.options || {});
      } else {
        throw new Error(`Unsupported analytics operation: ${operation.type}`);
      }
    }
    await batch.commit();
  }
}

async function acquireDayLease(
  db,
  day,
  now = new Date(),
  leaseId = crypto.randomUUID()
) {
  const ref = db.collection(COLLECTIONS.dayLeases).doc(day);
  let acquired = false;
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? snap.data() : {};
    const leaseExpiresAt = timestampToMs(current.leaseExpiresAt) || 0;
    if (leaseExpiresAt > now.getTime()) return;
    transaction.set(ref, {
      day,
      leaseId,
      acquiredAt: now,
      leaseExpiresAt: new Date(now.getTime() + DAY_LEASE_MS),
      expiresAt: new Date(now.getTime() + DAY_LEASE_MS),
    });
    acquired = true;
  });
  return acquired ? { ref, leaseId } : null;
}

async function releaseDayLease(db, lease) {
  if (!lease) return;
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(lease.ref);
    if (snap.exists && snap.data()?.leaseId === lease.leaseId) {
      transaction.delete(lease.ref);
    }
  });
}

async function withDayLease(db, day, now, callback) {
  const lease = await acquireDayLease(db, day, now);
  if (!lease) return { status: "busy" };
  try {
    return await callback();
  } finally {
    await releaseDayLease(db, lease);
  }
}

async function clearDirtyDayIfHandled(db, day, handledThrough) {
  const ref = db.collection(COLLECTIONS.dirtyDays).doc(day);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const dirtyAt = timestampToMs(snap.data()?.dirtyAt) || 0;
    if (dirtyAt <= handledThrough.getTime()) transaction.delete(ref);
  });
}

async function listPairingDayDocuments(db, day) {
  const { FieldPath } = adminFirestoreSymbols();
  const prefix = `${day}_`;
  const snap = await db.collection(COLLECTIONS.pairingDays)
    .orderBy(FieldPath.documentId())
    .startAt(prefix)
    .endAt(`${prefix}\uf8ff`)
    .limit(MAX_PAIRING_DAYS_PER_DAY + 1)
    .get();
  if (snap.size > MAX_PAIRING_DAYS_PER_DAY) {
    throw new Error(`Pairing-day safety cap exceeded (${MAX_PAIRING_DAYS_PER_DAY})`);
  }
  return snap.docs;
}

function isCompleteDay(day, now = new Date()) {
  const range = getZurichDayRange(day);
  return Boolean(range && now.getTime() >= range.end.getTime() + 24 * 60 * 60 * 1000);
}

function aggregateDailyFromSummaries(summaries, day, coverage = {}) {
  const daily = {
    day,
    likelyReal: { premium: 0, trial: 0, unknown: 0, total: 0 },
    test: 0,
    uncertain: 0,
    unclassified: 0,
    successfulRuns: 0,
    rawDocuments: 0,
    pairingDays: summaries.length,
    backfillSegments: 0,
    activeOverrides: 0,
    manualLikelyReal: { premium: 0, trial: 0, unknown: 0, total: 0 },
    manualTest: 0,
    automaticLikelyReal: { premium: 0, trial: 0, unknown: 0, total: 0 },
    automaticTest: 0,
    automaticUncertain: 0,
    automaticSuccessfulRuns: 0,
    capturedDocuments: Number(coverage.capturedDocuments || 0),
    materializedDocuments: Number(coverage.materializedDocuments || 0),
    invalidSourceDocuments: Number(coverage.invalidSourceDocuments || 0),
    successfulEvidenceDocuments: Number(coverage.successfulEvidenceDocuments || 0),
  };
  let maxCaptureLagMs = 0;
  for (const summary of summaries) {
    daily.rawDocuments += Number(summary.rawDocuments || 0);
    daily.successfulRuns += Number(summary.successfulRuns || 0);
    daily.backfillSegments += Number(summary.backfillSegments || 0);
    maxCaptureLagMs = Math.max(maxCaptureLagMs, Number(summary.captureLagMs || 0));
    if (summary.overrideId) daily.activeOverrides++;
    const manuallyClassified = Boolean(
      summary.overrideId && summary.overrideClassification && summary.overrideClassification !== "auto"
    );
    if (!manuallyClassified) {
      const successfulRuns = Number(summary.successfulRuns || 0);
      daily.automaticSuccessfulRuns += successfulRuns;
      if (summary.automaticClassification === "likely_real") {
        daily.automaticLikelyReal.premium += Number(summary.premiumRuns || 0);
        daily.automaticLikelyReal.trial += Number(summary.trialRuns || 0);
        daily.automaticLikelyReal.unknown += Number(summary.unknownAccessRuns || 0);
        daily.automaticLikelyReal.total += successfulRuns;
      } else if (summary.automaticClassification === "test") {
        daily.automaticTest += successfulRuns;
      } else if (summary.automaticClassification === "uncertain") {
        daily.automaticUncertain += successfulRuns;
      }
    }
    if (summary.effectiveClassification === "likely_real") {
      daily.likelyReal.premium += Number(summary.premiumRuns || 0);
      daily.likelyReal.trial += Number(summary.trialRuns || 0);
      daily.likelyReal.unknown += Number(summary.unknownAccessRuns || 0);
      daily.likelyReal.total += Number(summary.successfulRuns || 0);
      if (manuallyClassified) {
        daily.manualLikelyReal.premium += Number(summary.premiumRuns || 0);
        daily.manualLikelyReal.trial += Number(summary.trialRuns || 0);
        daily.manualLikelyReal.unknown += Number(summary.unknownAccessRuns || 0);
        daily.manualLikelyReal.total += Number(summary.successfulRuns || 0);
      }
    } else if (["test", "uncertain", "unclassified"].includes(summary.effectiveClassification)) {
      daily[summary.effectiveClassification] += Number(summary.successfulRuns || 0);
      if (manuallyClassified && summary.effectiveClassification === "test") {
        daily.manualTest += Number(summary.successfulRuns || 0);
      }
    }
  }
  const knownAccess = daily.likelyReal.premium + daily.likelyReal.trial;
  daily.premiumShare = knownAccess > 0 ? daily.likelyReal.premium / knownAccess : null;
  daily.backfillShare = daily.rawDocuments > 0
    ? daily.backfillSegments / daily.rawDocuments
    : 0;
  daily.captureLagSeconds = Math.ceil(maxCaptureLagMs / 1000);
  daily.materializationShare = daily.capturedDocuments > 0
    ? daily.materializedDocuments / daily.capturedDocuments
    : null;
  return daily;
}

async function writeDailyAggregate(
  db,
  day,
  summaries,
  config,
  now = new Date(),
  coverage = {},
  requireExisting = false
) {
  const daily = aggregateDailyFromSummaries(summaries, day, coverage);
  const range = getZurichDayRange(day);
  const data = {
    ...daily,
    complete: isCompleteDay(day, now),
    autoExclusionEnabled: config.autoExclusionEnabled === true,
    aggregatedAt: now,
    expiresAt: retentionExpiry(range?.end || now, AGGREGATE_RETENTION_DAYS),
  };
  const ref = db.collection(COLLECTIONS.daily).doc(day);
  if (requireExisting) await ref.update(data);
  else await ref.set(data);
  return daily;
}

async function aggregateDayUnlocked(db, day, config, now = new Date()) {
  if (!config?.aggregationEnabled) return { status: "disabled" };
  const [segments, overrides, existingDocs] = await Promise.all([
    querySegmentsForDay(db, day),
    loadOverrides(db),
    listPairingDayDocuments(db, day),
  ]);
  if (segments.length === 0) {
    if (isCompleteDay(day, now)) {
      await clearDirtyDayIfHandled(db, day, now).catch(() => {});
    }
    // If capture/aggregation was paused beyond segment retention, never turn a
    // previously materialised day into a fabricated zero day. Historical
    // pairing-day summaries remain available for override-only rebuilds.
    return { status: existingDocs.length > 0 ? "source_unavailable" : "no_data" };
  }
  const { summaries } = buildPairingDaySummaries(segments, day, {
    autoExclusionEnabled: config.autoExclusionEnabled,
    overrides,
  });
  const captured = segments.filter((segment) => segment.createdDay === day);
  const coverage = {
    capturedDocuments: captured.length,
    materializedDocuments: captured.filter((segment) => Boolean(segment.pairingId)).length,
    invalidSourceDocuments: captured.filter((segment) => segment.captureStatus === "invalid_source").length,
    successfulEvidenceDocuments: captured.filter(isSuccessfulSegment).length,
  };
  const expiresAt = retentionExpiry(
    getZurichDayRange(day)?.end || now,
    AGGREGATE_RETENTION_DAYS
  );
  const maxCaptureLagMs = segments.reduce(
    (max, segment) => Math.max(max, Number(segment.captureLagMs || 0)),
    0
  );
  const existingById = new Map(existingDocs.map((doc) => [doc.id, doc]));
  const newIds = new Set();
  const operations = [];
  for (const summary of summaries) {
    const docId = pairingDayDocumentId(day, summary.pairingId);
    newIds.add(docId);
    const materialized = { ...summary, captureLagMs: maxCaptureLagMs };
    const fingerprint = summaryFingerprint(materialized);
    const existing = existingById.get(docId);
    if (existing?.data()?.fingerprint === fingerprint) continue;
    operations.push({
      type: "set",
      ref: db.collection(COLLECTIONS.pairingDays).doc(docId),
      data: {
        ...materialized,
        fingerprint,
        aggregatedAt: now,
        expiresAt,
      },
    });
  }
  for (const doc of existingDocs) {
    if (!newIds.has(doc.id)) operations.push({ type: "delete", ref: doc.ref });
  }
  await commitOperations(db, operations);
  await writeDailyAggregate(db, day, summaries.map((summary) => ({
    ...summary,
    captureLagMs: maxCaptureLagMs,
  })), config, now, coverage);

  if (isCompleteDay(day, now)) {
    await clearDirtyDayIfHandled(db, day, now).catch(() => {});
  }
  return { status: "complete", summaries: summaries.length };
}

async function aggregateDay(db, day, config, now = new Date()) {
  if (!config?.aggregationEnabled) return { status: "disabled" };
  return withDayLease(
    db,
    day,
    now,
    () => aggregateDayUnlocked(db, day, config, now)
  );
}

function resolveSummaryClassification(summary, overrides, config) {
  const matching = (overrides || [])
    .filter((override) =>
      override.pairingId === summary.pairingId &&
      override.effectiveFromDay <= summary.day &&
      (!override.effectiveToDay || override.effectiveToDay >= summary.day)
    )
    .sort((a, b) => (timestampToMs(b.createdAt) || 0) - (timestampToMs(a.createdAt) || 0));
  const override = matching[0] || null;
  return {
    effectiveClassification: override && override.classification !== "auto"
      ? override.classification
      : (config.autoExclusionEnabled ? summary.automaticClassification : "unclassified"),
    overrideId: override?.id || null,
    overrideClassification: override?.classification || null,
    overrideReason: override?.reason || null,
  };
}

async function rebuildDayFromSummariesUnlocked(
  db,
  day,
  config,
  overrides,
  now = new Date(),
  attempt = 0
) {
  const [docs, existingDaily] = await Promise.all([
    listPairingDayDocuments(db, day),
    db.collection(COLLECTIONS.daily).doc(day).get(),
  ]);
  if (docs.length === 0) return { status: "no_data" };
  const existingDailyExpiresAt = existingDaily.exists
    ? timestampToMs(existingDaily.data()?.expiresAt)
    : null;
  if (!existingDaily.exists || existingDailyExpiresAt === null || existingDailyExpiresAt <= now.getTime()) {
    // Override rebuilds never create or revive a daily record. Missing/expired
    // source belongs to retention cleanup and cannot be reconstructed safely.
    return { status: "expired" };
  }
  const summaries = [];
  const operations = [];
  for (const doc of docs) {
    const summary = { id: doc.id, ...doc.data() };
    const resolved = resolveSummaryClassification(summary, overrides, config);
    const updated = { ...summary, ...resolved, aggregatedAt: now };
    delete updated.id;
    summaries.push(updated);
    // `update`, unlike merge-set, cannot resurrect a concurrently deleted
    // summary as a partial document.
    operations.push({ type: "update", ref: doc.ref, data: resolved });
  }
  try {
    await commitOperations(db, operations);
  } catch (error) {
    if (attempt === 0 && [5, "not-found"].includes(error?.code)) {
      return rebuildDayFromSummariesUnlocked(db, day, config, overrides, now, 1);
    }
    throw error;
  }
  const existingCoverage = existingDaily.exists ? existingDaily.data() : {};
  try {
    await writeDailyAggregate(db, day, summaries, config, now, {
      capturedDocuments: existingCoverage.capturedDocuments,
      materializedDocuments: existingCoverage.materializedDocuments,
      invalidSourceDocuments: existingCoverage.invalidSourceDocuments,
      successfulEvidenceDocuments: existingCoverage.successfulEvidenceDocuments,
    }, true);
  } catch (error) {
    if ([5, "not-found"].includes(error?.code)) return { status: "expired" };
    throw error;
  }
  return { status: "complete", summaries: summaries.length };
}

async function rebuildDayFromSummaries(
  db,
  day,
  config,
  overrides,
  now = new Date()
) {
  if (!config?.aggregationEnabled) return { status: "disabled" };
  return withDayLease(
    db,
    day,
    now,
    () => rebuildDayFromSummariesUnlocked(db, day, config, overrides, now)
  );
}

async function claimRebuildJob(db, jobRef, now = new Date(), leaseId = crypto.randomUUID()) {
  let claimed = null;
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(jobRef);
    if (!snap.exists) return;
    const data = snap.data() || {};
    const stale = data.status === "processing" &&
      (timestampToMs(data.updatedAt) || 0) < now.getTime() - REBUILD_LEASE_MS;
    if (data.status !== "pending" && !stale) return;
    transaction.set(jobRef, {
      status: "processing",
      leaseId,
      startedAt: data.startedAt || now,
      updatedAt: now,
    }, { merge: true });
    claimed = { ...data, leaseId };
  });
  return claimed;
}

async function processNextRebuildJob(db, config, now = new Date()) {
  if (!config?.aggregationEnabled) return { status: "disabled" };
  const jobs = db.collection(COLLECTIONS.rebuildJobs);
  const [processingSnap, pendingSnap] = await Promise.all([
    jobs.where("status", "==", "processing").limit(10).get(),
    jobs.where("status", "==", "pending").limit(1).get(),
  ]);
  const staleBefore = now.getTime() - REBUILD_LEASE_MS;
  const staleProcessing = processingSnap.docs.find(
    (doc) => (timestampToMs(doc.data()?.updatedAt) || 0) < staleBefore
  );
  const jobDoc = staleProcessing || pendingSnap.docs[0];
  if (!jobDoc) return { status: "idle" };
  const job = await claimRebuildJob(db, jobDoc.ref, now);
  if (!job) return { status: "idle" };
  const today = formatDayInZurich(now);
  const requestedFinalDay = job.effectiveToDay || today;
  // Future range configuration is valid, but only already-materialised days
  // need rebuilding. Future daily aggregation will apply the override itself.
  const finalDay = compareDays(requestedFinalDay, today) > 0 ? today : requestedFinalDay;
  let cursorDay = job.cursorDay || job.effectiveFromDay;
  const overrides = await loadOverrides(db);
  const { FieldValue } = adminFirestoreSymbols();
  await jobDoc.ref.set({ error: FieldValue.delete() }, { merge: true });
  try {
    let processed = 0;
    while (cursorDay && compareDays(cursorDay, finalDay) <= 0 && processed < REBUILD_CHUNK_DAYS) {
      const rebuild = await rebuildDayFromSummaries(db, cursorDay, config, overrides, now);
      if (rebuild.status === "busy") break;
      cursorDay = addUtcDays(cursorDay, 1);
      processed++;
    }
    const complete = !cursorDay || compareDays(cursorDay, finalDay) > 0;
    await jobDoc.ref.set({
      status: complete ? "complete" : "pending",
      cursorDay: complete ? null : cursorDay,
      processedDays: Number(job.processedDays || 0) + processed,
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    }, { merge: true });
    return { status: complete ? "complete" : "pending", processed };
  } catch (error) {
    await jobDoc.ref.set({ status: "failed", error: String(error.message).slice(0, 500), updatedAt: now }, { merge: true });
    throw error;
  }
}

async function runScheduledAggregation(db, config, now = new Date()) {
  if (!config?.aggregationEnabled) return { status: "disabled" };
  const today = formatDayInZurich(now);
  const yesterday = addUtcDays(today, -1);
  const dirtySnap = await db.collection(COLLECTIONS.dirtyDays).limit(35).get();
  const days = new Set([yesterday]);
  for (const doc of dirtySnap.docs) {
    if (validDay(doc.id) && compareDays(doc.id, today) < 0) days.add(doc.id);
  }
  const results = [];
  for (const day of Array.from(days).sort()) {
    results.push({ day, ...(await aggregateDay(db, day, config, now)) });
  }
  return { status: "complete", results };
}

function deriveOpaqueKey(secret) {
  return crypto.createHmac("sha256", secret).update("session-analytics-opaque-v1").digest();
}

function sealOpaque(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveOpaqueKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function openOpaque(value, secret) {
  try {
    const packed = Buffer.from(String(value || ""), "base64url");
    if (packed.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveOpaqueKey(secret), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
  } catch (_) {
    return null;
  }
}

function sanitizePairingDay(summary, secret, autoExclusionEnabled) {
  const hasManualOverride = Boolean(
    summary.overrideId && summary.overrideClassification && summary.overrideClassification !== "auto"
  );
  const effectiveClassification = hasManualOverride
    ? summary.overrideClassification
    : (autoExclusionEnabled ? summary.automaticClassification : "unclassified");
  return {
    pairingId: summary.reviewId,
    day: summary.day,
    rawDocuments: Number(summary.rawDocuments || 0),
    successfulRuns: Number(summary.successfulRuns || 0),
    shortGaps: Number(summary.shortGaps || 0),
    gapCount: Number(summary.gapCount || 0),
    shortGapRatio: Number(summary.shortGapRatio || 0),
    premiumRuns: Number(summary.premiumRuns || 0),
    trialRuns: Number(summary.trialRuns || 0),
    unknownAccessRuns: Number(summary.unknownAccessRuns || 0),
    automaticClassification: summary.automaticClassification,
    automaticRules: Array.isArray(summary.automaticRules) ? summary.automaticRules.slice(0, 5) : [],
    effectiveClassification,
    overrideClassification: summary.overrideClassification || null,
    overrideReason: summary.overrideReason || null,
    reviewToken: sealOpaque(`${summary.day}:${summary.reviewId}`, secret),
  };
}

async function listPairingDaysPage(db, {
  day,
  classification,
  pageSize,
  cursor,
  secret,
  autoExclusionEnabled,
}) {
  if (!validDay(day)) throw new Error("Invalid day");
  const allowedClassifications = ["all", "likely_real", "test", "uncertain", "unclassified"];
  const selected = allowedClassifications.includes(classification) ? classification : "all";
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const docs = await listPairingDayDocuments(db, day);
  const cursorId = cursor ? openOpaque(cursor, secret) : null;
  let started = !cursorId;
  const items = [];
  let nextCursor = null;
  for (const doc of docs) {
    if (!started) {
      if (doc.id === cursorId) started = true;
      continue;
    }
    const data = doc.data();
    const hasManualOverride = Boolean(
      data.overrideId && data.overrideClassification && data.overrideClassification !== "auto"
    );
    const effectiveClassification = hasManualOverride
      ? data.overrideClassification
      : (autoExclusionEnabled ? data.automaticClassification : "unclassified");
    if (selected !== "all" && effectiveClassification !== selected) continue;
    if (items.length >= size) {
      nextCursor = sealOpaque(items[items.length - 1].internalId, secret);
      break;
    }
    items.push({
      internalId: doc.id,
      value: sanitizePairingDay(data, secret, autoExclusionEnabled),
    });
  }
  return {
    items: items.map((item) => item.value),
    nextCursor,
  };
}

function projectDailyAnalyticsRow(row, autoEnabled) {
  const manualLikelyReal = row.manualLikelyReal || {
    premium: 0, trial: 0, unknown: 0, total: 0,
  };
  const automaticLikelyReal = row.automaticLikelyReal || {
    premium: 0, trial: 0, unknown: 0, total: 0,
  };
  const likelyReal = autoEnabled ? {
    premium: Number(manualLikelyReal.premium || 0) + Number(automaticLikelyReal.premium || 0),
    trial: Number(manualLikelyReal.trial || 0) + Number(automaticLikelyReal.trial || 0),
    unknown: Number(manualLikelyReal.unknown || 0) + Number(automaticLikelyReal.unknown || 0),
    total: Number(manualLikelyReal.total || 0) + Number(automaticLikelyReal.total || 0),
  } : manualLikelyReal;
  const knownAccess = Number(likelyReal.premium || 0) + Number(likelyReal.trial || 0);
  return {
    day: row.day,
    dataStatus: "aggregated",
    likelyReal,
    test: Number(row.manualTest || 0) + (autoEnabled ? Number(row.automaticTest || 0) : 0),
    uncertain: autoEnabled ? Number(row.automaticUncertain || 0) : 0,
    // Every non-manual summary always has one automatic classification. A row
    // materialised during shadow mode may have stored those runs in
    // row.unclassified, so never reuse that switch-dependent field here.
    unclassified: autoEnabled
      ? 0
      : Number(row.automaticSuccessfulRuns ?? row.successfulRuns ?? 0),
    premiumShare: knownAccess > 0 ? Number(likelyReal.premium || 0) / knownAccess : null,
    rawDocuments: Number(row.rawDocuments || 0),
    successfulRuns: Number(row.successfulRuns || 0),
    backfillShare: Number(row.backfillShare || 0),
    captureLagSeconds: Number(row.captureLagSeconds || 0),
    activeOverrides: Number(row.activeOverrides || 0),
    capturedDocuments: Number(row.capturedDocuments || 0),
    materializedDocuments: Number(row.materializedDocuments || 0),
    invalidSourceDocuments: Number(row.invalidSourceDocuments || 0),
    successfulEvidenceDocuments: Number(row.successfulEvidenceDocuments || 0),
    materializationShare: row.materializationShare === null || row.materializationShare === undefined
      ? null
      : Number(row.materializationShare),
    complete: row.complete === true,
    aggregatedAt: toDate(row.aggregatedAt)?.toISOString() || null,
  };
}

function fillCalendarDays(rows, fromDay, toDay) {
  if (!validDay(fromDay) || !validDay(toDay) || compareDays(fromDay, toDay) > 0) return [];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const filled = [];
  for (let day = fromDay; day && compareDays(day, toDay) <= 0; day = addUtcDays(day, 1)) {
    filled.push(byDay.get(day) || {
      day,
      dataStatus: "missing",
      complete: false,
    });
  }
  return filled;
}

async function getDailyAnalytics(db, days, config = {}, now = new Date()) {
  const limit = [30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const endDay = addUtcDays(formatDayInZurich(now), -1);
  const requestedStartDay = addUtcDays(endDay, -(limit - 1));
  const ref = db.collection(COLLECTIONS.daily);
  const [snap, oldestSnap] = await Promise.all([
    ref.where("day", ">=", requestedStartDay)
      .where("day", "<=", endDay)
      .orderBy("day", "asc")
      .limit(limit)
      .get(),
    ref.orderBy("day", "asc").limit(1).get(),
  ]);
  const rows = snap.docs
    .map((doc) => ({ day: doc.id, ...doc.data() }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const oldestAggregateDay = oldestSnap.docs[0]?.id || null;
  const captureStartedDay = formatDayInZurich(config.captureStartedAt);
  const candidates = [oldestAggregateDay, captureStartedDay].filter(validDay).sort();
  const dataStartDay = candidates[0] || null;
  const visibleStartDay = dataStartDay && compareDays(dataStartDay, requestedStartDay) > 0
    ? dataStartDay
    : requestedStartDay;
  const projected = rows.map((row) => projectDailyAnalyticsRow(
    row,
    config.autoExclusionEnabled === true
  ));
  const calendarRows = dataStartDay && compareDays(visibleStartDay, endDay) <= 0
    ? fillCalendarDays(projected, visibleStartDay, endDay)
    : [];
  // A missing materialisation is shown as a gap, never promoted to a complete
  // zero day or used as the dashboard's "last complete" day.
  const lastComplete = [...projected].reverse()
    .find((row) => row.complete === true)?.day || null;
  return {
    days: calendarRows,
    dataStartDay,
    lastCompleteDay: lastComplete,
    generatedAt: now.toISOString(),
  };
}

async function resolveReviewToken(db, reviewToken, secret) {
  const opened = openOpaque(reviewToken, secret);
  if (!opened) return null;
  const separator = opened.indexOf(":");
  if (separator < 0) return null;
  const day = opened.slice(0, separator);
  const reviewId = opened.slice(separator + 1);
  if (!validDay(day) || !/^[a-f0-9]{16}$/.test(reviewId)) return null;
  const docs = await listPairingDayDocuments(db, day);
  const match = docs.find((doc) => doc.data().reviewId === reviewId);
  return match ? { day, ref: match.ref, data: match.data() } : null;
}

async function createOverride(db, input, actorUid, secret, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const resolved = await resolveReviewToken(db, input.reviewToken, secret);
  if (!resolved) throw new Error("Pairing review token is invalid or expired");
  const classification = String(input.classification || "");
  if (!["test", "likely_real", "auto"].includes(classification)) {
    throw new Error("Invalid override classification");
  }
  const reason = String(input.reason || "").trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new Error("Override reason must contain 5 to 500 characters");
  }
  const { effectiveFromDay, effectiveToDay } = normalizeOverrideRange(
    input,
    resolved.day,
    now
  );

  const overrideRef = db.collection(COLLECTIONS.overrides).doc();
  const auditRef = db.collection(COLLECTIONS.audit).doc();
  const jobRef = db.collection(COLLECTIONS.rebuildJobs).doc();
  const expiresAt = retentionExpiry(now, AGGREGATE_RETENTION_DAYS);
  const hadManualOverride = Boolean(
    resolved.data.overrideId &&
    resolved.data.overrideClassification &&
    resolved.data.overrideClassification !== "auto"
  );
  const oldState = hadManualOverride
    ? resolved.data.overrideClassification
    : (options.autoExclusionEnabled === true
      ? resolved.data.automaticClassification
      : "unclassified");
  const override = {
    pairingId: resolved.data.pairingId,
    reviewId: resolved.data.reviewId,
    classification,
    effectiveFromDay,
    effectiveToDay,
    reason,
    authorUid: actorUid,
    createdAt: now,
    // An explicitly open-ended override is active configuration, not retained
    // history. Firestore's expiry query ignores a missing field, so it remains
    // effective for future days until an admin supersedes it. Its immutable
    // audit entry and every bounded override still expire after 365 days.
    ...(effectiveToDay ? { expiresAt } : {}),
  };
  const supersededToDay = addUtcDays(effectiveFromDay, -1);
  await db.runTransaction(async (transaction) => {
    // The global cap and supersession are protected by the same serializable
    // transaction. Concurrent callables cannot both observe slot 500 as free
    // or leave two open-ended overrides active for one pairing.
    const overrideSnap = await transaction.get(
      db.collection(COLLECTIONS.overrides).limit(MAX_OVERRIDES + 1)
    );
    if (overrideSnap.size >= MAX_OVERRIDES) {
      throw new Error(`Override safety cap reached (${MAX_OVERRIDES})`);
    }
    const supersededOpenOverrides = effectiveToDay === null
      ? overrideSnap.docs.filter((doc) => {
        const existing = doc.data() || {};
        return existing.pairingId === resolved.data.pairingId &&
          existing.effectiveToDay == null &&
          !existing.supersededAt;
      })
      : [];
    if (supersededOpenOverrides.length > 450) {
      throw new Error("Too many open overrides for this pairing");
    }

    transaction.set(overrideRef, override);
    for (const existing of supersededOpenOverrides) {
      transaction.set(existing.ref, {
        effectiveToDay: supersededToDay,
        supersededAt: now,
        supersededBy: overrideRef.id,
        expiresAt,
      }, { merge: true });
    }
    transaction.set(auditRef, {
      overrideId: overrideRef.id,
      reviewId: resolved.data.reviewId,
      authorUid: actorUid,
      reason,
      oldState,
      newState: classification,
      effectiveFromDay,
      effectiveToDay,
      createdAt: now,
      expiresAt,
    });
    transaction.set(jobRef, {
      overrideId: overrideRef.id,
      status: "pending",
      effectiveFromDay,
      effectiveToDay,
      cursorDay: effectiveFromDay,
      processedDays: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
  });
  return { jobId: jobRef.id, status: "pending" };
}

async function cleanupExpiredAnalytics(db, now = new Date()) {
  let deleted = 0;
  const cappedCollections = [];
  for (const collection of Object.values(COLLECTIONS)) {
    let collectionDeleted = 0;
    while (collectionDeleted < MAX_CLEANUP_PER_COLLECTION) {
      const limit = Math.min(
        CLEANUP_BATCH_SIZE,
        MAX_CLEANUP_PER_COLLECTION - collectionDeleted
      );
      const snap = await db.collection(collection)
        .where("expiresAt", "<", now)
        .limit(limit)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      collectionDeleted += snap.size;
      deleted += snap.size;
      if (snap.size < limit) break;
    }
    if (collectionDeleted >= MAX_CLEANUP_PER_COLLECTION) {
      const remaining = await db.collection(collection)
        .where("expiresAt", "<", now)
        .limit(1)
        .get();
      if (!remaining.empty) cappedCollections.push(collection);
    }
  }
  return { deleted, cappedCollections };
}

module.exports = {
  COLLECTIONS,
  CONFIG_PATH,
  MAX_CLEANUP_PER_COLLECTION,
  MAX_OVERRIDES,
  MAX_PAIRING_DAYS_PER_DAY,
  MAX_SEGMENTS_PER_DAY,
  REBUILD_LEASE_MS,
  REBUILD_CHUNK_DAYS,
  aggregateDailyFromSummaries,
  aggregateDay,
  captureSessionSnapshot,
  captureSessionSnapshots,
  claimRebuildJob,
  cleanupExpiredAnalytics,
  createOverride,
  daySpanInclusive,
  fillCalendarDays,
  getDailyAnalytics,
  listPairingDaysPage,
  loadAnalyticsConfig,
  loadOverrides,
  markDirtyDays,
  normalizeOverrideRange,
  openOpaque,
  processNextRebuildJob,
  projectDailyAnalyticsRow,
  querySegmentsForDay,
  rebuildDayFromSummaries,
  resolveReviewToken,
  runScheduledAggregation,
  sealOpaque,
  validDay,
};

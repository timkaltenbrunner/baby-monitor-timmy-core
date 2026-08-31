"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPairingDaySummaries,
  buildSegmentProjection,
  classifyPairingDay,
  formatDayInZurich,
  getZurichDayRange,
  groupSegments,
  hasRelevantSessionChange,
  mergeSegment,
  normalizeAnalyticsSecret,
  parseAnalyticsConfig,
  pseudonymizePairing,
  sanitizeSessionAnalyticsSource,
  segmentEvidenceSignature,
} = require("../lib/session_analytics_helpers");

const SECRET = "s".repeat(64);
const PAIRING_A = pseudonymizePairing("a".repeat(64), SECRET, 1);

test("analytics secrets reject stdin newlines instead of splitting HMAC namespaces", () => {
  assert.equal(normalizeAnalyticsSecret("a".repeat(64)), "a".repeat(64));
  assert.equal(normalizeAnalyticsSecret(`${"a".repeat(64)}\n`), null);
  assert.equal(pseudonymizePairing("pair", `${"a".repeat(64)}\n`, 1), null);
});

function segment(overrides = {}) {
  const createdAt = overrides.createdAt || new Date("2026-08-31T08:00:00Z");
  return {
    pairingId: PAIRING_A,
    reviewId: "review",
    keyVersion: 1,
    createdAt,
    createdDay: formatDayInZurich(createdAt),
    lastRelevantAt: overrides.lastRelevantAt || createdAt,
    successAt: overrides.successAt || null,
    successDay: overrides.successAt ? formatDayInZurich(overrides.successAt) : null,
    everConnected: false,
    signalingCleared: false,
    activeTurnObserved: false,
    babyPremium: "missing",
    parentPremium: "missing",
    fullReconnect: false,
    explicitUserEnd: false,
    captureSource: "live",
    sourceUpdateTime: overrides.sourceUpdateTime || createdAt,
    ...overrides,
  };
}

test("Zurich day conversion handles winter, summer and DST day lengths", () => {
  assert.equal(formatDayInZurich(new Date("2026-01-01T23:30:00Z")), "2026-01-02");
  assert.equal(formatDayInZurich(new Date("2026-07-01T22:30:00Z")), "2026-07-02");

  const spring = getZurichDayRange("2026-03-29");
  const autumn = getZurichDayRange("2026-10-25");
  assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000);
  assert.equal(autumn.end - autumn.start, 25 * 60 * 60 * 1000);
  assert.equal(spring.start.toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(autumn.start.toISOString(), "2026-10-24T22:00:00.000Z");
});

test("projection stores only minimal evidence and recognizes existing event shapes", () => {
  const source = {
    pairingDocKey: "a".repeat(64),
    createdAt: new Date("2026-08-31T08:00:00Z"),
    updatedAt: new Date("2026-08-31T08:04:00Z"),
    status: "connected",
    babyPremium: false,
    parentPremium: true,
    babyActiveTurnUrl: "turn:secret.example:3478",
    offerSdp: "must-not-leak",
    qualityEventsTail: [
      { type: "full_reconnect", timestamp: "2026-08-31T08:03:00Z" },
      { type: "session_end", reason: "user", timestamp: "2026-08-31T08:04:00Z" },
    ],
  };
  const projected = buildSegmentProjection(source, {
    pairingId: PAIRING_A,
    keyVersion: 1,
    captureSource: "live",
    sourceUpdateTime: source.updatedAt,
  });

  assert.equal(projected.everConnected, true);
  assert.equal(projected.activeTurnObserved, true);
  assert.equal(projected.babyPremium, "false");
  assert.equal(projected.parentPremium, "true");
  assert.equal(projected.fullReconnect, true);
  assert.equal(projected.explicitUserEnd, true);
  assert.equal(Object.hasOwn(projected, "offerSdp"), false);
  assert.equal(Object.hasOwn(projected, "pairingDocKey"), false);
  assert.equal(Object.values(projected).includes("turn:secret.example:3478"), false);

  const sanitized = sanitizeSessionAnalyticsSource(source);
  assert.equal(Object.hasOwn(sanitized, "offerSdp"), false);
  assert.equal(Object.values(sanitized).includes("turn:secret.example:3478"), false);
  assert.equal(sanitized.babyActiveTurnProvider, "observed");
});

test("segment projection indexes only civil days continued after creation", () => {
  const projected = mergeSegment(null, segment({
    createdAt: new Date("2026-08-31T21:59:00Z"),
    lastRelevantAt: new Date("2026-08-31T22:00:05Z"),
  }));
  assert.deepEqual(projected.continuedDays, ["2026-09-01"]);
});

test("server-observed source time wins over a client-writable updatedAt", () => {
  const observedAt = new Date("2026-08-31T08:04:00Z");
  const projected = buildSegmentProjection({
    pairingDocKey: "a".repeat(64),
    createdAt: new Date("2026-08-31T08:00:00Z"),
    updatedAt: new Date("2099-01-01T00:00:00Z"),
    status: "connected",
  }, {
    pairingId: PAIRING_A,
    keyVersion: 1,
    captureSource: "live",
    sourceUpdateTime: observedAt,
  });
  assert.equal(projected.successAt.toISOString(), observedAt.toISOString());
  assert.equal(projected.lastRelevantAt.toISOString(), observedAt.toISOString());
});

test("client timestamps cannot move a segment day or retention anchor into the future", () => {
  const observedAt = new Date("2026-08-31T08:04:00Z");
  const projected = buildSegmentProjection({
    pairingDocKey: "a".repeat(64),
    createdAt: new Date("2099-01-01T00:00:00Z"),
    updatedAt: new Date("2099-01-01T00:00:00Z"),
    signalingClearedAt: new Date("2099-01-01T00:00:00Z"),
    status: "connected",
    qualityEventsTail: [{ type: "full_reconnect", timestamp: "2099-01-01T00:00:00Z" }],
  }, {
    pairingId: PAIRING_A,
    keyVersion: 1,
    captureSource: "live",
    sourceUpdateTime: observedAt,
  });
  assert.equal(projected.createdAt.toISOString(), observedAt.toISOString());
  assert.equal(projected.successAt.toISOString(), observedAt.toISOString());
  assert.equal(projected.lastRelevantAt.toISOString(), observedAt.toISOString());
  assert.equal(projected.sourceUpdateTime.toISOString(), observedAt.toISOString());
});

test("irrelevant session updates do not trigger a segment write", () => {
  const before = {
    pairingDocKey: "a".repeat(64),
    createdAt: new Date("2026-08-31T08:00:00Z"),
    updatedAt: new Date("2026-08-31T08:01:00Z"),
    status: "waiting",
    offerSdp: "one",
  };
  const after = { ...before, updatedAt: new Date("2026-08-31T08:02:00Z"), offerSdp: "two" };
  assert.equal(hasRelevantSessionChange(before, after), false);
  assert.equal(hasRelevantSessionChange(before, { ...after, status: "connected" }), true);
});

test("out-of-order and duplicate events cannot downgrade and may add monotone evidence", () => {
  const newer = segment({
    sourceUpdateTime: new Date("2026-08-31T08:10:00Z"),
    everConnected: true,
    successAt: new Date("2026-08-31T08:03:00Z"),
    successDay: "2026-08-31",
    babyPremium: "true",
    parentPremium: "false",
    captureSource: "live",
  });
  const older = segment({
    sourceUpdateTime: new Date("2026-08-31T08:05:00Z"),
    babyPremium: "missing",
    captureSource: "backfill",
  });
  const staleMerged = mergeSegment(newer, older);
  assert.equal(staleMerged.everConnected, true);
  assert.equal(staleMerged.babyPremium, "true");
  assert.equal(
    staleMerged.sourceUpdateTime.toISOString(),
    newer.sourceUpdateTime.toISOString()
  );

  const sameTime = segment({
    sourceUpdateTime: newer.sourceUpdateTime,
    signalingCleared: true,
    successAt: new Date("2026-08-31T08:02:00Z"),
    successDay: "2026-08-31",
    babyPremium: "false",
    captureSource: "backfill",
  });
  const merged = mergeSegment(newer, sameTime);
  assert.equal(merged.everConnected, true);
  assert.equal(merged.signalingCleared, true);
  assert.equal(merged.babyPremium, "true");
  assert.equal(merged.captureSource, "live");
  assert.equal(merged.successAt.toISOString(), "2026-08-31T08:02:00.000Z");
});

test("a formerly anonymous coverage segment adopts one consistent pairing namespace", () => {
  const anonymous = segment({
    pairingId: null,
    reviewId: null,
    keyVersion: 1,
    captureStatus: "invalid_source",
  });
  const paired = segment({
    pairingId: "paired-v2",
    reviewId: "review-v2",
    keyVersion: 2,
  });
  const promoted = mergeSegment(anonymous, paired);
  assert.equal(promoted.pairingId, "paired-v2");
  assert.equal(promoted.reviewId, "review-v2");
  assert.equal(promoted.keyVersion, 2);
  assert.equal(promoted.captureStatus, "materialized");

  const laterRotation = mergeSegment(promoted, segment({
    pairingId: "paired-v3",
    reviewId: "review-v3",
    keyVersion: 3,
  }));
  assert.equal(laterRotation.pairingId, "paired-v2");
  assert.equal(laterRotation.reviewId, "review-v2");
  assert.equal(laterRotation.keyVersion, 2);
});

test("segment signature ignores source delivery time but detects new evidence", () => {
  const first = segment({ sourceUpdateTime: new Date("2026-08-31T08:00:00Z") });
  const duplicate = { ...first, sourceUpdateTime: new Date("2026-08-31T08:01:00Z") };
  assert.equal(segmentEvidenceSignature(first), segmentEvidenceSignature(duplicate));
  assert.notEqual(
    segmentEvidenceSignature(first),
    segmentEvidenceSignature({ ...duplicate, activeTurnObserved: true })
  );
});

test("grouping joins normal reconnects, extends full reconnects and honors user end", () => {
  const t0 = new Date("2026-08-31T08:00:00Z");
  const groups = groupSegments([
    segment({ createdAt: t0, lastRelevantAt: new Date("2026-08-31T08:01:00Z") }),
    segment({
      createdAt: new Date("2026-08-31T08:03:30Z"),
      lastRelevantAt: new Date("2026-08-31T08:04:00Z"),
      fullReconnect: true,
    }),
    segment({
      createdAt: new Date("2026-08-31T08:13:00Z"),
      lastRelevantAt: new Date("2026-08-31T08:13:10Z"),
      explicitUserEnd: true,
    }),
    segment({ createdAt: new Date("2026-08-31T08:13:20Z") }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].segments.length, 3);
  assert.equal(groups[1].segments.length, 1);
});

test("normal reconnect gap uses the latest relevant time of the whole current group", () => {
  const groups = groupSegments([
    segment({
      createdAt: new Date("2026-08-31T08:00:00Z"),
      lastRelevantAt: new Date("2026-08-31T08:10:00Z"),
    }),
    segment({
      createdAt: new Date("2026-08-31T08:01:00Z"),
      lastRelevantAt: new Date("2026-08-31T08:01:30Z"),
    }),
    segment({
      createdAt: new Date("2026-08-31T08:12:00Z"),
      lastRelevantAt: new Date("2026-08-31T08:12:10Z"),
    }),
  ]);
  assert.equal(groups.length, 1);
});

test("a long reconnect and a midnight reconnect are estimated consistently", () => {
  const beforeMidnight = segment({
    createdAt: new Date("2026-08-31T21:58:00Z"),
    createdDay: "2026-08-31",
    lastRelevantAt: new Date("2026-08-31T21:59:30Z"),
    fullReconnect: true,
  });
  const afterMidnight = segment({
    createdAt: new Date("2026-08-31T22:07:00Z"),
    createdDay: "2026-09-01",
    lastRelevantAt: new Date("2026-08-31T22:07:30Z"),
    signalingCleared: true,
    successAt: new Date("2026-08-31T22:07:30Z"),
    successDay: "2026-09-01",
  });
  const groups = groupSegments([beforeMidnight, afterMidnight]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].successDay, "2026-09-01");
});

test("the exact ten-minute full-reconnect boundary remains one logical run", () => {
  const groups = groupSegments([
    segment({
      createdAt: new Date("2026-08-31T21:59:00Z"),
      lastRelevantAt: new Date("2026-08-31T22:00:00Z"),
      fullReconnect: true,
    }),
    segment({
      createdAt: new Date("2026-08-31T22:10:00Z"),
      lastRelevantAt: new Date("2026-08-31T22:10:01Z"),
      signalingCleared: true,
      successAt: new Date("2026-08-31T22:10:01Z"),
      successDay: "2026-09-01",
    }),
  ]);
  assert.equal(groups.length, 1);
});

test("classification implements the calibrated 176/71/45-document patterns", () => {
  assert.equal(classifyPairingDay({ rawDocuments: 176, successfulRuns: 1 }).classification, "test");
  assert.equal(classifyPairingDay({ rawDocuments: 71, successfulRuns: 12 }).classification, "test");
  assert.equal(classifyPairingDay({ rawDocuments: 45, successfulRuns: 10 }).classification, "test");
  assert.equal(classifyPairingDay({ rawDocuments: 20, successfulRuns: 1 }).classification, "uncertain");
  assert.equal(classifyPairingDay({ rawDocuments: 8, successfulRuns: 8 }).classification, "uncertain");
  assert.equal(classifyPairingDay({ rawDocuments: 9, successfulRuns: 1, shortGaps: 8, shortGapRatio: 1 }).classification, "likely_real");
});

test("70 percent short-gap threshold uses ceil over N-1 gaps", () => {
  assert.equal(
    classifyPairingDay({ rawDocuments: 10, successfulRuns: 1, shortGaps: 7, shortGapRatio: 7 / 9 }).classification,
    "uncertain"
  );
  assert.equal(
    classifyPairingDay({ rawDocuments: 10, successfulRuns: 1, shortGaps: 6, shortGapRatio: 6 / 9 }).classification,
    "likely_real"
  );
});

test("premium wins; trial requires explicit false/false; unknown stays outside denominator", () => {
  const success = new Date("2026-08-31T08:00:10Z");
  const premium = segment({
    signalingCleared: true,
    successAt: success,
    successDay: "2026-08-31",
    babyPremium: "true",
    parentPremium: "missing",
  });
  const trial = segment({
    createdAt: new Date("2026-08-31T10:00:00Z"),
    lastRelevantAt: new Date("2026-08-31T10:00:00Z"),
    signalingCleared: true,
    successAt: new Date("2026-08-31T10:00:10Z"),
    successDay: "2026-08-31",
    babyPremium: "false",
    parentPremium: "false",
  });
  const unknown = segment({
    createdAt: new Date("2026-08-31T12:00:00Z"),
    lastRelevantAt: new Date("2026-08-31T12:00:00Z"),
    activeTurnObserved: true,
    successAt: new Date("2026-08-31T12:00:10Z"),
    successDay: "2026-08-31",
  });
  const result = buildPairingDaySummaries([premium, trial, unknown], "2026-08-31", {
    autoExclusionEnabled: true,
  });
  assert.deepEqual(result.daily.likelyReal, { premium: 1, trial: 1, unknown: 1, total: 3 });
  assert.equal(result.daily.premiumShare, 0.5);
});

test("premium evidence from any segment wins for an otherwise successful run", () => {
  const premiumBeforeConnect = segment({
    babyPremium: "true",
    lastRelevantAt: new Date("2026-08-31T08:01:00Z"),
  });
  const successfulReconnect = segment({
    createdAt: new Date("2026-08-31T08:02:00Z"),
    lastRelevantAt: new Date("2026-08-31T08:02:10Z"),
    signalingCleared: true,
    successAt: new Date("2026-08-31T08:02:10Z"),
    successDay: "2026-08-31",
    babyPremium: "false",
    parentPremium: "false",
  });

  const [run] = groupSegments([premiumBeforeConnect, successfulReconnect]);
  assert.equal(run.successful, true);
  assert.equal(run.access, "premium");
});

test("unpairable coverage segments never become a synthetic pairing day", () => {
  const invalid = segment({
    pairingId: null,
    reviewId: null,
    captureStatus: "invalid_source",
    signalingCleared: true,
    successAt: new Date("2026-08-31T08:00:10Z"),
    successDay: "2026-08-31",
  });
  const result = buildPairingDaySummaries([invalid], "2026-08-31", {
    autoExclusionEnabled: true,
  });
  assert.equal(result.summaries.length, 0);
  assert.equal(result.daily.successfulRuns, 0);
});

test("manual override wins and disabled automatic exclusion never leaks into likely real", () => {
  const successful = segment({
    signalingCleared: true,
    successAt: new Date("2026-08-31T08:00:10Z"),
    successDay: "2026-08-31",
    babyPremium: "false",
    parentPremium: "false",
  });
  const shadow = buildPairingDaySummaries([successful], "2026-08-31", {
    autoExclusionEnabled: false,
  });
  assert.equal(shadow.daily.unclassified, 1);
  assert.equal(shadow.daily.likelyReal.total, 0);

  const overridden = buildPairingDaySummaries([successful], "2026-08-31", {
    autoExclusionEnabled: false,
    overrides: [{
      id: "override-1",
      pairingId: PAIRING_A,
      classification: "likely_real",
      effectiveFromDay: "2026-08-31",
      effectiveToDay: "2026-08-31",
      reason: "Manuell geprüft",
      createdAt: new Date("2026-08-31T12:00:00Z"),
    }],
  });
  assert.equal(overridden.daily.likelyReal.trial, 1);
  assert.equal(overridden.daily.activeOverrides, 1);
});

test("invalid or missing kill-switch configuration fails closed", () => {
  assert.deepEqual(parseAnalyticsConfig({}), {
    captureEnabled: false,
    aggregationEnabled: false,
    autoExclusionEnabled: false,
    adminVisible: false,
    hmacKeyVersion: null,
  });
  assert.equal(parseAnalyticsConfig({ captureEnabled: "true", hmacKeyVersion: 0 }).captureEnabled, false);
  assert.equal(parseAnalyticsConfig({ hmacKeyVersion: 1 }).hmacKeyVersion, null);
  assert.equal(parseAnalyticsConfig({
    captureEnabled: true,
    aggregationEnabled: true,
    autoExclusionEnabled: true,
    adminVisible: true,
    hmacKeyVersion: "1",
  }).captureEnabled, false);
  assert.deepEqual(parseAnalyticsConfig({
    captureEnabled: true,
    aggregationEnabled: true,
    autoExclusionEnabled: true,
    adminVisible: true,
    hmacKeyVersion: 0,
  }), {
    captureEnabled: false,
    aggregationEnabled: false,
    autoExclusionEnabled: false,
    adminVisible: false,
    hmacKeyVersion: null,
  });
  assert.deepEqual(parseAnalyticsConfig({
    captureEnabled: true,
    aggregationEnabled: true,
    autoExclusionEnabled: false,
    adminVisible: false,
    hmacKeyVersion: 2,
  }), {
    captureEnabled: true,
    aggregationEnabled: true,
    autoExclusionEnabled: false,
    adminVisible: false,
    hmacKeyVersion: 2,
  });
});

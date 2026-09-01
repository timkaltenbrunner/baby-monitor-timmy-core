"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COLLECTIONS,
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
  normalizeOverrideRange,
  openOpaque,
  projectDailyAnalyticsRow,
  querySegmentsForDay,
  rebuildDayFromSummaries,
  sealOpaque,
  validDay,
} = require("../lib/session_analytics_service");

class FakeRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }

  async get() {
    const value = this.db.documents.get(this.path);
    return { exists: value !== undefined, data: () => value, ref: this };
  }

  async set(data, options = {}) {
    const previous = this.db.documents.get(this.path) || {};
    this.db.documents.set(this.path, options.merge ? { ...previous, ...data } : data);
  }

  async update(data) {
    if (!this.db.documents.has(this.path)) {
      const error = new Error("not found");
      error.code = 5;
      throw error;
    }
    await this.set(data, { merge: true });
  }

  async create(data) {
    if (this.db.documents.has(this.path)) {
      const error = new Error("already exists");
      error.code = 6;
      throw error;
    }
    this.db.documents.set(this.path, data);
  }

  async delete() {
    this.db.documents.delete(this.path);
  }
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value?.toDate) return value.toDate().getTime();
  return value;
}

class FakeQuery {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    this.filters = [];
    this.orderField = "__name__";
    this.orderDirection = "asc";
    this.start = null;
    this.end = null;
    this.max = Infinity;
  }

  clone() {
    const query = new FakeQuery(this.db, this.name);
    query.filters = [...this.filters];
    query.orderField = this.orderField;
    query.orderDirection = this.orderDirection;
    query.start = this.start;
    query.end = this.end;
    query.max = this.max;
    return query;
  }

  where(field, operator, value) {
    const query = this.clone();
    query.filters.push({ field, operator, value });
    return query;
  }

  orderBy(field, direction = "asc") {
    const query = this.clone();
    query.orderField = typeof field === "string" ? field : "__name__";
    query.orderDirection = direction;
    return query;
  }

  startAt(value) { const query = this.clone(); query.start = value; return query; }
  endAt(value) { const query = this.clone(); query.end = value; return query; }
  limit(value) { const query = this.clone(); query.max = value; return query; }

  doc(id) {
    const resolved = id || `auto-${++this.db.nextId}`;
    return new FakeRef(this.db, `${this.name}/${resolved}`);
  }

  async get() {
    let docs = [...this.db.documents.entries()]
      .filter(([key]) => key.startsWith(`${this.name}/`) && !key.slice(this.name.length + 1).includes("/"))
      .map(([key, data]) => {
        const ref = new FakeRef(this.db, key);
        return { id: ref.id, ref, exists: true, data: () => data };
      });
    for (const filter of this.filters) {
      docs = docs.filter((doc) => {
        const actual = comparable(doc.data()[filter.field]);
        const expected = comparable(filter.value);
        if (filter.operator === "==") return actual === expected;
        if (filter.operator === ">=") return actual >= expected;
        if (filter.operator === ">") return actual > expected;
        if (filter.operator === "<=") return actual <= expected;
        if (filter.operator === "<") return actual < expected;
        if (filter.operator === "array-contains") {
          return Array.isArray(doc.data()[filter.field]) &&
            doc.data()[filter.field].includes(filter.value);
        }
        throw new Error(`unsupported fake operator ${filter.operator}`);
      });
    }
    const readOrder = (doc) => this.orderField === "__name__"
      ? doc.id
      : comparable(doc.data()[this.orderField]);
    docs.sort((a, b) => {
      const left = readOrder(a);
      const right = readOrder(b);
      const result = left < right ? -1 : (left > right ? 1 : 0);
      return this.orderDirection === "desc" ? -result : result;
    });
    if (this.start !== null) docs = docs.filter((doc) => readOrder(doc) >= this.start);
    if (this.end !== null) docs = docs.filter((doc) => readOrder(doc) <= this.end);
    docs = docs.slice(0, this.max);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeDb {
  constructor() {
    this.documents = new Map();
    this.nextId = 0;
    this.transactionQueue = Promise.resolve();
    this.beforeBatchCommit = null;
  }

  collection(name) {
    return new FakeQuery(this, name);
  }

  doc(path) { return new FakeRef(this, path); }

  batch() {
    const operations = [];
    return {
      set: (ref, data, options) => operations.push(() => ref.set(data, options)),
      update: (ref, data) => operations.push(() => ref.update(data)),
      delete: (ref) => operations.push(() => ref.delete()),
      commit: async () => {
        if (this.beforeBatchCommit) {
          const hook = this.beforeBatchCommit;
          this.beforeBatchCommit = null;
          await hook();
        }
        for (const operation of operations) await operation();
      },
    };
  }

  async runTransaction(callback) {
    const run = this.transactionQueue.then(() => callback({
      get: (ref) => ref.get(),
      set: (ref, data, options) => ref.set(data, options),
      delete: (ref) => ref.delete(),
    }));
    this.transactionQueue = run.catch(() => {});
    return run;
  }
}

test("opaque cursors round-trip without exposing their payload", () => {
  const secret = "q".repeat(64);
  const token = sealOpaque("2026-08-31_internal-pairing-id", secret);
  assert.notEqual(token.includes("internal-pairing-id"), true);
  assert.equal(openOpaque(token, secret), "2026-08-31_internal-pairing-id");
  assert.equal(openOpaque(token, "w".repeat(64)), null);
});

test("a new permanent override bounds superseded permanent state and its retention", async () => {
  const db = new FakeDb();
  const secret = "q".repeat(64);
  const day = "2026-08-31";
  const pairingId = "pairing-private";
  const reviewId = "0123456789abcdef";
  db.documents.set(`${COLLECTIONS.pairingDays}/${day}_${pairingId}`, {
    day, pairingId, reviewId, automaticClassification: "likely_real",
  });
  db.documents.set(`${COLLECTIONS.overrides}/old-open`, {
    pairingId,
    reviewId,
    classification: "test",
    effectiveFromDay: "2026-08-01",
    effectiveToDay: null,
    reason: "earlier permanent correction",
    authorUid: "admin",
    createdAt: new Date("2026-08-01T10:00:00Z"),
  });
  const now = new Date("2026-08-31T10:00:00Z");
  const result = await createOverride(db, {
    reviewToken: sealOpaque(`${day}:${reviewId}`, secret),
    classification: "likely_real",
    effectiveFromDay: day,
    effectiveToDay: null,
    reason: "confirmed real monitoring run",
  }, "admin", secret, { now, autoExclusionEnabled: true });

  assert.equal(result.status, "pending");
  const superseded = db.documents.get(`${COLLECTIONS.overrides}/old-open`);
  assert.equal(superseded.effectiveToDay, "2026-08-30");
  assert.equal(superseded.supersededAt.toISOString(), now.toISOString());
  assert.equal(superseded.expiresAt.toISOString(), "2027-08-30T10:00:00.000Z");
  const active = [...db.documents.entries()]
    .filter(([key, value]) => key.startsWith(`${COLLECTIONS.overrides}/`) && value.classification === "likely_real")
    .map(([, value]) => value);
  assert.equal(active.length, 1);
  assert.equal(Object.hasOwn(active[0], "expiresAt"), false);
  const audit = [...db.documents.entries()]
    .find(([key]) => key.startsWith(`${COLLECTIONS.audit}/`))[1];
  const job = [...db.documents.entries()]
    .find(([key]) => key.startsWith(`${COLLECTIONS.rebuildJobs}/`))[1];
  assert.equal(audit.expiresAt.toISOString(), "2027-08-30T10:00:00.000Z");
  assert.equal(job.expiresAt.toISOString(), "2027-08-30T10:00:00.000Z");
});

test("override creation rejects slot 501 without writing audit or rebuild state", async () => {
  const db = new FakeDb();
  const secret = "q".repeat(64);
  const day = "2026-08-31";
  const reviewId = "0123456789abcdef";
  db.documents.set(`${COLLECTIONS.pairingDays}/${day}_pairing-private`, {
    day, pairingId: "pairing-private", reviewId, automaticClassification: "likely_real",
  });
  for (let index = 0; index < 500; index++) {
    db.documents.set(`${COLLECTIONS.overrides}/existing-${index}`, {
      pairingId: `pairing-${index}`,
      classification: "test",
      effectiveFromDay: day,
      effectiveToDay: day,
      createdAt: new Date("2026-08-31T09:00:00Z"),
    });
  }
  await assert.rejects(() => createOverride(db, {
    reviewToken: sealOpaque(`${day}:${reviewId}`, secret),
    classification: "test",
    effectiveFromDay: day,
    effectiveToDay: day,
    reason: "confirmed test run",
  }, "admin", secret, {
    now: new Date("2026-08-31T10:00:00Z"), autoExclusionEnabled: true,
  }), /Override safety cap reached/);
  assert.equal(
    [...db.documents.keys()].filter((key) => key.startsWith(`${COLLECTIONS.overrides}/`)).length,
    500
  );
  assert.equal([...db.documents.keys()].some((key) => key.startsWith(`${COLLECTIONS.audit}/`)), false);
  assert.equal(
    [...db.documents.keys()].some((key) => key.startsWith(`${COLLECTIONS.rebuildJobs}/`)),
    false
  );
});

test("parallel permanent overrides leave only the latest correction open", async () => {
  const db = new FakeDb();
  const secret = "q".repeat(64);
  const day = "2026-08-31";
  const pairingId = "pairing-private";
  const reviewId = "0123456789abcdef";
  db.documents.set(`${COLLECTIONS.pairingDays}/${day}_${pairingId}`, {
    day, pairingId, reviewId, automaticClassification: "likely_real",
  });
  const input = (classification, reason) => createOverride(db, {
    reviewToken: sealOpaque(`${day}:${reviewId}`, secret),
    classification,
    effectiveFromDay: day,
    effectiveToDay: null,
    reason,
  }, "admin", secret, {
    now: new Date("2026-08-31T10:00:00Z"), autoExclusionEnabled: true,
  });
  await Promise.all([
    input("test", "first confirmed correction"),
    input("likely_real", "second confirmed correction"),
  ]);
  const overrides = [...db.documents.entries()]
    .filter(([key]) => key.startsWith(`${COLLECTIONS.overrides}/`))
    .map(([, value]) => value);
  assert.equal(overrides.length, 2);
  assert.equal(overrides.filter((value) => value.effectiveToDay === null).length, 1);
  assert.equal(overrides.filter((value) => value.supersededAt).length, 1);
});

test("parallel rebuild claims grant one lease only", async () => {
  const db = new FakeDb();
  const ref = db.collection(COLLECTIONS.rebuildJobs).doc("job-1");
  await ref.set({ status: "pending", updatedAt: new Date("2026-08-31T09:00:00Z") });
  const now = new Date("2026-08-31T10:00:00Z");
  const [first, second] = await Promise.all([
    claimRebuildJob(db, ref, now, "lease-a"),
    claimRebuildJob(db, ref, now, "lease-b"),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(db.documents.get(`${COLLECTIONS.rebuildJobs}/job-1`).status, "processing");
});

test("override rebuild never resurrects a summary deleted by concurrent aggregation", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const ref = db.collection(COLLECTIONS.pairingDays).doc(`${day}_private-pairing`);
  await ref.set({
    day,
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    automaticClassification: "likely_real",
    successfulRuns: 1,
  });
  await db.collection(COLLECTIONS.daily).doc(day).set({
    day,
    expiresAt: new Date("2027-08-30T22:00:00Z"),
  });
  db.beforeBatchCommit = () => ref.delete();
  const result = await rebuildDayFromSummaries(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    [],
    new Date("2026-09-02T10:00:00Z")
  );
  assert.equal(result.status, "no_data");
  assert.equal(db.documents.has(ref.path), false);
});

test("override rebuild updates classification without replacing pairing-day fields", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const ref = db.collection(COLLECTIONS.pairingDays).doc(`${day}_private-pairing`);
  const expiresAt = new Date("2027-08-30T22:00:00Z");
  await ref.set({
    day,
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    rawDocuments: 4,
    successfulRuns: 2,
    automaticClassification: "likely_real",
    expiresAt,
  });
  await db.collection(COLLECTIONS.daily).doc(day).set({
    day,
    expiresAt,
  });
  const result = await rebuildDayFromSummaries(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    [],
    new Date("2026-09-02T10:00:00Z")
  );
  assert.equal(result.status, "complete");
  const stored = db.documents.get(ref.path);
  assert.equal(stored.day, day);
  assert.equal(stored.pairingId, "private-pairing");
  assert.equal(stored.rawDocuments, 4);
  assert.equal(stored.expiresAt, expiresAt);
  assert.equal(stored.effectiveClassification, "likely_real");
});

test("override rebuild cannot revive a daily aggregate deleted by retention cleanup", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const ref = db.collection(COLLECTIONS.pairingDays).doc(`${day}_private-pairing`);
  const dailyRef = db.collection(COLLECTIONS.daily).doc(day);
  const expiresAt = new Date("2027-08-30T22:00:00Z");
  await ref.set({
    day,
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    rawDocuments: 1,
    successfulRuns: 1,
    automaticClassification: "likely_real",
    expiresAt,
  });
  await dailyRef.set({ day, expiresAt });
  db.beforeBatchCommit = () => dailyRef.delete();
  const result = await rebuildDayFromSummaries(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    [],
    new Date("2026-09-02T10:00:00Z")
  );
  assert.equal(result.status, "expired");
  assert.equal(db.documents.has(dailyRef.path), false);
});

test("override rebuild refuses already expired retained data", async () => {
  const db = new FakeDb();
  const day = "2025-09-01";
  await db.collection(COLLECTIONS.pairingDays).doc(`${day}_private-pairing`).set({
    day,
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    automaticClassification: "likely_real",
  });
  const dailyRef = db.collection(COLLECTIONS.daily).doc(day);
  await dailyRef.set({ day, expiresAt: new Date("2026-08-31T09:00:00Z") });
  const result = await rebuildDayFromSummaries(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    [],
    new Date("2026-08-31T10:00:00Z")
  );
  assert.equal(result.status, "expired");
  assert.equal(db.documents.get(dailyRef.path).day, day);
});

test("daily aggregation and override rebuild cannot mutate the same day concurrently", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const now = new Date("2026-09-02T10:00:00Z");
  db.documents.set(`${COLLECTIONS.segments}/segment-1`, {
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    createdDay: day,
    successDay: day,
    createdAt: new Date("2026-08-31T08:00:00Z"),
    lastRelevantAt: new Date("2026-08-31T08:01:00Z"),
    successAt: new Date("2026-08-31T08:01:00Z"),
    everConnected: true,
    babyPremium: "false",
    parentPremium: "false",
    captureStatus: "materialized",
  });
  let concurrentResult;
  db.beforeBatchCommit = async () => {
    concurrentResult = await rebuildDayFromSummaries(
      db,
      day,
      { aggregationEnabled: true, autoExclusionEnabled: true },
      [],
      now
    );
  };
  const aggregateResult = await aggregateDay(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    now
  );
  assert.equal(aggregateResult.status, "complete");
  assert.equal(concurrentResult.status, "busy");
  const stored = db.documents.get(`${COLLECTIONS.pairingDays}/${day}_private-pairing`);
  assert.equal(stored.day, day);
  assert.equal(stored.successfulRuns, 1);
});

test("capture during aggregation refreshes an old dirty marker and keeps the day queued", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const aggregationStartedAt = new Date("2026-09-02T10:00:00Z");
  const lateCaptureAt = new Date("2026-09-02T10:00:01Z");
  const createdAt = new Date("2026-08-31T08:00:00Z");
  db.documents.set(`${COLLECTIONS.segments}/segment-1`, {
    pairingId: "private-pairing",
    reviewId: "0123456789abcdef",
    createdDay: day,
    successDay: day,
    createdAt,
    lastRelevantAt: createdAt,
    successAt: createdAt,
    everConnected: true,
    babyPremium: "false",
    parentPremium: "false",
    captureStatus: "materialized",
    sourceUpdateTime: createdAt,
  });
  db.documents.set(`${COLLECTIONS.dirtyDays}/${day}`, {
    day,
    dirtyAt: new Date("2026-09-02T09:00:00Z"),
  });
  db.beforeBatchCommit = async () => {
    await captureSessionSnapshot({
      db,
      sessionId: "segment-1",
      data: {
        pairingDocKey: "a".repeat(64),
        createdAt,
        status: "connected",
        babyPremium: true,
        parentPremium: false,
      },
      sourceUpdateTime: lateCaptureAt,
      captureSource: "live",
      hmacSecret: "h".repeat(64),
      config: { captureEnabled: true, hmacKeyVersion: 1 },
      now: lateCaptureAt,
      markerNow: lateCaptureAt,
    });
  };

  const result = await aggregateDay(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    aggregationStartedAt
  );
  assert.equal(result.status, "complete");
  const dirty = db.documents.get(`${COLLECTIONS.dirtyDays}/${day}`);
  assert.equal(dirty.dirtyAt.toISOString(), lateCaptureAt.toISOString());
});

test("a marker written after an aggregation cutoff uses post-commit time and survives clear", async () => {
  const db = new FakeDb();
  const day = "2026-08-31";
  const factStartedAt = new Date("2026-09-02T09:59:59Z");
  const aggregationCutoff = new Date("2026-09-02T10:00:00Z");
  const markerWrittenAt = new Date("2026-09-02T10:00:01Z");
  const createdAt = new Date("2026-08-31T08:00:00Z");
  const common = {
    db,
    sessionId: "post-query-fact",
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
  };
  await captureSessionSnapshot({
    ...common,
    data: {
      pairingDocKey: "a".repeat(64),
      createdAt,
      status: "waiting",
    },
    sourceUpdateTime: createdAt,
    now: createdAt,
    markerNow: createdAt,
  });
  await captureSessionSnapshot({
    ...common,
    data: {
      pairingDocKey: "a".repeat(64),
      createdAt,
      status: "connected",
      babyPremium: false,
      parentPremium: false,
    },
    sourceUpdateTime: factStartedAt,
    now: factStartedAt,
    markerNow: markerWrittenAt,
  });
  const result = await aggregateDay(
    db,
    day,
    { aggregationEnabled: true, autoExclusionEnabled: true },
    aggregationCutoff
  );
  assert.equal(result.status, "complete");
  const marker = db.documents.get(`${COLLECTIONS.dirtyDays}/${day}`);
  assert.equal(marker.dirtyAt.toISOString(), markerWrittenAt.toISOString());
});

test("override ranges validate calendar days and cap at 365 days", () => {
  assert.equal(validDay("2026-08-31"), true);
  assert.equal(validDay("2026-02-31"), false);
  assert.equal(daySpanInclusive("2026-01-01", "2026-12-31"), 365);
  assert.equal(daySpanInclusive("2026-12-31", "2026-01-01"), null);
  const now = new Date("2026-08-31T10:00:00Z");
  assert.deepEqual(
    normalizeOverrideRange({ effectiveToDay: null }, "2026-08-31", now),
    { effectiveFromDay: "2026-08-31", effectiveToDay: null }
  );
  assert.throws(
    () => normalizeOverrideRange({ effectiveFromDay: "2025-08-31" }, "2026-08-31", now),
    /rolling 365-day/
  );
  assert.throws(
    () => normalizeOverrideRange({ effectiveFromDay: "2026-09-01" }, "2026-08-31", now),
    /rolling 365-day/
  );
  assert.throws(
    () => normalizeOverrideRange({ effectiveToDay: "" }, "2026-08-31", now),
    /between 1 and 365 days/
  );
  assert.throws(
    () => normalizeOverrideRange({ effectiveToDay: "2026-09-01" }, "2026-08-31", now),
    /between 1 and 365 days/
  );
});

test("calendar ranges preserve missing days as gaps rather than fabricated zero days", () => {
  assert.deepEqual(fillCalendarDays([
    { day: "2026-08-29", dataStatus: "aggregated", successfulRuns: 2 },
    { day: "2026-08-31", dataStatus: "aggregated", successfulRuns: 1 },
  ], "2026-08-29", "2026-08-31"), [
    { day: "2026-08-29", dataStatus: "aggregated", successfulRuns: 2 },
    { day: "2026-08-30", dataStatus: "missing", complete: false },
    { day: "2026-08-31", dataStatus: "aggregated", successfulRuns: 1 },
  ]);
});

test("daily analytics uses Zurich calendar days only inside known capture coverage", async () => {
  const db = new FakeDb();
  db.documents.set(`${COLLECTIONS.daily}/2026-08-29`, {
    day: "2026-08-29", complete: true, successfulRuns: 2,
  });
  db.documents.set(`${COLLECTIONS.daily}/2026-08-31`, {
    day: "2026-08-31", complete: false, successfulRuns: 1,
  });
  const result = await getDailyAnalytics(db, 30, {
    autoExclusionEnabled: false,
    captureStartedAt: new Date("2026-08-28T08:00:00Z"),
  }, new Date("2026-09-01T08:00:00Z"));
  assert.equal(result.dataStartDay, "2026-08-28");
  assert.deepEqual(result.days.map((day) => [day.day, day.dataStatus]), [
    ["2026-08-28", "missing"],
    ["2026-08-29", "aggregated"],
    ["2026-08-30", "missing"],
    ["2026-08-31", "aggregated"],
  ]);
  assert.equal(result.lastCompleteDay, "2026-08-29");
});

test("day query includes both sides of the exact ten-minute midnight boundary", async () => {
  const db = new FakeDb();
  db.documents.set(`${COLLECTIONS.segments}/before`, {
    marker: "before",
    pairingId: "pairing",
    createdDay: "2026-09-01",
    successDay: "2026-09-01",
    createdAt: new Date("2026-09-01T21:58:00Z"),
    successAt: new Date("2026-09-01T21:58:01Z"),
    lastRelevantAt: new Date("2026-09-01T22:00:00Z"),
    everConnected: true,
    fullReconnect: true,
  });
  db.documents.set(`${COLLECTIONS.segments}/after-exact`, {
    marker: "after-exact",
    pairingId: "pairing",
    createdDay: "2026-09-02",
    successDay: "2026-09-02",
    createdAt: new Date("2026-09-01T22:10:00Z"),
    lastRelevantAt: new Date("2026-09-01T22:10:00Z"),
    everConnected: true,
  });
  const segments = await querySegmentsForDay(db, "2026-09-01");
  assert.deepEqual(new Set(segments.map((segment) => segment.marker)), new Set([
    "before", "after-exact",
  ]));
});

test("day query includes a previous-day segment whose reconnect fact arrives after midnight", async () => {
  const db = new FakeDb();
  db.documents.set(`${COLLECTIONS.segments}/previous`, {
    marker: "previous",
    createdDay: "2026-08-31",
    successDay: "2026-08-31",
    createdAt: new Date("2026-08-31T21:50:00Z"),
    successAt: new Date("2026-08-31T21:51:00Z"),
    lastRelevantAt: new Date("2026-08-31T22:00:05Z"),
    continuedDays: ["2026-09-01"],
    fullReconnect: true,
  });
  db.documents.set(`${COLLECTIONS.segments}/next`, {
    marker: "next",
    createdDay: "2026-09-01",
    successDay: "2026-09-01",
    createdAt: new Date("2026-08-31T22:00:10Z"),
    successAt: new Date("2026-08-31T22:00:11Z"),
    lastRelevantAt: new Date("2026-08-31T22:00:11Z"),
  });
  const segments = await querySegmentsForDay(db, "2026-09-01");
  assert.deepEqual(new Set(segments.map((segment) => segment.marker)), new Set([
    "previous", "next",
  ]));
});

test("day query follows a post-midnight reconnect chain for late premium evidence", async () => {
  const db = new FakeDb();
  db.documents.set(`${COLLECTIONS.segments}/origin`, {
    marker: "origin",
    pairingId: "pairing",
    createdDay: "2026-08-31",
    successDay: "2026-08-31",
    createdAt: new Date("2026-08-31T21:50:00Z"),
    successAt: new Date("2026-08-31T21:51:00Z"),
    lastRelevantAt: new Date("2026-08-31T22:08:00Z"),
    everConnected: true,
    fullReconnect: true,
  });
  db.documents.set(`${COLLECTIONS.segments}/late-premium`, {
    marker: "late-premium",
    pairingId: "pairing",
    createdDay: "2026-09-01",
    successDay: "2026-09-01",
    createdAt: new Date("2026-08-31T22:18:00Z"),
    lastRelevantAt: new Date("2026-08-31T22:18:00Z"),
    everConnected: true,
    parentPremium: "true",
  });
  const segments = await querySegmentsForDay(db, "2026-08-31");
  assert.deepEqual(new Set(segments.map((segment) => segment.marker)), new Set([
    "origin", "late-premium",
  ]));
});

test("pairing-day review pagination returns every item without exposing internal ids", async () => {
  const db = new FakeDb();
  const secret = "p".repeat(64);
  const day = "2026-08-31";
  for (let index = 0; index < 30; index++) {
    const suffix = String(index).padStart(2, "0");
    db.documents.set(`${COLLECTIONS.pairingDays}/${day}_pair-${suffix}`, {
      day,
      pairingId: `private-pair-${suffix}`,
      reviewId: `${suffix.padStart(16, "0")}`,
      rawDocuments: 1,
      successfulRuns: 1,
      automaticClassification: "likely_real",
      automaticRules: ["no_exclusion_rule_matched"],
    });
  }
  const first = await listPairingDaysPage(db, {
    day, classification: "all", pageSize: 25, secret, autoExclusionEnabled: true,
  });
  const second = await listPairingDaysPage(db, {
    day,
    classification: "all",
    pageSize: 25,
    cursor: first.nextCursor,
    secret,
    autoExclusionEnabled: true,
  });
  assert.equal(first.items.length, 25);
  assert.equal(second.items.length, 5);
  assert.equal(first.items.some((item) => item.pairingId.includes("private-pair")), false);
});

test("retention cleanup drains multiple batches", async () => {
  const db = new FakeDb();
  const now = new Date("2026-08-31T10:00:00Z");
  for (let index = 0; index < 805; index++) {
    db.documents.set(`${COLLECTIONS.segments}/expired-${index}`, {
      expiresAt: new Date("2026-08-30T10:00:00Z"),
    });
  }
  const result = await cleanupExpiredAnalytics(db, now);
  assert.equal(result.deleted, 805);
  assert.deepEqual(result.cappedCollections, []);
  assert.equal([...db.documents.keys()].some((key) => key.startsWith(`${COLLECTIONS.segments}/`)), false);
});

test("retention cleanup reports a capped collection for immediate retry", async () => {
  const db = new FakeDb();
  const now = new Date("2026-08-31T10:00:00Z");
  for (let index = 0; index < 5001; index++) {
    db.documents.set(`${COLLECTIONS.segments}/expired-cap-${index}`, {
      expiresAt: new Date("2026-08-30T10:00:00Z"),
    });
  }
  const result = await cleanupExpiredAnalytics(db, now);
  assert.equal(result.deleted, 5000);
  assert.deepEqual(result.cappedCollections, [COLLECTIONS.segments]);
  assert.equal(
    [...db.documents.keys()].filter((key) => key.startsWith(`${COLLECTIONS.segments}/`)).length,
    1
  );
});

test("daily aggregates retain a switch-independent automatic shadow breakdown", () => {
  const daily = aggregateDailyFromSummaries([
    {
      successfulRuns: 2,
      premiumRuns: 1,
      trialRuns: 1,
      unknownAccessRuns: 0,
      automaticClassification: "likely_real",
      effectiveClassification: "unclassified",
    },
    {
      successfulRuns: 5,
      premiumRuns: 0,
      trialRuns: 5,
      unknownAccessRuns: 0,
      automaticClassification: "test",
      effectiveClassification: "unclassified",
    },
    {
      successfulRuns: 1,
      premiumRuns: 0,
      trialRuns: 0,
      unknownAccessRuns: 1,
      automaticClassification: "uncertain",
      effectiveClassification: "unclassified",
    },
    {
      successfulRuns: 1,
      premiumRuns: 1,
      trialRuns: 0,
      unknownAccessRuns: 0,
      automaticClassification: "test",
      effectiveClassification: "likely_real",
      overrideId: "override-1",
      overrideClassification: "likely_real",
    },
  ], "2026-08-31", {
    capturedDocuments: 10,
    materializedDocuments: 9,
    invalidSourceDocuments: 1,
    successfulEvidenceDocuments: 8,
  });

  assert.deepEqual(daily.automaticLikelyReal, {
    premium: 1, trial: 1, unknown: 0, total: 2,
  });
  assert.equal(daily.automaticTest, 5);
  assert.equal(daily.automaticUncertain, 1);
  assert.equal(daily.automaticSuccessfulRuns, 8);
  assert.equal(daily.manualLikelyReal.total, 1);
  assert.equal(daily.materializationShare, 0.9);
  assert.equal(daily.invalidSourceDocuments, 1);
});

test("automatic exclusion can switch shadow aggregates on and off at read time", () => {
  const row = {
    day: "2026-08-31",
    likelyReal: { premium: 0, trial: 0, unknown: 0, total: 0 },
    unclassified: 8,
    successfulRuns: 9,
    manualLikelyReal: { premium: 1, trial: 0, unknown: 0, total: 1 },
    manualTest: 0,
    automaticLikelyReal: { premium: 1, trial: 1, unknown: 0, total: 2 },
    automaticTest: 5,
    automaticUncertain: 1,
    automaticSuccessfulRuns: 8,
  };

  const shadow = projectDailyAnalyticsRow(row, false);
  assert.deepEqual(shadow.likelyReal, row.manualLikelyReal);
  assert.equal(shadow.unclassified, 8);
  assert.equal(shadow.test, 0);

  const enabled = projectDailyAnalyticsRow(row, true);
  assert.deepEqual(enabled.likelyReal, {
    premium: 2, trial: 1, unknown: 0, total: 3,
  });
  assert.equal(enabled.test, 5);
  assert.equal(enabled.uncertain, 1);
  assert.equal(enabled.unclassified, 0);
});

test("capture writes one private segment and dirty markers, never raw signaling", async () => {
  const db = new FakeDb();
  const sourceUpdateTime = new Date("2026-08-31T08:02:00Z");
  const result = await captureSessionSnapshot({
    db,
    sessionId: "raw-session-1",
    data: {
      pairingDocKey: "a".repeat(64),
      createdAt: new Date("2026-08-31T08:00:00Z"),
      updatedAt: sourceUpdateTime,
      signalingClearedAt: new Date("2026-08-31T08:01:00Z"),
      status: "connected",
      babyPremium: false,
      parentPremium: false,
      offerSdp: "secret-offer",
      answerSdp: "secret-answer",
      babyActiveTurnUrl: "turn:secret.example:3478",
    },
    sourceUpdateTime,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T08:02:02Z"),
  });
  assert.equal(result.status, "created");
  const stored = db.documents.get(`${COLLECTIONS.segments}/raw-session-1`);
  assert.equal(stored.captureLagMs, 2000);
  assert.equal(stored.expiresAt.toISOString(), "2026-10-04T08:02:02.000Z");
  assert.equal(stored.signalingCleared, true);
  assert.equal(stored.everConnected, true);
  assert.equal(Object.hasOwn(stored, "pairingDocKey"), false);
  assert.equal(Object.hasOwn(stored, "offerSdp"), false);
  assert.equal(Object.hasOwn(stored, "answerSdp"), false);
  assert.equal(Object.values(stored).includes("turn:secret.example:3478"), false);
  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-08-31`), true);

  const duplicate = await captureSessionSnapshot({
    db,
    sessionId: "raw-session-1",
    data: {
      pairingDocKey: "a".repeat(64),
      createdAt: new Date("2026-08-31T08:00:00Z"),
      updatedAt: sourceUpdateTime,
      signalingClearedAt: new Date("2026-08-31T08:01:00Z"),
      status: "connected",
      babyPremium: false,
      parentPremium: false,
      babyActiveTurnUrl: "turn:secret.example:3478",
    },
    sourceUpdateTime,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T08:03:00Z"),
  });
  assert.equal(duplicate.status, "unchanged");
  assert.equal(db.documents.size, 2);
});

test("an unchanged Eventarc retry repairs a stale dirty marker after fact commit", async () => {
  const db = new FakeDb();
  const sourceUpdateTime = new Date("2026-08-31T08:02:00Z");
  const capturedAt = new Date("2026-08-31T08:02:02Z");
  const input = {
    db,
    sessionId: "retry-after-marker-failure",
    data: {
      pairingDocKey: "a".repeat(64),
      createdAt: new Date("2026-08-31T08:00:00Z"),
      status: "connected",
      babyPremium: false,
      parentPremium: false,
    },
    sourceUpdateTime,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
  };
  await captureSessionSnapshot({ ...input, now: capturedAt, markerNow: capturedAt });
  db.documents.set(`${COLLECTIONS.dirtyDays}/2026-08-31`, {
    day: "2026-08-31",
    dirtyAt: new Date("2026-08-31T08:01:00Z"),
  });

  const retry = await captureSessionSnapshot({
    ...input,
    now: new Date("2026-08-31T08:03:00Z"),
    markerNow: new Date("2026-08-31T08:03:00Z"),
  });
  assert.equal(retry.status, "unchanged");
  const repaired = db.documents.get(`${COLLECTIONS.dirtyDays}/2026-08-31`);
  assert.equal(repaired.dirtyAt.toISOString(), "2026-08-31T08:03:00.000Z");
});

test("capture materializes an anonymous coverage record when pairingDocKey is missing", async () => {
  const db = new FakeDb();
  const observedAt = new Date("2026-08-31T08:02:00Z");
  const result = await captureSessionSnapshot({
    db,
    sessionId: "legacy-without-pairing",
    data: { createdAt: observedAt, status: "connected", offerSdp: "do-not-copy" },
    sourceUpdateTime: observedAt,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T08:02:02Z"),
  });
  assert.equal(result.status, "invalid_source");
  const stored = db.documents.get(`${COLLECTIONS.segments}/legacy-without-pairing`);
  assert.equal(stored.captureStatus, "invalid_source");
  assert.equal(stored.pairingId, null);
  assert.equal(Object.hasOwn(stored, "offerSdp"), false);
  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-08-31`), true);
});

test("a first-ten-minutes reconnect also marks the preceding Zurich day dirty", async () => {
  const db = new FakeDb();
  const createdAt = new Date("2026-08-31T22:05:00Z"); // 00:05 on 1 September in Zurich
  await captureSessionSnapshot({
    db,
    sessionId: "midnight-reconnect",
    data: {
      pairingDocKey: "b".repeat(64),
      createdAt,
      updatedAt: createdAt,
      status: "connected",
    },
    sourceUpdateTime: createdAt,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T22:05:02Z"),
  });

  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-08-31`), true);
  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-09-01`), true);
});

test("a reconnect at exactly ten minutes after midnight marks the preceding day dirty", async () => {
  const db = new FakeDb();
  const createdAt = new Date("2026-08-31T22:10:00Z");
  await captureSessionSnapshot({
    db,
    sessionId: "midnight-reconnect-boundary",
    data: { pairingDocKey: "d".repeat(64), createdAt, status: "connected" },
    sourceUpdateTime: createdAt,
    captureSource: "live",
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T22:10:02Z"),
  });
  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-08-31`), true);
  assert.equal(db.documents.has(`${COLLECTIONS.dirtyDays}/2026-09-01`), true);
});

test("coalesced event snapshots preserve transient connected evidence in one write", async () => {
  const db = new FakeDb();
  const createdAt = new Date("2026-08-31T08:00:00Z");
  const result = await captureSessionSnapshots({
    db,
    sessionId: "short-connected-session",
    snapshots: [
      {
        data: {
          pairingDocKey: "c".repeat(64), createdAt, status: "waiting", babyPremium: false,
        },
        sourceUpdateTime: createdAt,
        captureSource: "live",
      },
      {
        data: {
          pairingDocKey: "c".repeat(64),
          createdAt,
          status: "connected",
          babyPremium: false,
          parentPremium: false,
        },
        sourceUpdateTime: new Date("2026-08-31T08:00:04Z"),
        captureSource: "live",
      },
      {
        data: {
          pairingDocKey: "c".repeat(64),
          createdAt,
          status: "ended",
          babyPremium: false,
          parentPremium: false,
          qualityEventsTail: [{
            type: "session_end", reason: "user", timestamp: "2026-08-31T08:00:05Z",
          }],
        },
        sourceUpdateTime: new Date("2026-08-31T08:00:05Z"),
        captureSource: "live",
      },
    ],
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: true, hmacKeyVersion: 1 },
    now: new Date("2026-08-31T08:00:13Z"),
  });

  assert.equal(result.status, "created");
  const stored = db.documents.get(`${COLLECTIONS.segments}/short-connected-session`);
  assert.equal(stored.everConnected, true);
  assert.equal(stored.explicitUserEnd, true);
  assert.equal(stored.babyPremium, "false");
  assert.equal(stored.parentPremium, "false");
  assert.equal(db.documents.size, 2);
});

test("disabled capture performs no database operation", async () => {
  const db = new FakeDb();
  const result = await captureSessionSnapshot({
    db,
    sessionId: "ignored",
    data: {},
    hmacSecret: "h".repeat(64),
    config: { captureEnabled: false, hmacKeyVersion: 1 },
  });
  assert.equal(result.status, "disabled");
  assert.equal(db.documents.size, 0);
});

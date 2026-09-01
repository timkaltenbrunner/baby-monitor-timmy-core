"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBackfillDocumentEligible,
} = require("../scripts/backfill_session_analytics");

test("backfill trusts Firestore updateTime rather than client-writable createdAt", () => {
  const now = new Date("2026-09-01T10:00:00Z");
  const cutoff = new Date("2026-08-31T10:00:00Z");
  const doc = (updateTime) => ({
    updateTime,
    data: () => ({ createdAt: new Date("2099-01-01T00:00:00Z") }),
  });

  assert.equal(isBackfillDocumentEligible(doc(cutoff), cutoff, now), true);
  assert.equal(isBackfillDocumentEligible(doc(now), cutoff, now), true);
  assert.equal(
    isBackfillDocumentEligible(doc(new Date("2026-08-31T09:59:59Z")), cutoff, now),
    false
  );
  assert.equal(
    isBackfillDocumentEligible(doc(new Date("2026-09-01T10:00:01Z")), cutoff, now),
    false
  );
  assert.equal(isBackfillDocumentEligible(doc(null), cutoff, now), false);
});

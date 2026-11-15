"use strict";

const { FieldPath } = require("firebase-admin/firestore");
const { DAY_MS, HOUR_MS, shouldDeleteCleanupDoc } = require("./cleanup_helpers");

const PAGE_SIZE = 50;
const CANDIDATE_BUDGET = 400;
const CANDIDATE_COLLECTIONS = ["candidates_baby", "candidates_parent"];

async function cleanSession(db, ref, now, remaining) {
  return db.runTransaction(async (tx) => {
    const session = await tx.get(ref);
    if (!session.exists || !shouldDeleteCleanupDoc("sessions", session.data(), now)) {
      return { candidates: 0, deleted: false, deferred: false };
    }

    const candidates = [];
    let deferred = false;
    for (const side of CANDIDATE_COLLECTIONS) {
      const capacity = remaining - candidates.length;
      const page = await tx.get(ref.collection(side).select().limit(capacity + 1));
      candidates.push(...page.docs.slice(0, capacity));
      if (page.size > capacity) {
        deferred = true;
        break;
      }
    }
    for (const candidate of candidates) tx.delete(candidate.ref);
    if (!deferred) tx.delete(ref);
    return { candidates: candidates.length, deleted: !deferred, deferred };
  });
}

async function cleanDocument(db, ref, collection, now) {
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists || !shouldDeleteCleanupDoc(collection, doc.data(), now)) return false;
    tx.delete(ref);
    return true;
  });
}

async function runStaleCleanup(db, now = new Date()) {
  const oneHourAgo = new Date(now.getTime() - HOUR_MS);
  const oneDayAgo = new Date(now.getTime() - DAY_MS);
  const checkpoint = db.doc("maintenance/firestoreCleanup");
  const cursor = (await checkpoint.get()).get("endedPairingCursor");
  let ended = db.collection("pairings").where("status", "==", "ended")
    .orderBy(FieldPath.documentId());
  if (typeof cursor === "string" && cursor) ended = ended.startAfter(cursor);

  const [sessions, codes, agedPairings, endedPairings, gifts] = await Promise.all([
    db.collection("sessions").where("createdAt", "<", oneDayAgo).limit(PAGE_SIZE + 1).get(),
    db.collection("pairing_codes").where("createdAt", "<", oneHourAgo).limit(PAGE_SIZE + 1).get(),
    db.collection("pairings").where("updatedAt", "<", oneDayAgo).limit(PAGE_SIZE + 1).get(),
    ended.limit(PAGE_SIZE + 1).get(),
    db.collection("gift_codes").where("expiresAt", "<", now).limit(PAGE_SIZE + 1).get(),
  ]);

  const result = {
    deleted: { sessions: 0, candidates: 0, pairing_codes: 0, pairings: 0, gift_codes: 0 },
    more: {
      sessions: sessions.size > PAGE_SIZE,
      pairing_codes: codes.size > PAGE_SIZE,
      pairings: agedPairings.size > PAGE_SIZE,
      endedPairings: endedPairings.size > PAGE_SIZE,
      gift_codes: gifts.size > PAGE_SIZE,
    },
    errors: {},
  };

  async function attempt(collection, operation) {
    try {
      await operation();
    } catch (error) {
      const key = `${collection}:${error.code || "unknown"}`;
      result.errors[key] = (result.errors[key] || 0) + 1;
    }
  }

  for (const doc of sessions.docs.slice(0, PAGE_SIZE)) {
    const remaining = CANDIDATE_BUDGET - result.deleted.candidates;
    if (remaining === 0) {
      result.more.sessions = true;
      break;
    }
    await attempt("sessions", async () => {
      const outcome = await cleanSession(db, doc.ref, now, remaining);
      result.deleted.candidates += outcome.candidates;
      if (outcome.deleted) result.deleted.sessions++;
      if (outcome.deferred) result.more.sessions = true;
    });
  }

  const endedPage = endedPairings.docs.slice(0, PAGE_SIZE);
  const pairings = new Map(
    [...agedPairings.docs.slice(0, PAGE_SIZE), ...endedPage].map((doc) => [doc.id, doc])
  );
  for (const [collection, docs] of [
    ["pairing_codes", codes.docs.slice(0, PAGE_SIZE)],
    ["pairings", pairings.values()],
    ["gift_codes", gifts.docs.slice(0, PAGE_SIZE)],
  ]) {
    for (const doc of docs) {
      await attempt(collection, async () => {
        if (await cleanDocument(db, doc.ref, collection, now)) result.deleted[collection]++;
      });
    }
  }

  // Walk ended pairings in document ID order without a composite index.
  const nextCursor = result.more.endedPairings ? endedPage.at(-1).id : null;
  if (nextCursor !== (cursor || null)) {
    await checkpoint.set({ endedPairingCursor: nextCursor }, { merge: true });
  }
  return result;
}

module.exports = { cleanSession, runStaleCleanup };

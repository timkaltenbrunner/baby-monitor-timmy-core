#!/usr/bin/env node
"use strict";

// One-time, bounded import of the raw session documents that still exist at
// rollout. It never reads older than 24 hours and uses the same idempotent
// segment ids as the live trigger, so trigger/backfill races are harmless.

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const {
  captureSessionSnapshot,
  loadAnalyticsConfig,
} = require("../lib/session_analytics_service");
const { normalizeAnalyticsSecret } = require("../lib/session_analytics_helpers");

const MAX_BACKFILL_DOCUMENTS = 5000;

function isBackfillDocumentEligible(doc, cutoff, now) {
  const updateTime = doc?.updateTime?.toDate
    ? doc.updateTime.toDate()
    : (doc?.updateTime instanceof Date ? doc.updateTime : null);
  return Boolean(
    updateTime &&
    updateTime.getTime() >= cutoff.getTime() &&
    updateTime.getTime() <= now.getTime()
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const secret = normalizeAnalyticsSecret(process.env.SESSION_ANALYTICS_HMAC_KEY);
  if (!dryRun && !secret) {
    throw new Error("SESSION_ANALYTICS_HMAC_KEY must be provided without printing it");
  }
  initializeApp({ credential: applicationDefault(), projectId: "baby-monitor-timmy" });
  const db = getFirestore();
  const config = await loadAnalyticsConfig(db);
  if (!config.captureEnabled || !config.hmacKeyVersion) {
    throw new Error("captureEnabled and a valid hmacKeyVersion are required");
  }
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const snap = await db.collection("sessions")
    .where("createdAt", ">=", cutoff)
    .orderBy("createdAt", "asc")
    .limit(MAX_BACKFILL_DOCUMENTS)
    .get();
  if (snap.size >= MAX_BACKFILL_DOCUMENTS) {
    throw new Error(`Backfill safety cap reached (${MAX_BACKFILL_DOCUMENTS}); no writes performed`);
  }
  // `createdAt` is client-writable and is only the bounded query key. The
  // authoritative Firestore update time prevents an old document carrying a
  // future client timestamp from becoming historical analytics evidence.
  const eligibleDocs = snap.docs.filter((doc) =>
    isBackfillDocumentEligible(doc, cutoff, now)
  );
  const skippedUpdateTime = snap.size - eligibleDocs.length;
  console.log(
    `Bounded backfill found ${snap.size} candidates; ` +
    `${eligibleDocs.length} have a server update time in the last 24 hours ` +
    `(${skippedUpdateTime} skipped).`
  );
  if (dryRun) return;

  const counts = {};
  for (const doc of eligibleDocs) {
    const result = await captureSessionSnapshot({
      db,
      sessionId: doc.id,
      data: doc.data() || {},
      sourceUpdateTime: doc.updateTime,
      captureSource: "backfill",
      hmacSecret: secret,
      config,
    });
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  console.log(`Backfill complete: ${JSON.stringify(counts)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Backfill failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { isBackfillDocumentEligible };

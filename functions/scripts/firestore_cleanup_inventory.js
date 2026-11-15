#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { GoogleAuth } = require("google-auth-library");
const { DAY_MS } = require("../lib/cleanup_helpers");

const PROJECT_ID = "baby-monitor-timmy";
const DATABASE = `projects/${PROJECT_ID}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${DATABASE}`;
const MAX_SCAN = 500;
const MAX_DELETES = 100;
const CANDIDATE_SIDES = ["candidates_baby", "candidates_parent"];
const TIMESTAMP_FIELDS = {
  sessions: ["createdAt"],
  pairings: ["createdAt", "updatedAt"],
  pairing_codes: ["createdAt"],
};

function timestampParts(value) {
  const match = typeof value === "string"
    && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  return Number.isFinite(seconds)
    ? { seconds, nanoseconds: Number((match[2] || "").padEnd(9, "0")) }
    : null;
}

function ageEligible(updateTime, now) {
  const seconds = updateTime?.seconds;
  return Number.isFinite(seconds)
    && seconds * 1000 + updateTime.nanoseconds / 1e6 < now.getTime() - DAY_MS;
}

function hasLegacyTimestamp(collection, data, now) {
  return TIMESTAMP_FIELDS[collection].some((field) => {
    const timestamp = data[field];
    return !Number.isFinite(timestamp?.seconds) || !Number.isFinite(timestamp.nanoseconds)
      || timestamp.seconds * 1000 + timestamp.nanoseconds / 1e6 > now.getTime();
  });
}

function isOperation(op) {
  if (!timestampParts(op?.updateTime) || typeof op.path !== "string") return false;
  if (op.kind === "legacy") return /^(sessions|pairings|pairing_codes)\/[^/]+$/.test(op.path);
  if (op.kind === "orphan") {
    return /^sessions\/[^/]+\/(candidates_baby|candidates_parent)\/[^/]+$/.test(op.path);
  }
  return false;
}

async function listDocs(client, path, fields, showMissing, cap) {
  const docs = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ pageSize: String(Math.min(100, cap - docs.length)) });
    if (showMissing) params.set("showMissing", "true");
    if (pageToken) params.set("pageToken", pageToken);
    for (const field of fields) params.append("mask.fieldPaths", field);
    const url = `${API}/${path.split("/").map(encodeURIComponent).join("/")}?${params}`;
    const { data } = await client.request({ url });
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken;
  } while (pageToken && docs.length < cap);
  return { docs, truncated: Boolean(pageToken) };
}

async function inventory(client, now) {
  const operations = [];
  const scanned = {};
  const truncated = [];
  let candidateReadsLeft = MAX_SCAN;
  const relativePath = (doc) => doc.name.slice(DATABASE.length + 1);

  for (const [collection, fields] of Object.entries(TIMESTAMP_FIELDS)) {
    const page = await listDocs(client, collection, fields, collection === "sessions", MAX_SCAN);
    scanned[collection] = page.docs.length;
    if (page.truncated) truncated.push(collection);

    for (const doc of page.docs) {
      const path = relativePath(doc);
      if (doc.updateTime) {
        const values = Object.fromEntries(fields.map((field) =>
          [field, timestampParts(doc.fields?.[field]?.timestampValue)]
        ));
        if (ageEligible(timestampParts(doc.updateTime), now)
            && hasLegacyTimestamp(collection, values, now)) {
          operations.push({ kind: "legacy", path, updateTime: doc.updateTime });
        }
      } else if (collection === "sessions") {
        for (const side of CANDIDATE_SIDES) {
          if (candidateReadsLeft === 0) {
            if (!truncated.includes("orphanCandidates")) truncated.push("orphanCandidates");
            break;
          }
          const candidates = await listDocs(client, `${path}/${side}`, ["ts"], false, candidateReadsLeft);
          candidateReadsLeft -= candidates.docs.length;
          if (candidates.truncated && !truncated.includes("orphanCandidates")) {
            truncated.push("orphanCandidates");
          }
          for (const candidate of candidates.docs) {
            if (ageEligible(timestampParts(candidate.updateTime), now)) {
              operations.push({
                kind: "orphan",
                path: relativePath(candidate),
                updateTime: candidate.updateTime,
              });
            }
          }
        }
      }
    }
  }

  scanned.orphanCandidates = MAX_SCAN - candidateReadsLeft;
  return {
    project: PROJECT_ID,
    scanned,
    truncated,
    eligible: operations.length,
    operations: operations.slice(0, MAX_DELETES),
  };
}

async function applyOperation(db, op, now, childBudget = 100) {
  return db.runTransaction(async (tx) => {
    const ref = db.doc(op.path);
    const doc = await tx.get(ref);
    const expected = timestampParts(op.updateTime);
    if (!doc.exists || doc.updateTime.seconds !== expected.seconds
        || doc.updateTime.nanoseconds !== expected.nanoseconds
        || !ageEligible(doc.updateTime, now)) return null;

    let childCount = 0;
    if (op.kind === "orphan") {
      if ((await tx.get(ref.parent.parent)).exists) return null;
    } else {
      const collection = ref.parent.id;
      const values = Object.fromEntries(TIMESTAMP_FIELDS[collection].map((field) => {
        const value = doc.get(field);
        return [field, value instanceof Timestamp ? value : null];
      }));
      if (!hasLegacyTimestamp(collection, values, now)) return null;
      // Sessions can be removed only after both child collections have been read.
      if (collection === "sessions") {
        const children = await Promise.all(CANDIDATE_SIDES.map((side) =>
          tx.get(ref.collection(side).select().limit(51))
        ));
        childCount = children.reduce((total, page) => total + page.size, 0);
        if (childCount > childBudget || children.some((page) => page.size > 50)) return null;
        for (const page of children) {
          for (const child of page.docs) tx.delete(child.ref);
        }
      }
    }
    tx.delete(ref);
    return { childCount };
  });
}

async function main(args) {
  const [mode, file, ...rest] = args;
  if (!file || rest.length || !["--dry-run", "--apply"].includes(mode)) {
    throw new Error("Usage: node scripts/firestore_cleanup_inventory.js --dry-run|--apply <manifest.json>");
  }
  const now = new Date();
  if (mode === "--dry-run") {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] });
    const plan = await inventory(await auth.getClient(), now);
    await fs.writeFile(file, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const { eligible, scanned, truncated, operations } = plan;
    console.log(JSON.stringify({ eligible, proposed: operations.length, scanned, truncated }));
    return;
  }

  const plan = JSON.parse(await fs.readFile(file, "utf8"));
  if (plan.project !== PROJECT_ID || !Array.isArray(plan.operations)
      || plan.operations.length > MAX_DELETES || !plan.operations.every(isOperation)) {
    throw new Error("Invalid cleanup manifest");
  }
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();
  let deleted = 0;
  let deletedChildren = 0;
  for (const op of plan.operations) {
    const result = await applyOperation(db, op, now, 400 - deletedChildren);
    if (result) {
      deleted++;
      deletedChildren += result.childCount;
    }
  }
  console.log(JSON.stringify({ deleted, deletedChildren, skipped: plan.operations.length - deleted }));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Firestore cleanup failed: ${error.code || error.name}`);
    process.exitCode = 1;
  });
}

module.exports = { applyOperation, hasLegacyTimestamp, inventory, isOperation, timestampParts };

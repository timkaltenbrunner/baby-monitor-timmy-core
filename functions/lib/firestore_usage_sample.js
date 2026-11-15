"use strict";

const { createHmac } = require("node:crypto");

const METRIC = "firestore_signaling_usage";

function digest(secret, ...parts) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([METRIC, ...parts]))
    .digest("hex");
}

function bytes(value) {
  return typeof value === "string" ? Buffer.byteLength(value) : null;
}

function sampleCreation(event, kind, percent, secret) {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100
      || typeof secret !== "string" || secret.length < 32
      || !event.data?.exists || !event.id) return null;

  // Firebase Auth principals fall into Eventarc's "unknown" category. An
  // absent auth ID is deliberately left unattributed.
  const principal = event.authType === "unknown" && typeof event.authId === "string"
    ? event.authId
    : null;
  if (!principal && ["service_account", "api_key", "system", "unauthenticated"].includes(event.authType)) {
    return null;
  }
  const eventTime = new Date(event.time);
  if (!Number.isFinite(eventTime.getTime())) return null;
  const day = eventTime.toISOString().slice(0, 10);
  const session = event.params.sessionId
    ? digest(secret, "session", event.params.sessionId).slice(0, 24)
    : null;
  const deviceDay = principal ? digest(secret, "device", day, principal).slice(0, 24) : null;
  // Include every candidate from a selected session. For creation counts
  // include every create by a selected principal on a given UTC day.
  const sampleKey = kind.startsWith("candidates_") ? session : deviceDay;
  const bucket = parseInt(digest(secret, "sample", sampleKey || event.id).slice(0, 8), 16);
  if (bucket / 0x100000000 >= percent / 100) return null;

  const result = {
    metric: METRIC,
    kind,
    day,
    eventKey: digest(secret, "event", event.id).slice(0, 24),
    samplePercent: percent,
  };
  if (kind.startsWith("candidates_")) {
    const data = event.data.data();
    result.session = session;
    result.candidateBytes = bytes(data.candidate);
    result.sdpMidBytes = bytes(data.sdpMid);
  } else {
    result.deviceDay = deviceDay;
  }
  return result;
}

function summarizeSamples(rows) {
  const seen = new Set();
  const creates = {};
  const unattributed = {};
  const candidates = {};
  for (const row of rows) {
    if (row?.metric !== METRIC || !row.eventKey || seen.has(row.eventKey)) continue;
    seen.add(row.eventKey);
    const kind = row.kind;
    if (kind === "sessions" || kind === "pairing_codes") {
      if (!row.deviceDay) {
        unattributed[kind] = (unattributed[kind] || 0) + 1;
        continue;
      }
      const counts = creates[kind] ||= new Map();
      counts.set(row.deviceDay, (counts.get(row.deviceDay) || 0) + 1);
    } else if (kind === "candidates_baby" || kind === "candidates_parent") {
      if (!row.session) continue;
      const stats = candidates[kind] ||= { counts: new Map(), candidateBytes: [], sdpMidBytes: [] };
      stats.counts.set(row.session, (stats.counts.get(row.session) || 0) + 1);
      if (Number.isFinite(row.candidateBytes)) stats.candidateBytes.push(row.candidateBytes);
      if (Number.isFinite(row.sdpMidBytes)) stats.sdpMidBytes.push(row.sdpMidBytes);
    }
  }
  function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return { samples: 0 };
    return {
      samples: sorted.length,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
      max: sorted.at(-1),
    };
  }
  return {
    createsPerDeviceDay: Object.fromEntries(Object.entries(creates).map(([kind, counts]) =>
      [kind, distribution(counts.values())]
    )),
    unattributed,
    candidates: Object.fromEntries(Object.entries(candidates).map(([kind, stats]) => [kind, {
      perSession: distribution(stats.counts.values()),
      candidateBytes: distribution(stats.candidateBytes),
      sdpMidBytes: distribution(stats.sdpMidBytes),
    }])),
  };
}

module.exports = { sampleCreation, summarizeSamples };

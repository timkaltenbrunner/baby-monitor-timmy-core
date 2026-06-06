"use strict";

const ACTIVE_SESSION_STATUSES = new Set(["waiting", "active", "connected"]);

function readNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampToIso(value) {
  const date = value?.toDate?.() || (value instanceof Date ? value : null);
  if (date && Number.isFinite(date.getTime())) {
    return date.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const numericDate = new Date(value);
    return Number.isFinite(numericDate.getTime()) ? numericDate.toISOString() : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

// Numeric epoch-ms variant of timestampToIso, used for grouping/sorting.
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

function sanitizeString(value, maxLength = 128) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, maxLength);
}

function sanitizeAdminEvent(event) {
  if (!event || typeof event !== "object") return null;
  const sanitized = {
    type: sanitizeString(event.type, 64),
    at: timestampToIso(event.at),
  };
  return sanitized.type || sanitized.at ? sanitized : null;
}

function sanitizeSessionDisplayId(id) {
  return sanitizeString(id, 12);
}

function sanitizeAdminSessionDoc(id, data = {}) {
  return {
    id: sanitizeSessionDisplayId(id),
    status: sanitizeString(data.status, 32),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    babyPremium: data.babyPremium === true,
    parentPremium: data.parentPremium === true,
    babyTurnProvider: sanitizeString(data.babyTurnProvider, 96),
    parentTurnProvider: sanitizeString(data.parentTurnProvider, 96),
    babyActiveTurnUrl: sanitizeString(data.babyActiveTurnUrl, 256),
    babyActiveTurnProtocol: sanitizeString(data.babyActiveTurnProtocol, 24),
    babyActiveTurnProvider: sanitizeString(data.babyActiveTurnProvider, 96),
    parentActiveTurnUrl: sanitizeString(data.parentActiveTurnUrl, 256),
    parentActiveTurnProtocol: sanitizeString(data.parentActiveTurnProtocol, 24),
    parentActiveTurnProvider: sanitizeString(data.parentActiveTurnProvider, 96),
    qualityEventCount: readNumber(data.qualityEventCount),
    connectionInterruptionCount: readNumber(data.connectionInterruptionCount),
    turnChangeCount: readNumber(data.turnChangeCount),
    lastQualityEvent: sanitizeAdminEvent(data.lastQualityEvent),
    lastConnectionIssue: sanitizeAdminEvent(data.lastConnectionIssue),
    lastTurnChange: sanitizeAdminEvent(data.lastTurnChange),
  };
}

function summarizeAdminSessions(sessions) {
  let total = 0;
  let connected = 0;
  let waiting = 0;
  let active = 0;
  let premium = 0;
  let free = 0;
  let connectionIssues = 0;
  let turnChanges = 0;
  const byProvider = {};

  for (const session of sessions) {
    total++;
    if (session.status === "connected") connected++;
    else if (session.status === "waiting") waiting++;
    else if (session.status === "active") active++;

    if (session.babyPremium || session.parentPremium) premium++;
    else free++;

    connectionIssues += readNumber(session.connectionInterruptionCount);
    turnChanges += readNumber(session.turnChangeCount);

    const seen = new Set();
    if (session.babyTurnProvider) seen.add(String(session.babyTurnProvider));
    if (session.parentTurnProvider) seen.add(String(session.parentTurnProvider));
    if (seen.size === 0) seen.add("unknown");
    for (const provider of seen) {
      byProvider[provider] = (byProvider[provider] || 0) + 1;
    }
  }

  return {
    total,
    connected,
    waiting,
    active,
    premium,
    free,
    connectionIssues,
    turnChanges,
    byProvider,
  };
}

// Each reconnect creates a brand-new session document (random UUID). They all
// share the same stable pairingDocKey, so we collapse reconnect bursts into one
// "logical session" for the admin overview. Reconnects happen within seconds; a
// gap larger than this means a distinct monitoring session. Tunable.
const RECONNECT_GAP_MS = 3 * 60 * 1000;

// Groups raw session docs (`[{ id, data }]`) by pairingDocKey + time-proximity
// into logical sessions with start/end/reconnect metadata. pairingDocKey is
// itself a non-reversible hash and is never returned in full (only a 12-char
// truncation as an opaque group id), preserving sanitizeAdminSessionDoc's
// privacy posture.
function groupAdminSessions(rawDocs, limit) {
  const entries = rawDocs.map(({ id, data }) => {
    const createdMs = timestampToMs(data.createdAt);
    const updatedMs = timestampToMs(data.updatedAt);
    return {
      id,
      data,
      createdMs: createdMs ?? updatedMs ?? 0,
      endMs: updatedMs ?? createdMs ?? 0,
    };
  });

  // Bucket by pairingDocKey; legacy docs without one become their own group.
  const byPairing = new Map();
  for (const entry of entries) {
    const key =
      typeof entry.data.pairingDocKey === "string" && entry.data.pairingDocKey
        ? entry.data.pairingDocKey
        : `__solo__${entry.id}`;
    if (!byPairing.has(key)) byPairing.set(key, []);
    byPairing.get(key).push(entry);
  }

  const groups = [];
  for (const [pairingKey, list] of byPairing) {
    list.sort((a, b) => a.createdMs - b.createdMs);
    let current = null;
    for (const entry of list) {
      if (current && entry.createdMs - current.lastEndMs <= RECONNECT_GAP_MS) {
        current.docs.push(entry);
        current.lastEndMs = Math.max(current.lastEndMs, entry.endMs);
      } else {
        current = { pairingKey, docs: [entry], lastEndMs: entry.endMs };
        groups.push(current);
      }
    }
  }

  const out = groups.map((group) => {
    const docs = group.docs; // ascending by createdMs
    const first = docs[0];
    const latest = docs[docs.length - 1];
    const sanitizedLatest = sanitizeAdminSessionDoc(latest.id, latest.data);

    const startedAt =
      timestampToIso(first.data.createdAt) || timestampToIso(first.data.updatedAt);
    const lastUpdatedIso =
      timestampToIso(latest.data.updatedAt) || timestampToIso(latest.data.createdAt);
    const ongoing = ACTIVE_SESSION_STATUSES.has(sanitizedLatest.status);

    let durationMs = null;
    if (startedAt && lastUpdatedIso) {
      durationMs = Math.max(
        0,
        new Date(lastUpdatedIso).getTime() - new Date(startedAt).getTime()
      );
    }

    const groupSource = group.pairingKey.startsWith("__solo__")
      ? group.pairingKey.slice("__solo__".length)
      : group.pairingKey;

    return {
      groupId: sanitizeString(groupSource, 12),
      status: sanitizedLatest.status,
      startedAt,
      endedAt: ongoing ? null : lastUpdatedIso,
      durationMs,
      ongoing,
      reconnectCount: docs.length - 1,
      babyPremium: sanitizedLatest.babyPremium,
      parentPremium: sanitizedLatest.parentPremium,
      babyActiveTurnUrl: sanitizedLatest.babyActiveTurnUrl,
      babyActiveTurnProtocol: sanitizedLatest.babyActiveTurnProtocol,
      babyActiveTurnProvider: sanitizedLatest.babyActiveTurnProvider,
      parentActiveTurnUrl: sanitizedLatest.parentActiveTurnUrl,
      parentActiveTurnProtocol: sanitizedLatest.parentActiveTurnProtocol,
      parentActiveTurnProvider: sanitizedLatest.parentActiveTurnProvider,
      connectionInterruptionCount: docs.reduce(
        (sum, doc) => sum + readNumber(doc.data.connectionInterruptionCount),
        0
      ),
      turnChangeCount: docs.reduce(
        (sum, doc) => sum + readNumber(doc.data.turnChangeCount),
        0
      ),
      latestSessionId: sanitizedLatest.id,
    };
  });

  out.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return typeof limit === "number" && limit > 0 ? out.slice(0, limit) : out;
}

module.exports = {
  ACTIVE_SESSION_STATUSES,
  RECONNECT_GAP_MS,
  groupAdminSessions,
  readNumber,
  sanitizeAdminSessionDoc,
  sanitizeSessionDisplayId,
  summarizeAdminSessions,
  timestampToIso,
  timestampToMs,
};

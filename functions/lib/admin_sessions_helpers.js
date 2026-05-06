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

module.exports = {
  ACTIVE_SESSION_STATUSES,
  readNumber,
  sanitizeAdminSessionDoc,
  sanitizeSessionDisplayId,
  summarizeAdminSessions,
  timestampToIso,
};

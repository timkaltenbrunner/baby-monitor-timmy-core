const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeAdminSessionDoc,
  summarizeAdminSessions,
} = require("../lib/admin_sessions_helpers");

test("sanitizeAdminSessionDoc returns dashboard metadata without raw secrets", () => {
  const session = sanitizeAdminSessionDoc("sbm_0123456789abcdef", {
    status: "connected",
    createdAt: new Date("2026-01-02T03:04:05Z"),
    pairingDocKey: "secret-pairing-doc-key",
    offerSdp: "secret-offer",
    answerSdp: "secret-answer",
    rawUid: "uid-1",
    babyPremium: true,
    babyTurnProvider: "local",
    parentTurnProvider: "cloudflare",
    babyActiveTurnUrl: "turn:babymonitor-timmy.duckdns.org:3478?transport=udp",
    babyActiveTurnProtocol: "udp",
    babyActiveTurnProvider: "local",
    connectionInterruptionCount: 2,
    turnChangeCount: 1,
    lastQualityEvent: {
      type: "ice_reconnect",
      at: new Date("2026-01-02T03:05:00Z"),
      detail: "not returned",
    },
  });

  assert.equal(session.id, "sbm_01234567");
  assert.equal(session.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(session.babyPremium, true);
  assert.equal(session.connectionInterruptionCount, 2);
  assert.deepEqual(session.lastQualityEvent, {
    type: "ice_reconnect",
    at: "2026-01-02T03:05:00.000Z",
  });
  assert.equal(Object.hasOwn(session, "pairingDocKey"), false);
  assert.equal(Object.hasOwn(session, "offerSdp"), false);
  assert.equal(Object.hasOwn(session, "answerSdp"), false);
  assert.equal(Object.hasOwn(session, "rawUid"), false);
});

test("summarizeAdminSessions computes active dashboard/live stats", () => {
  const summary = summarizeAdminSessions([
    {
      status: "connected",
      babyPremium: true,
      parentPremium: false,
      babyTurnProvider: "local",
      parentTurnProvider: "local",
      connectionInterruptionCount: 2,
      turnChangeCount: 1,
    },
    {
      status: "waiting",
      babyPremium: false,
      parentPremium: false,
      babyTurnProvider: "cloudflare",
      parentTurnProvider: "",
      connectionInterruptionCount: 0,
      turnChangeCount: 3,
    },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.connected, 1);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.premium, 1);
  assert.equal(summary.free, 1);
  assert.equal(summary.connectionIssues, 2);
  assert.equal(summary.turnChanges, 4);
  assert.deepEqual(summary.byProvider, { local: 1, cloudflare: 1 });
});

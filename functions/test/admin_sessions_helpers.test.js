const test = require("node:test");
const assert = require("node:assert/strict");

const {
  groupAdminSessions,
  sanitizeAdminSessionDoc,
  summarizeAdminSessions,
} = require("../lib/admin_sessions_helpers");

// Helper: build a raw session doc with Date timestamps (Date is accepted by the
// admin timestamp converters, same as a Firestore Timestamp's .toDate()).
function sessionDoc(id, pairingDocKey, createdAt, updatedAt, status) {
  return {
    id,
    data: {
      pairingDocKey,
      createdAt,
      updatedAt: updatedAt ?? createdAt,
      status,
    },
  };
}

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

test("groupAdminSessions collapses a reconnect burst into one logical session", () => {
  const t0 = new Date("2026-06-06T22:00:00Z");
  const t1 = new Date("2026-06-06T22:00:30Z"); // +30s reconnect
  const t2 = new Date("2026-06-06T22:01:10Z"); // +40s reconnect, still connected
  const pk = "a".repeat(64);

  const groups = groupAdminSessions([
    sessionDoc("s1", pk, t0, t0, "ended"),
    sessionDoc("s2", pk, t1, t1, "ended"),
    sessionDoc("s3", pk, t2, new Date("2026-06-06T22:05:00Z"), "connected"),
  ]);

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.reconnectCount, 2);
  assert.equal(group.status, "connected");
  assert.equal(group.ongoing, true);
  assert.equal(group.endedAt, null); // latest still connected → running
  assert.equal(group.startedAt, t0.toISOString());
  assert.equal(group.groupId, pk.slice(0, 12));
});

test("groupAdminSessions splits distinct sessions separated by a large gap", () => {
  const pk = "b".repeat(64);
  const nightA0 = new Date("2026-06-06T22:00:00Z");
  const nightA1 = new Date("2026-06-06T22:00:20Z");
  const nightB0 = new Date("2026-06-07T06:00:00Z"); // 8h later → new session

  const groups = groupAdminSessions([
    sessionDoc("a0", pk, nightA0, nightA0, "ended"),
    sessionDoc("a1", pk, nightA1, new Date("2026-06-07T05:00:00Z"), "ended"),
    sessionDoc("b0", pk, nightB0, nightB0, "ended"),
  ]);

  assert.equal(groups.length, 2);
  // Sorted by startedAt desc → newest first.
  assert.equal(groups[0].startedAt, nightB0.toISOString());
  assert.equal(groups[0].reconnectCount, 0);
  assert.equal(groups[1].startedAt, nightA0.toISOString());
  assert.equal(groups[1].reconnectCount, 1);
  assert.equal(
    groups[1].endedAt,
    new Date("2026-06-07T05:00:00Z").toISOString()
  );
});

test("groupAdminSessions keeps separate pairings apart and honors limit", () => {
  const t = new Date("2026-06-06T22:00:00Z");
  const groups = groupAdminSessions(
    [
      sessionDoc("x", "c".repeat(64), t, t, "ended"),
      sessionDoc("y", "d".repeat(64), t, t, "ended"),
    ],
    1
  );
  assert.equal(groups.length, 1); // limit applied
});

test("groupAdminSessions treats docs without pairingDocKey as singletons", () => {
  const t = new Date("2026-06-06T22:00:00Z");
  const groups = groupAdminSessions([
    sessionDoc("legacy1", undefined, t, t, "ended"),
    sessionDoc("legacy2", undefined, t, t, "ended"),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].reconnectCount, 0);
});

test("groupAdminSessions never exposes the full pairingDocKey", () => {
  const t = new Date("2026-06-06T22:00:00Z");
  const pk = "e".repeat(64);
  const [group] = groupAdminSessions([sessionDoc("s1", pk, t, t, "ended")]);
  assert.equal(group.groupId.length, 12);
  assert.equal(Object.hasOwn(group, "pairingDocKey"), false);
});

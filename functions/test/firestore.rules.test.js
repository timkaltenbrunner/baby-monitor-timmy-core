const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  getDoc,
  setDoc,
  collection,
  deleteDoc,
  deleteField,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} = require("firebase/firestore");

const PROJECT_ID = "demo-timmy-core";
const ADMIN_UID = "DcyIopcaDjUCcHbUhx0VHYM8hZ33";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RULES_PATH = path.join(REPO_ROOT, "firestore.rules");
const FIREBASE_CONFIG_PATH = path.join(REPO_ROOT, "firebase.json");

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, "utf8"),
    },
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test.afterEach(async () => {
  await testEnv.clearFirestore();
});

test("Firebase config deploys the canonical Firestore rules file", () => {
  const firebaseConfig = JSON.parse(
    fs.readFileSync(FIREBASE_CONFIG_PATH, "utf8")
  );

  assert.equal(firebaseConfig.firestore.rules, "firestore.rules");
});

test("authenticated clients can create a valid pairing meeting point", async () => {
  const db = testEnv.authenticatedContext("user-1").firestore();

  await assertSucceeds(
    setDoc(doc(db, "pairing_codes", "meeting-1"), {
      createdAt: serverTimestamp(),
      status: "pending",
      pubkeys: { "user-1": "pubkey" },
    })
  );
});

test("malformed pairing meeting point writes are rejected", async () => {
  const db = testEnv.authenticatedContext("user-1").firestore();

  await assertFails(
    setDoc(doc(db, "pairing_codes", "meeting-1"), {
      createdAt: serverTimestamp(),
      status: "pending",
      pubkeys: { "user-1": "pubkey" },
      extra: true,
    })
  );
});

test("session documents reject unexpected fields", async () => {
  const db = testEnv.authenticatedContext("user-1", {
    clientType: "mobile",
  }).firestore();

  await assertFails(
    setDoc(doc(db, "sessions", "session-1"), {
      pairingDocKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      status: "waiting",
      createdAt: serverTimestamp(),
      unexpected: true,
    })
  );
});

test("session documents allow the documented signaling fields", async () => {
  const db = testEnv.authenticatedContext("user-1", {
    clientType: "mobile",
  }).firestore();

  await assertSucceeds(
    setDoc(doc(db, "sessions", "session-1"), {
      status: "waiting",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      pairingDocKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      version: 1,
    })
  );
});

test("signaling writes enforce the telemetry tail and ICE media ID limits", async () => {
  const db = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const session = doc(db, "sessions", "size-limits");
  await assertSucceeds(setDoc(session, {
    status: "waiting",
    createdAt: serverTimestamp(),
    pairingDocKey: "a".repeat(64),
    qualityEventsTail: Array.from({ length: 20 }, (_, index) => ({ type: "event", index })),
  }));
  await assertFails(updateDoc(session, { qualityEventsTail: Array(21).fill("event") }));
  await assertFails(updateDoc(session, { qualityEventsTail: {} }));
  await assertSucceeds(updateDoc(session, { qualityEventsTail: [] }));

  for (const side of ["candidates_baby", "candidates_parent"]) {
    const candidate = doc(db, "sessions", "size-limits", side, "one");
    await assertFails(setDoc(candidate, {
      candidate: "encrypted-candidate",
      sdpMid: "a".repeat(1025),
      ts: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(candidate, {
      candidate: "encrypted-candidate",
      sdpMid: "a".repeat(1024),
      ts: serverTimestamp(),
    }));
  }
});

test("admin dashboard cannot read raw session documents directly", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "sessions", "session-1"), {
      status: "connected",
      createdAt: "now",
      pairingDocKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      offerSdp: "encrypted-offer",
    });
  });

  const adminDb = testEnv.authenticatedContext(ADMIN_UID).firestore();
  await assertFails(getDoc(doc(adminDb, "sessions", "session-1")));
});

test("unauthenticated users cannot read protected collections", async () => {
  const db = testEnv.unauthenticatedContext().firestore();

  await assertFails(getDoc(doc(db, "pairing_codes", "meeting-1")));
});

test("campaign configuration writes stay admin-only", async () => {
  const userDb = testEnv.authenticatedContext("user-1").firestore();
  const adminDb = testEnv.authenticatedContext(ADMIN_UID).firestore();

  await assertFails(
    setDoc(doc(userDb, "campaign_codes", "welcome"), {
      months: 3,
      status: "active",
    })
  );

  await assertSucceeds(
    setDoc(doc(adminDb, "campaign_codes", "welcome"), {
      months: 3,
      status: "active",
    })
  );
});

test("problem reports: clients cannot write directly", async () => {
  const db = testEnv.authenticatedContext("user-1").firestore();

  await assertFails(
    setDoc(doc(db, "problem_reports", "report-1"), {
      uid: "user-1",
      message: "audio drops",
      category: "audio",
      status: "new",
    })
  );
});

test("problem reports: only admin can read", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "problem_reports", "report-1"), {
      uid: "user-1",
      message: "audio drops",
      category: "audio",
      status: "new",
    });
  });

  const userDb = testEnv.authenticatedContext("user-1").firestore();
  await assertFails(getDoc(doc(userDb, "problem_reports", "report-1")));

  const adminDb = testEnv.authenticatedContext(ADMIN_UID).firestore();
  await assertSucceeds(getDoc(doc(adminDb, "problem_reports", "report-1")));
});

test("premium grant collections are fully server-only (even for admin)", async () => {
  const userDb = testEnv.authenticatedContext("user-1").firestore();
  const adminDb = testEnv.authenticatedContext(ADMIN_UID).firestore();

  // Seed docs bypassing rules so read attempts have something to fetch.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "grant_tokens", "HC7Y86PTQHCLAC"), { active: true });
    await setDoc(doc(db, "grant_redemptions", "HC7Y86PTQHCLAC_user-1"), {
      uid: "user-1",
    });
    await setDoc(doc(db, "premium_grants", "user-1"), { source: "grant" });
  });

  for (const db of [userDb, adminDb]) {
    await assertFails(getDoc(doc(db, "grant_tokens", "HC7Y86PTQHCLAC")));
    await assertFails(
      setDoc(doc(db, "grant_tokens", "HC7Y86PTQHCLAC"), { active: false })
    );
    await assertFails(
      getDoc(doc(db, "grant_redemptions", "HC7Y86PTQHCLAC_user-1"))
    );
    await assertFails(getDoc(doc(db, "premium_grants", "user-1")));
    await assertFails(
      setDoc(doc(db, "premium_grants", "user-1"), { source: "hack" })
    );
  }
});

test("all session analytics collections are fully server-only even for admin", async () => {
  const collectionNames = [
    "session_analytics_segments",
    "session_analytics_pairing_days",
    "session_analytics_daily",
    "session_analytics_overrides",
    "session_analytics_override_audit",
    "session_analytics_rebuild_jobs",
    "session_analytics_dirty_days",
    "session_analytics_day_leases",
  ];
  await testEnv.withSecurityRulesDisabled(async (context) => {
    for (const collectionName of collectionNames) {
      await setDoc(doc(context.firestore(), collectionName, "private"), {
        value: "private",
      });
    }
  });

  const userDb = testEnv.authenticatedContext("user-1").firestore();
  const adminDb = testEnv.authenticatedContext(ADMIN_UID).firestore();
  for (const collectionName of collectionNames) {
    for (const db of [userDb, adminDb]) {
      await assertFails(getDoc(doc(db, collectionName, "private")));
      await assertFails(setDoc(doc(db, collectionName, "private"), { hacked: true }));
    }
  }
});


test("gift data is server-only and nested admin data is admin-only", async () => {
  const user = testEnv.authenticatedContext("ordinary-user").firestore();
  const admin = testEnv.authenticatedContext(ADMIN_UID).firestore();
  const adminPaths = [
    ["admin", "turn_config"],
    ["admin", "turn_usage", "daily", "sample"],
  ];
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "gift_codes", "synthetic"), { status: "active" });
    for (const path of adminPaths) {
      await setDoc(doc(db, ...path), { sample: true });
    }
  });

  for (const db of [user, admin]) {
    await assertFails(getDoc(doc(db, "gift_codes", "synthetic")));
    await assertFails(getDocs(collection(db, "gift_codes")));
  }
  for (const path of adminPaths) {
    await assertFails(getDoc(doc(user, ...path)));
    await assertSucceeds(getDoc(doc(admin, ...path)));
  }
  await assertFails(getDocs(collection(user, "admin")));
  await assertSucceeds(getDocs(collection(admin, "admin")));
});

for (const creatorType of ["mobile", "browser"]) {
  test(`pairing remains usable for a ${creatorType} creator`, async () => {
    const creator = testEnv.authenticatedContext("creator").firestore();
    const joiner = testEnv.authenticatedContext("joiner").firestore();
    const other = testEnv.authenticatedContext("other").firestore();
    const meeting = (db) => doc(db, "pairing_codes", "sample-meeting");
    const metadata = creatorType === "browser"
      ? { peerType: "web_companion", webUid: "creator", webSessionId: "sample-session" }
      : {};
    const initial = () => ({
      createdAt: serverTimestamp(),
      pubkeys: { creator: "creator-key" },
      ...metadata,
    });
    const join = () => setDoc(meeting(joiner), { pubkeys: { joiner: "joiner-key" } }, { merge: true });

    await assertSucceeds(setDoc(meeting(creator), initial()));
    await assertSucceeds(updateDoc(meeting(creator), { createdAt: serverTimestamp() }));
    await assertFails(getDocs(collection(other, "pairing_codes")));
    await assertFails(deleteDoc(meeting(other)));
    await assertFails(updateDoc(meeting(other), { status: "cancelled" }));
    await assertSucceeds(getDoc(meeting(joiner)));
    await assertSucceeds(new Promise((resolve, reject) => {
      const unsubscribe = onSnapshot(meeting(creator), (snap) => {
        unsubscribe();
        resolve(snap);
      }, reject);
    }));
    await assertFails(setDoc(meeting(creator), { ...initial(), pubkeys: { creator: "replacement-key" } }));
    await assertSucceeds(join());
    await assertSucceeds(join());
    await assertFails(setDoc(meeting(other), { pubkeys: { other: "other-key" } }, { merge: true }));
    await assertFails(updateDoc(meeting(joiner), { pubkeys: { joiner: "joiner-key" } }));
    await assertFails(updateDoc(meeting(creator), { createdAt: serverTimestamp() }));
    await assertFails(updateDoc(meeting(joiner), { webUid: "joiner" }));
    await assertSucceeds(updateDoc(meeting(joiner), { status: "cancelled" }));
    await assertSucceeds(deleteDoc(meeting(creator)));
  });
}

test("cancelled meetings reject a new participant", async () => {
  const creator = testEnv.authenticatedContext("creator").firestore();
  const joiner = testEnv.authenticatedContext("joiner").firestore();
  const meeting = (db) => doc(db, "pairing_codes", "cancelled-meeting");

  await assertSucceeds(setDoc(meeting(creator), {
    createdAt: serverTimestamp(),
    pubkeys: { creator: "creator-key" },
  }));
  await assertSucceeds(updateDoc(meeting(creator), { status: "cancelled" }));
  await assertFails(setDoc(meeting(joiner), { pubkeys: { joiner: "joiner-key" } }, { merge: true }));
});

test("web-client status and pairings allow document access without queries", async () => {
  const mobile = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const web = testEnv.authenticatedContext("web").firestore();
  const key = "a".repeat(64);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "web_client_sessions", "web"), { status: "active" });
    await setDoc(doc(db, "pairings", key), { status: "active" });
  });

  await assertSucceeds(getDoc(doc(web, "web_client_sessions", "web")));
  await assertFails(getDoc(doc(mobile, "web_client_sessions", "web")));
  await assertFails(getDocs(collection(web, "web_client_sessions")));
  await assertSucceeds(getDoc(doc(mobile, "pairings", key)));
  await assertFails(getDocs(collection(mobile, "pairings")));
});

test("campaigns are admin-only and report listings use the callable", async () => {
  const user = testEnv.authenticatedContext("ordinary-user").firestore();
  const admin = testEnv.authenticatedContext(ADMIN_UID).firestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "campaign_codes", "sample"), { enabled: true });
    await setDoc(doc(db, "problem_reports", "sample"), { message: "sample" });
  });

  await assertFails(getDoc(doc(user, "campaign_codes", "sample")));
  await assertFails(getDocs(collection(user, "campaign_codes")));
  await assertSucceeds(getDocs(collection(admin, "campaign_codes")));
  await assertSucceeds(getDoc(doc(admin, "problem_reports", "sample")));
  await assertFails(getDocs(collection(admin, "problem_reports")));
});

test("only the authorized browser can query its own sessions", async () => {
  const key = "a".repeat(64);
  const otherKey = "b".repeat(64);
  const claims = { clientType: "web", webSessionId: "browser-lease" };
  const web = testEnv.authenticatedContext("web", claims).firestore();
  const mobile = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const invalidLeases = {
    expired: { leaseExpiresAt: Timestamp.fromMillis(0) },
    "past-maximum": { maxExpiresAt: Timestamp.fromMillis(0) },
    revoked: { status: "revoked" },
    replaced: { webSessionId: "replacement-lease" },
  };
  const invalidBrowsers = Object.keys(invalidLeases).map((uid) =>
    testEnv.authenticatedContext(uid, claims).firestore()
  );
  const sessionQuery = (db, pairingDocKey) =>
    query(collection(db, "sessions"), where("pairingDocKey", "==", pairingDocKey));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const future = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
    const lease = (uid) => ({
      status: "active",
      webUid: uid,
      webSessionId: "browser-lease",
      pairingDocKey: key,
      leaseExpiresAt: future,
      maxExpiresAt: future,
    });
    await setDoc(doc(db, "web_client_sessions", "web"), lease("web"));
    for (const [uid, fields] of Object.entries(invalidLeases)) {
      await setDoc(doc(db, "web_client_sessions", uid), { ...lease(uid), ...fields });
    }
    await setDoc(doc(db, "sessions", "sample"), { pairingDocKey: key, status: "active" });
    await setDoc(doc(db, "sessions", "other"), { pairingDocKey: otherKey, status: "active" });
    for (const side of ["candidates_baby", "candidates_parent"]) {
      await setDoc(doc(db, "sessions", "sample", side, "one"), { candidate: "synthetic", ts: Timestamp.now() });
      await setDoc(doc(db, "sessions", "other", side, "one"), { candidate: "synthetic", ts: Timestamp.now() });
    }
  });

  const snapshot = await assertSucceeds(new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(sessionQuery(web, key), (value) => {
      unsubscribe();
      resolve(value);
    }, reject);
  }));
  assert.deepEqual(snapshot.docs.map((entry) => entry.id), ["sample"]);
  await assertFails(getDocs(collection(web, "sessions")));
  await assertFails(getDocs(sessionQuery(web, otherKey)));
  for (const browser of invalidBrowsers) {
    await assertFails(getDocs(sessionQuery(browser, key)));
    await assertFails(getDoc(doc(browser, "sessions", "sample")));
  }
  await assertFails(getDocs(collection(mobile, "sessions")));
  await assertFails(getDocs(sessionQuery(mobile, key)));
  await assertSucceeds(getDoc(doc(mobile, "sessions", "sample")));
  const browserSession = doc(web, "sessions", "browser-as-baby");
  await assertSucceeds(setDoc(browserSession, {
    pairingDocKey: key,
    status: "waiting",
    offerSdp: null,
    answerSdp: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(browserSession, {
    offerSdp: "synthetic-offer",
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(browserSession));
  for (const side of ["candidates_baby", "candidates_parent"]) {
    const candidates = (db, session) => collection(db, "sessions", session, side);
    await assertSucceeds(getDocs(query(candidates(web, "sample"), orderBy("ts"))));
    await assertSucceeds(getDocs(candidates(mobile, "sample")));
    await assertFails(getDocs(candidates(web, "other")));
    for (const browser of invalidBrowsers) {
      await assertFails(getDocs(query(candidates(browser, "sample"), orderBy("ts"))));
    }
  }
});

test("sessions preserve creation time and prevent client parent deletion", async () => {
  const db = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const session = doc(db, "sessions", "sample");
  const fields = { pairingDocKey: "a".repeat(64), status: "waiting" };

  await assertFails(setDoc(session, fields));
  await assertFails(setDoc(session, {
    ...fields,
    createdAt: Timestamp.fromMillis(0),
  }));
  await assertSucceeds(setDoc(session, {
    ...fields,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    offerSdp: null,
    answerSdp: null,
  }));
  await assertFails(updateDoc(session, { createdAt: deleteField() }));
  await assertFails(updateDoc(session, { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(session, { updatedAt: deleteField() }));
  await assertFails(updateDoc(session, { offerSdp: {} }));
  await assertFails(updateDoc(session, { answerSdp: 123 }));
  for (const field of ["iceRestartSeq", "iceRestartRequestSeq", "recreateRequestSeq"]) {
    await assertFails(updateDoc(session, { [field]: "1" }));
    await assertSucceeds(updateDoc(session, { [field]: 1 }));
  }
  await assertSucceeds(updateDoc(session, {
    offerSdp: "synthetic-offer",
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(session, {
    offerSdp: null,
    answerSdp: null,
    signalingClearedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(session));
});

test("candidate timestamps and optional payload fields match the client contract", async () => {
  const db = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const session = doc(db, "sessions", "sample");

  await assertSucceeds(setDoc(session, {
    pairingDocKey: "a".repeat(64),
    status: "waiting",
    createdAt: serverTimestamp(),
  }));
  for (const side of ["candidates_baby", "candidates_parent"]) {
    const candidate = doc(db, "sessions", "sample", side, "one");
    const fields = { candidate: "synthetic", sdpMid: null, sdpMLineIndex: null };

    await assertFails(setDoc(candidate, { ...fields, ts: Timestamp.fromMillis(0) }));
    await assertFails(setDoc(candidate, { ...fields, sdpMid: [], ts: serverTimestamp() }));
    await assertFails(setDoc(candidate, { ...fields, sdpMLineIndex: "0", ts: serverTimestamp() }));
    await assertSucceeds(setDoc(candidate, { ...fields, ts: serverTimestamp() }));
    await assertSucceeds(deleteDoc(candidate));
  }
});

test("pairing updates support mode selection and enforce types and activity time", async () => {
  const db = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();
  const pairing = doc(db, "pairings", "a".repeat(64));

  await assertFails(setDoc(pairing, { status: "selecting", createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(pairing, {
    status: "selecting",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(pairing, { createdAt: deleteField() }));
  await assertFails(updateDoc(pairing, { updatedAt: deleteField() }));
  await assertFails(updateDoc(pairing, {
    updatedAt: Timestamp.fromMillis(Date.now() + 60_000),
  }));
  await assertFails(updateDoc(pairing, { status: [] }));
  await assertFails(updateDoc(pairing, { activeSessionId: {} }));
  await assertFails(updateDoc(pairing, { selectedBy: false }));
  await assertFails(updateDoc(pairing, { selectedMode: 1 }));
  await assertFails(updateDoc(pairing, { subscriptionMembers: [] }));
  await assertSucceeds(updateDoc(pairing, {
    status: deleteField(),
    selectedMode: "parent",
    selectedBy: "mobile",
    subscriptionMembers: { mobile: { selectionUpdatedAt: serverTimestamp() } },
    updatedAt: serverTimestamp(),
  }));
});

test("unrelated updates preserve documents with legacy field values", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "sessions", "legacy"), {
      pairingDocKey: "a".repeat(64),
      status: "waiting",
      createdAt: "legacy",
      offerSdp: 42,
    });
    await setDoc(doc(db, "pairings", "a".repeat(64)), {
      createdAt: "legacy",
      activeSessionId: 42,
    });
  });
  const db = testEnv.authenticatedContext("mobile", { clientType: "mobile" }).firestore();

  await assertSucceeds(updateDoc(doc(db, "sessions", "legacy"), {
    status: "ended",
    updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(doc(db, "pairings", "a".repeat(64)), {
    status: "ended",
    updatedAt: serverTimestamp(),
  }));
});

test("bounded backend cleanup resumes oversized sessions and preserves refreshed meetings", async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore, Timestamp: AdminTimestamp } = require("firebase-admin/firestore");
  const { cleanSession, runStaleCleanup } = require("../lib/cleanup_service");
  const app = initializeApp({ projectId: PROJECT_ID }, "cleanup-test");
  try {
    const db = getFirestore(app);
    const now = new Date();
    const old = AdminTimestamp.fromMillis(now.getTime() - 48 * 60 * 60 * 1000);
    const session = db.doc("sessions/old");
    const baby = session.collection("candidates_baby");
    const parent = session.collection("candidates_parent");
    await session.set({ createdAt: old });
    await baby.doc("a").set({ ts: old });
    await baby.doc("b").set({ ts: old });
    await parent.doc("c").set({ ts: old });

    assert.deepEqual(await cleanSession(db, session, now, 2), {
      candidates: 2, deleted: false, deferred: true,
    });
    assert.equal((await session.get()).exists, true);
    assert.equal((await parent.get()).size, 1);
    assert.deepEqual(await cleanSession(db, session, now, 2), {
      candidates: 1, deleted: true, deferred: false,
    });
    assert.equal((await session.get()).exists, false);
    assert.equal((await parent.get()).empty, true);

    const batch = db.batch();
    for (let index = 0; index < 51; index++) {
      batch.set(db.doc(`pairing_codes/old-${index}`), { createdAt: old });
    }
    batch.set(db.doc("pairing_codes/fresh"), { createdAt: AdminTimestamp.fromDate(now) });
    await batch.commit();
    const first = await runStaleCleanup(db, now);
    assert.equal(first.deleted.pairing_codes, 50);
    assert.equal(first.more.pairing_codes, true);
    const second = await runStaleCleanup(db, now);
    assert.equal(second.deleted.pairing_codes, 1);
    assert.equal(second.more.pairing_codes, false);
    assert.equal((await db.doc("pairing_codes/fresh").get()).exists, true);
  } finally {
    await deleteApp(app);
  }
});

test("historical cleanup skips changed documents and ICE with a session parent", async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { applyOperation } = require("../scripts/firestore_cleanup_inventory");
  const app = initializeApp({ projectId: PROJECT_ID }, "inventory-test");
  try {
    const db = getFirestore(app);
    const now = new Date(Date.now() + 48 * 60 * 60 * 1000);
    async function entry(ref, kind) {
      const time = (await ref.get()).updateTime;
      const seconds = new Date(time.seconds * 1000).toISOString().slice(0, 19);
      return { kind, path: ref.path, updateTime: `${seconds}.${String(time.nanoseconds).padStart(9, "0")}Z` };
    }

    const legacy = db.doc("pairing_codes/legacy");
    await legacy.set({ marker: 1 });
    const oldVersion = await entry(legacy, "legacy");
    await legacy.update({ marker: 2 });
    assert.equal(await applyOperation(db, oldVersion, now), null);
    assert.equal((await legacy.get()).exists, true);
    assert.deepEqual(await applyOperation(db, await entry(legacy, "legacy"), now), { childCount: 0 });
    assert.equal((await legacy.get()).exists, false);

    const session = db.doc("sessions/restored");
    const candidate = session.collection("candidates_baby").doc("one");
    await candidate.set({ candidate: "synthetic" });
    const orphan = await entry(candidate, "orphan");
    await session.set({ status: "waiting" });
    assert.equal(await applyOperation(db, orphan, now), null);
    assert.equal((await candidate.get()).exists, true);
    await session.delete();
    assert.deepEqual(await applyOperation(db, orphan, now), { childCount: 0 });
    assert.equal((await candidate.get()).exists, false);
  } finally {
    await deleteApp(app);
  }
});

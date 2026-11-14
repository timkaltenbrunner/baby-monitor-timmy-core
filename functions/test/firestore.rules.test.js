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
      createdAt: "now",
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
      createdAt: "now",
      updatedAt: "later",
      pairingDocKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      version: 1,
    })
  );
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
  const expired = testEnv.authenticatedContext("expired", claims).firestore();
  const sessionQuery = (db, pairingDocKey) =>
    query(collection(db, "sessions"), where("pairingDocKey", "==", pairingDocKey));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const future = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
    const lease = (uid, expiry) => ({
      status: "active",
      webUid: uid,
      webSessionId: "browser-lease",
      pairingDocKey: key,
      leaseExpiresAt: expiry,
      maxExpiresAt: future,
    });
    await setDoc(doc(db, "web_client_sessions", "web"), lease("web", future));
    await setDoc(doc(db, "web_client_sessions", "expired"), lease("expired", Timestamp.fromMillis(0)));
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
  await assertFails(getDocs(sessionQuery(expired, key)));
  await assertFails(getDocs(collection(mobile, "sessions")));
  await assertFails(getDocs(sessionQuery(mobile, key)));
  await assertSucceeds(getDoc(doc(mobile, "sessions", "sample")));
  for (const side of ["candidates_baby", "candidates_parent"]) {
    const candidates = (db, session) => collection(db, "sessions", session, side);
    await assertSucceeds(getDocs(query(candidates(web, "sample"), orderBy("ts"))));
    await assertSucceeds(getDocs(candidates(mobile, "sample")));
    await assertFails(getDocs(candidates(web, "other")));
  }
});

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
} = require("firebase/firestore");

const PROJECT_ID = "demo-timmy-core";
const ADMIN_UID = "DcyIopcaDjUCcHbUhx0VHYM8hZ33";

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(
        path.resolve(__dirname, "..", "..", "firestore.rules"),
        "utf8"
      ),
    },
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test.afterEach(async () => {
  await testEnv.clearFirestore();
});

test("authenticated clients can create a valid pairing meeting point", async () => {
  const db = testEnv.authenticatedContext("user-1").firestore();

  await assertSucceeds(
    setDoc(doc(db, "pairing_codes", "meeting-1"), {
      createdAt: "now",
      status: "pending",
      pubkeys: { "user-1": "pubkey" },
    })
  );
});

test("malformed pairing meeting point writes are rejected", async () => {
  const db = testEnv.authenticatedContext("user-1").firestore();

  await assertFails(
    setDoc(doc(db, "pairing_codes", "meeting-1"), {
      createdAt: "now",
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

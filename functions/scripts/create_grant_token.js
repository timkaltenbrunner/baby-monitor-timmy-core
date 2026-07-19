#!/usr/bin/env node
// Creates/updates a premium-grant token for the shared premium link
// (https://babyphone-timmy.ch/premium?g=<CODE>). The token is validated +
// redeemed server-side in verifySubscriptionEntitlement (see verifyPremiumGrant
// in functions/index.js). Grant docs are server-only (Firestore rules).
//
// Run from the functions/ dir so `firebase-admin` resolves:
//   node scripts/create_grant_token.js <CODE> [--max N] [--expires YYYY-MM-DD] [--inactive]
//
// Examples:
//   node scripts/create_grant_token.js HC7Y86PTQHCLAC              # unlimited, forever, active
//   node scripts/create_grant_token.js HC7Y86PTQHCLAC --inactive   # kill-switch (stops NEW grants)
//
// Auth: GOOGLE_APPLICATION_CREDENTIALS, else the admin SA below.
const admin = require("firebase-admin");

const SA_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/Users/timkaltenbrunner/workarea/git/baby-monitor-timmy-firebase-adminsdk-fbsvc-2505ab67cc.json";

function parseArgs(argv) {
  const args = { code: null, max: null, expires: null, active: true };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--max") args.max = parseInt(rest[++i], 10);
    else if (a === "--expires") args.expires = rest[++i];
    else if (a === "--inactive") args.active = false;
    else if (!a.startsWith("--")) args.code = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const code = (args.code || "").toUpperCase();
  if (!/^[A-Z0-9]{6,64}$/.test(code)) {
    console.error(
      "Usage: node scripts/create_grant_token.js <CODE> [--max N] [--expires YYYY-MM-DD] [--inactive]"
    );
    console.error("CODE must be 6-64 chars of A-Z0-9.");
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(require(SA_PATH)) });
  const db = admin.firestore();
  const ref = db.collection("grant_tokens").doc(code);
  const existing = await ref.get();

  const doc = {
    active: args.active,
    maxRedemptions: Number.isFinite(args.max) ? args.max : null,
    expiresAt: args.expires
      ? admin.firestore.Timestamp.fromDate(new Date(`${args.expires}T23:59:59Z`))
      : null,
    source: "gift",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existing.exists) {
    doc.createdAt = admin.firestore.FieldValue.serverTimestamp();
    doc.redemptionCount = 0;
  }
  await ref.set(doc, { merge: true });

  const after = (await ref.get()).data();
  console.log(
    `grant_tokens/${code} ${existing.exists ? "updated" : "created"}:`,
    JSON.stringify(
      {
        active: after.active,
        maxRedemptions: after.maxRedemptions,
        expiresAt: after.expiresAt ? after.expiresAt.toDate().toISOString() : null,
        redemptionCount: after.redemptionCount,
      },
      null,
      2
    )
  );
  console.log(`Share link: https://babyphone-timmy.ch/premium?g=${code}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

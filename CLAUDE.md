# baby-monitor-timmy-core

Single source of truth for the **Baby Monitor Timmy backend & shared primitives**:

- **Cloud Functions** — `functions/` (Node, Firebase Functions v2). **This is the
  ONLY place Cloud Functions live and deploy from.** The mobile app repo
  (`BabyMonitorTimmy`) must NOT contain a `functions/` directory.
- **Firestore rules** — `firestore.rules` (deployed from here, not the app repo).
- **Shared Dart package** — `packages/baby_monitor_timmy_core/` (pairing/crypto/
  signaling primitives; consumed by the app via a path dependency).

The mobile app (UI, navigation, release tooling, homepage/admin hosting) lives in
the separate `BabyMonitorTimmy` repo.

## Hard rule: never duplicate Cloud Functions
Cloud Functions had once been copied into both repos and **diverged in both
directions**, silently overwriting each other on deploy (e.g. iOS IAP verification
vs. promo upgrades). Do NOT re-introduce a `functions/` copy in the app repo, and
do NOT fork backend logic. All Cloud Functions changes happen **here**.

## Cloud Functions

### Layout
- `functions/index.js` — function exports (`exports.<name> = onCall/onSchedule(...)`).
- `functions/lib/*.js` — extracted, unit-tested helpers (`admin_sessions_helpers`,
  `cleanup_helpers`, `referral_helpers`, `public_helpers`). Prefer adding logic as
  testable `lib/` modules.
- `functions/test/*.test.js` — `node --test` unit tests (no emulator). Run with
  `cd functions && npm test`.

### Runtime config / secrets
- Non-secret params (`defineString`) come from `functions/.env` (gitignored, NOT
  committed). Required keys: `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_UID`,
  `LOCAL_TURN_API_BASE_URL`, `LOCAL_TURN_PUBLIC_URLS`, `WEB_COMPANION_APP_IDS`,
  `IOS_MOBILE_APP_IDS`, `APP_STORE_BUNDLE_ID`, `APP_STORE_SHARED_SECRET`,
  `IOS_TEST_HARNESS_RECORDING_ALLOWED` (MUST be `false` in prod;
  `IOS_TEMPORARY_PREMIUM_BYPASS` is dead/unreferenced — omit; `GIFT_DEBUG_TOKENS_ALLOWED`
  MUST be unset in prod).
- Hard secrets (`defineSecret`) live in Google Secret Manager:
  `CLOUDFLARE_TURN_TOKEN`, `LOCAL_TURN_API_KEY`, `LOCAL_TURN_HMAC_SECRET`,
  `APP_STORE_SERVER_KEY_ID`, `APP_STORE_SERVER_ISSUER_ID`, `APP_STORE_SERVER_PRIVATE_KEY`,
  `PLAY_SERVICE_ACCOUNT_JSON`, `SESSION_ANALYTICS_HMAC_KEY`.

Daily session analytics is documented in `docs/session_analytics.md`. Its
top-level collections are server-only, and its trigger must never write to
`/sessions` or perform scheduled full scans of that collection.

### Deploy (auth: `~/workarea/git/firebase-credentials.json` refresh token)
```bash
cd functions && npm test                 # unit tests
node -e "require('./index.js')"          # smoke-load (deps installed)
export FIREBASE_TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/workarea/git/firebase-credentials.json','utf8')).refresh_token)")
firebase deploy --only functions --project baby-monitor-timmy
```
- **Billing-critical functions** (`verifySubscriptionEntitlement`,
  `authorizeWebClient`, anything via `verifyPremiumProof`): prefer **staged,
  per-function** deploys (`--only functions:<name>,functions:<name>`) and deploy
  these LAST after verifying the rest. A full `--only functions` deploy PRUNES any
  function missing from source — only run it when `index.js` is a verified superset
  of `firebase functions:list`.
- Verify after deploy: `firebase functions:list` (expect the full set, incl. the
  iOS billing functions).

## Deploy Firestore rules
```bash
firebase deploy --only firestore:rules --project baby-monitor-timmy
```

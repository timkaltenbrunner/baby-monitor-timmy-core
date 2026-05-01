# Referral & Trial Extension System

> Status: design locked 2026-04-22. Implementation in progress.
> Supersedes the first draft in commit `b76d7c4`.

## 1. Goals

The system has to satisfy four independent constraints that the v1 draft
only partially met:

1. **Viral growth via user-to-user gifting** — a subscribed user can send a
   friend a code that gives both of them an extra free month.
2. **Paid-ad attribution & higher conversion** — every paid-ad campaign has
   its own auto-redeemed deep link, so ad-driven installs start with 60 days
   free instead of 30. We can measure conversions per campaign without any
   third-party tracker.
3. **Zero persistent per-device server records** — Play Store is the system
   of record for entitlement. No `installId`, no persistent `entitlements`
   doc, no account-hash table.
4. **No Android Auto Backup** — `android:allowBackup="false"`. The app
   keeps no state that needs to survive reinstall, because Play already
   remembers the user's subscription.

## 2. Core design decisions & reasoning

### 2.1 Play Store owns the trial

The 30-day free trial is configured on the Play Console subscription
product. Users go through the Play subscribe sheet on day 1 to get free
access. Play enforces "one trial per Google account, forever" for free.

### 2.2 Gift codes defer billing, not "extend trial"

A redeemed gift or campaign code calls the Play Developer API
`purchases.subscriptions.defer` endpoint, which moves the subscription's
next-billing timestamp forward by 30 days.

Idempotency: `defer` takes an absolute `desiredExpiryTimeMillis`, computed
deterministically from the current expiry read immediately before the call.
Replays are no-ops.

### 2.3 Two code types, two collections

- `gift_codes/{nonce}` — single-use, minted by a subscribed user for a
  friend. Dual-credit: both sharer and recipient get +30 days.
- `campaign_codes/{slug}` — multi-use, admin-created, distributed via paid
  ads. Single-credit: only the recipient gets +30 days.

### 2.4 Campaign codes via Play Install Referrer

Ad deep links:
`https://play.google.com/store/apps/details?id=com.babymonitortimmy.app&referrer=camp_<slug>`.
On first launch the app reads the referrer once via the official
`com.android.installreferrer` API, extracts the slug, and stashes it for
auto-redemption when the user subscribes.

### 2.5 HMAC-signed gift codes

Visible form `TIMMY-AB12CD-EF34`:
- `TIMMY-` — prefix.
- `AB12CD` — 8-char nonce (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`).
- `EF34` — 4-char Base32 of HMAC-SHA256(nonce, server secret).

HMAC is a cheap client-side sanity check; security comes from server-side
nonce lookup.

Campaign codes use plain slugs — they're published in ads. Abuse bounded by
`maxRedemptions` and one-redemption-per-purchase-token.

### 2.6 Duplicate-defer prevention

Every `gift_codes/{nonce}` and `campaign_redemptions/{id}` write flips a
`deferApplied` flag inside a Firestore transaction before calling Play. On
Play failure the flag is rolled back. Combined with Play's idempotent
absolute-expiry semantics, this gives two independent layers of safety.

### 2.7 Pricing: €1 / CHF 1

Strategically low so the subscription is effectively a tip. Gift loop is
goodwill. Campaign 60-day path costs ~€0.85/conversion.

## 3. Architecture

```
Sharer (subscribed) ──mintGiftCode──▶ Cloud Function ──▶ gift_codes/{nonce}
                                                          ◀── { code }
   │ shares via SMS / Messenger / paper / …
   ▼
Recipient (subscribed) ──redeemGiftCode──▶ Cloud Function ──defer──▶ Play Dev API
                                                              flip recipientDeferApplied
                                                              then defer on sharer too

ad viewer ──click──▶ Play Store (?referrer=camp_X) ──install──▶
first open ──redeemCampaignCode──▶ Cloud Function ──defer──▶ Play Dev API
```

## 4. Firestore collections

### 4.1 `gift_codes/{nonce}`

```ts
{
  mintedAt: Timestamp,
  expiresAt: Timestamp,                 // = mintedAt + 30 days
  status: "active" | "redeemed",

  sharerPackageName: string,
  sharerSubscriptionId: string,
  sharerPurchaseToken: string,
  sharerDeferApplied: boolean,

  recipientPackageName: string | null,
  recipientSubscriptionId: string | null,
  recipientPurchaseToken: string | null,
  recipientDeferApplied: boolean,
  redeemedAt: Timestamp | null,
}
```

### 4.2 `campaign_codes/{slug}`

```ts
{
  createdAt: Timestamp,
  expiresAt: Timestamp | null,
  maxRedemptions: number | null,
  redemptionCount: number,
  deferDays: number,
  active: boolean,
  label: string,
  createdBy: string,
}
```

### 4.3 `campaign_redemptions/{slug}_{purchaseTokenSha256}`

```ts
{
  slug: string,
  purchaseTokenSha256: string,
  redeemedAt: Timestamp,
  deferApplied: boolean,
  newExpiryMillis: number | null,
}
```

### 4.4 Firestore rules

```
match /gift_codes/{nonce} {
  allow read: if request.auth != null;
  allow write: if false;     // Admin SDK only
}
match /campaign_codes/{slug} {
  allow read: if request.auth != null;
  allow write: if isAdmin();
}
match /campaign_redemptions/{id} {
  allow read: if false;
  allow write: if false;     // Admin SDK only
}
```

## 5. Cloud Functions

All `onCall` + App Check + anon auth + per-UID rate limiting.

### 5.1 Secrets

```js
const giftCodeHmacSecret = defineSecret("GIFT_CODE_HMAC_SECRET");
const playServiceAccountJson = defineSecret("PLAY_DEVELOPER_SERVICE_ACCOUNT_JSON");
```

### 5.2 Functions

- `mintGiftCode({purchaseToken, subscriptionId})` — sharer must be a valid
  Play subscriber. Returns `{code, expiresAt}`. 5/hour.
- `redeemGiftCode({code, purchaseToken, subscriptionId})` — recipient must
  be a valid Play subscriber. Returns `{ok, newExpiryMillis}`. Self-redeem
  blocked. 3/hour.
- `checkGiftCodeStatus({codes[]})` — returns subset that is now redeemed.
  60/hour.
- `redeemCampaignCode({slug, purchaseToken, subscriptionId})` — single
  redemption per purchase token. Returns `{ok, newExpiryMillis, deferDays}`.
  3/hour.

### 5.3 Cleanup

`cleanupStaleSessions` extended to delete:
- `gift_codes/{nonce}` once `expiresAt < now`.
- `campaign_redemptions/{id}` 90 days after `redeemedAt`.

`campaign_codes/{slug}` is admin-curated, never auto-deleted.

### 5.4 Removed

`registerReferralCode`, `redeemReferral`, `getEntitlement`,
`linkAccountEntitlement`, `restoreAccountEntitlement`.

## 6. Client

### 6.1 secure_storage keys

Removed: `_keyInstallId`, `keyReferralCode`, `keyReferralRedeemAttempted`,
`keyEntitlementPayload`, `keyAccountHash`.

Added:
- `keyInstallReferrerRead` — "true" once we've attempted to read it.
- `keyPendingGiftCode` — full code to redeem on next subscribe.
- `keyPendingCampaignSlug` — slug from Install Referrer.
- `keyOutstandingGiftCodes` — JSON array `[{code, mintedAt, expiresAt}, …]`.

Kept: `keyNagLastShown`.

### 6.2 Services

- `lib/core/service/install_referrer_channel.dart` — exposes
  `getReferrer()` and `parseReferrerPayload(String?) → {code?, slug?}`.
- `lib/services/gift_code_service.dart` — mintCode, redeemCode,
  pollOutstanding, applyPendingIfSubscribed.
- `lib/services/nag_screen_service.dart` — depends only on
  `SubscriptionService`. `isPro = subscription.isSubscribed`.

### 6.3 UI

- `gift_month_sheet.dart` — three states (not-subscribed / loading /
  success-with-code).
- `redeem_gift_sheet.dart` — dash-formatted code input, validates HMAC
  client-side.
- `parent_settings_sheet.dart` — "Gift a free month" + "Redeem gift code"
  tiles.

## 7. Android native

### 7.1 `AndroidManifest.xml`

```xml
<application
  android:allowBackup="false"
  ...>
  <!-- no android:dataExtractionRules / android:fullBackupContent -->
</application>
```

### 7.2 `android/app/build.gradle.kts`

```kotlin
implementation("com.android.installreferrer:installreferrer:2.2")
```

### 7.3 `MainActivity.kt`

Restored `com.babymonitortimmy.app/install_referrer` MethodChannel.

## 8. Play Console & Google Cloud setup (one-off)

1. Create service account `play-developer-api-defer` in Google Cloud.
   Download JSON key.
2. Play Console → Users → invite the service-account email; grant
   *Manage orders and subscriptions* on the app.
3. Firebase Secret Manager:
   ```powershell
   firebase functions:secrets:set PLAY_DEVELOPER_SERVICE_ACCOUNT_JSON < key.json --project baby-monitor-timmy
   firebase functions:secrets:set GIFT_CODE_HMAC_SECRET --project baby-monitor-timmy
   ```
4. Subscription product `timmy_support_monthly`: 30-day free trial,
   monthly auto-renew. Prices CH/LI: CHF 1.00, DE/AT: EUR 1.00.
   Google Play Family Library does not support in-app subscriptions, so
   each family member needs their own subscription.

## 9. Out of scope (Phase 2)

- Admin UI for `campaign_codes/{slug}` (edit Firestore directly for v1).
- Play Integrity attestation on mint + redeem (TODO in code).
- iOS port.
- Sharer-defer reconciliation job.


## 10. Known behaviour: cancel, reinstall, family

### 10.1 Cancel / unsubscribe
Play enforces "one trial per Google account, forever". A user who
cancels and re-subscribes goes directly to paid billing — we never
offer the free trial twice. A user who redeems a gift code while
unsubscribed gets `RedeemSavedForLater` and the code is auto-applied
on their next subscribe.

### 10.2 Uninstall / reinstall
`android:allowBackup="false"` wipes `FlutterSecureStorage` on
reinstall — so `keyPendingGiftCode`, `keyPendingCampaignSlug`,
`keyOutstandingGiftCodes`, `keyInstallReferrerRead`, `_keyPairData`,
and `_keyOnboarding` are lost. Play-side entitlement persists, and
`restorePurchases()` on `SubscriptionService.init()` rehydrates
`activePurchase`, so the subscribe gate auto-dismisses. Pairing must be
redone. `redeemCampaignCode` is idempotent per
`{slug}_{purchaseTokenSha256}` — re-triggered referrer redemption after
a reinstall is a server-side no-op.

### 10.3 Google Play Family Library
Google Play Family Library does not share in-app subscriptions. For
`timmy_support_monthly`, each Google account must buy and own its own
subscription. Gift codes and campaign codes can still add time to that
account's active subscription, but the entitlement is not shared across
family members by Google Play.

### 10.4 No family
Standard single-account Play billing. Nothing special.

## 11. Implementation-review notes (commit `77cdc08`)

The hard-gate refactor that replaced the nag / support prompts is
functionally correct. Four non-blocking observations recorded here so
they are not lost:

1. **`scripts/test_emulators.js:589–594`** — comment claims the logo
   long-press "sets `isDemoModeProvider = true`"; in fact it sets
   `debugGateBypassProvider = true`. The two providers are
   deliberately distinct (`lib/providers/demo_provider.dart:4` vs
   `:9`): the bypass keeps the real `SessionService` / WebRTC stack
   live, so the regression test exercises the full pairing flow
   without the subscribe sheet. Rewrite the comment whenever that
   file is next touched.
2. **`lib/services/gift_code_service.dart:122–127`** — synthesises
   `newExpiryMillis = now + 30 d` if the Cloud Function response
   omits the field. The server
   (`functions/index.js:1931–1936`) already falls back to
   `desiredRecipientExpiry`, so both ends can silently agree on a
   wrong date. The automated test must assert the returned epoch is
   within ±2 days of `now + 30 d` so a regression where both fallbacks
   engage is detected.
3. **`bypassSubscribeGate` hard-codes `(540, 850)`** derived from a
   `uiautomator dump` of the Pixel_9 layout. Any change to the gate's
   logo size / padding drifts the coordinate. Future iterations
   should look up the logo centre via `uiautomator dump` at runtime.
4. **`lib/main.dart:90–112`** reads the Play install referrer once
   per install and writes `keyPendingGiftCode` / `keyPendingCampaignSlug`
   unconditionally. A subsequent pasted gift code then overwrites
   whatever the referrer deposited. Low-impact because the referrer
   read is gated by `keyInstallReferrerRead`, but worth one assertion
   in the E2E test.

## 12. Automated test coverage status

The original `test/subscription_prompt_test.dart` was removed in
`77cdc08` when the voluntary Support sheet was deleted. No replacement
exists yet. The existing `scripts/test_emulators.js` bypasses the gate
via `debugGateBypassProvider` and therefore does not cover the
subscribe, gift, or campaign paths.

Covered by `scripts/test_emulators.js` (existing):
- pairing (Nearby + manual code), WebRTC connection, camera enable,
  reconnect loops, dark mode.

Not covered today — to be added by
`scripts/test_emulators_subscription.js`
(spec in `.github/referral-plan.md`):
- `SubscribeGateScreen` appears on fresh install.
- `SubscriptionService.purchase()` / `restorePurchases()` dismisses
  the gate and flips `isSubscribedProvider`.
- `mintGiftCode` round-trip (client → Cloud Function → Firestore).
- `redeemGiftCode` round-trip including SnackBar date formatting via
  `intl` (checks the sealed `RedeemOutcome` path).
- `keyPendingGiftCode` auto-redeem after subscribe.
- Play Install Referrer parsing + `keyPendingCampaignSlug`
  auto-redeem via `redeemCampaignCode`.
- Uninstall/reinstall → cached-subscription restore dismisses the
  gate.

Explicitly **not** covered (and documented in the new test's header):
real Play purchase sheet UI, real `purchases.subscriptions.defer`
against a live sub, Family Library sharing, multi-day time
advancement (trial→paid conversion, gift expiry).

The new test relies on a **debug-only subscribe hook**
(`debugForceSubscribedProvider` on the client,
`GIFT_DEBUG_TOKENS_ALLOWED` + `debug-e2e-*` token prefix on the
server) so it can run without a Play license-tester account. The
server flag is off by default and guarded against accidental
production deploy by a check in `scripts/distribute.js`.

# Security Contract Overview

This document describes the public, security-relevant contract exposed by
**`baby-monitor-timmy-core`**.

## Firestore collections used as protocol surface

### `pairing_codes/{meetingKey}`

Short-lived ECDH meeting point. It stores public keys only and never stores the
pairing key.

Typical fields:

- `createdAt`
- `status`
- `pubkeys`
- optional Web Companion metadata: `peerType`, `webUid`, `webSessionId`

The 4-character code is a rendezvous hint, not a security secret. Public-key
replacement is detected by mandatory SAS verification.

### `web_client_sessions/{webUid}`

Server-written active Web Companion lease. A browser can use normal encrypted
signaling only while this document is active and matches its Firebase Auth custom
claim.

Typical fields:

- `status` (`active`, `revoked`, or `expired`)
- `mobileUid`
- `webUid`
- `webSessionId`
- `pairingDocKey`
- `premiumSource`
- `premiumExpiresAt`
- `authorizedAt`
- `refreshedAt`
- `leaseExpiresAt`
- `maxExpiresAt`

Only Cloud Functions write this collection. The browser UID may read its own
document.

### `web_client_mobiles/{mobileUid}`

Server-written pointer that enforces one active Web Companion per mobile UID.

Typical fields:

- `activeWebUid`
- `activeWebSessionId`
- `updatedAt`

Clients cannot read or write this collection.

### `pairings/{documentKey}`

Persistent shared pairing state between devices.

Typical fields:

- `status`
- `createdAt`
- `updatedAt`
- `activeSessionId`
- `selectedMode`
- `selectedBy`
- `subscriptionMembers`

### `sessions/{sessionId}`

Temporary signaling document for one WebRTC connection attempt.

Typical fields:

- `pairingDocKey`
- `status`
- `offerSdp`
- `answerSdp`
- `createdAt`
- `updatedAt`
- `version`
- TURN/provider metadata fields

### `sessions/{sessionId}/candidates_baby/{id}`
### `sessions/{sessionId}/candidates_parent/{id}`

Encrypted ICE candidate exchange.

Typical fields:

- `candidate`
- `sdpMid`
- `sdpMLineIndex`
- `ts`

### Additional backend collections currently used by the app

- `gift_codes/{nonce}`
- `campaign_codes/{slug}`
- `campaign_redemptions/{id}`
- `admin/referral_config`

## Callable Cloud Functions used by the app

### `registerMobileClient`

App-Check-protected callable used by Android/iOS after anonymous Firebase Auth.
It rejects configured Web Companion App Check app IDs and sets
`clientType: "mobile"` as a Firebase Auth custom claim.

### `authorizeWebClient`

Mobile-only callable. It requires the mobile custom claim, verifies the mobile
premium entitlement, revokes the previously active browser for that mobile UID,
writes `/web_client_sessions/{webUid}`, and sets `clientType: "web"` plus
`webSessionId` on the browser UID.

Android verification uses the Play Developer API. iOS verification uses the App
Store receipt endpoint when `APP_STORE_SHARED_SECRET` is configured. reCAPTCHA
App Check remains browser attestation and abuse reduction, not premium
authorization.

### `refreshWebClientAuth`

Web-only callable. It extends the active browser lease by 30 minutes, capped at a
24-hour maximum authorization window. A replaced browser cannot refresh.

### `getTurnCredentials`

Returns ordered ICE server credentials for TURN usage. Web Companion browsers
call this directly only after mobile authorization and ID-token refresh; TURN is
not the authorization boundary.

### `getAppConfig`

Returns remotely managed restriction flags and admin banners.

### Gift and campaign callables

- `mintGiftCode`
- `redeemGiftCode`
- `checkGiftCodeStatus`
- `redeemCampaignCode`

## Extracted client-side security primitives

### Pairing and crypto

- short-code generation
- meeting-key derivation
- document-key derivation
- AES-256-GCM signaling encryption
- ECDH P-256 key agreement
- SAS derivation
- persistent pairing-key derivation

### Signaling contracts

- canonical collection names for sessions and candidate subcollections
- field names for encrypted SDP, ICE candidates, and pairing routing

### Web client session contracts

- canonical collection names for active browser leases
- field names used by Firestore rules and Cloud Functions

## Firestore rule contract

- `pairing_codes`: signed-in clients may bootstrap an ECDH meeting point.
- `sessions`, candidates, and `pairings`: allowed for mobile clients with
  `clientType == "mobile"` or web clients with an active lease matching the
  requested `pairingDocKey`.
- `admin/**`: readable for signed-in clients, writable only for admins.
- `web_client_sessions`: readable only by the matching browser UID.
- `web_client_mobiles`: backend-only.

## Explicit non-goals

- The 4-character pairing code is not an authentication secret.
- Firebase Auth alone is not considered enough to distinguish browser and mobile
  clients; custom claims plus server-written leases are required.
- TURN credentials are not used as the Web Companion authorization boundary.

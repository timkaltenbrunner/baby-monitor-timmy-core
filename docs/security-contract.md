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

The 4-character code is a rendezvous hint. Signed-in clients can look up an
individual meeting. The rules preserve existing public keys and allow a second
participant to add only their own key. Users verify the intended peer by
comparing the SAS on both devices.

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

- `pairing_codes`: signed-in clients use single-document reads. Only
  participants may cancel or delete a meeting. The sole participant may refresh
  its server timestamp while waiting for a peer.
- `sessions` and `pairings`: individual access requires the mobile client
  claim or a browser lease for the requested pairing routing key. Only an
  authorized browser can query the sessions for its leased pairing. Mobile
  client classification is independent of pairing membership.
- Both ICE candidate subcollections support reads and queries under the parent
  session's access rule. Clients can delete candidate documents. Scheduled
  backend cleanup removes expired sessions and their candidates.
- New sessions and pairings use server creation timestamps. Updates preserve
  creation timestamps and use the server timestamp when changing activity time.
  Candidate creation also uses a server timestamp.
- `admin/**` and `campaign_codes`: admin-only reads and writes.
- `web_client_sessions`: the matching browser UID may get its own document.
  `web_client_mobiles` is backend-only.
- Gift codes, campaign redemptions, premium grants and their token records, and
  session analytics collections are backend-only.
- `problem_reports`: admins may get a single document. The admin console
  lists reports through a callable.

## Explicit non-goals

- The 4-character pairing code is not an authentication secret.
- Firebase Auth alone is not considered enough to distinguish browser and mobile
  clients; custom claims plus server-written leases are required.
- TURN credentials are not used as the Web Companion authorization boundary.

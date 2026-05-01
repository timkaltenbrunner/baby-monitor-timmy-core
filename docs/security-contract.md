# Security Contract Overview

This document describes the public, security-relevant contract exposed by
**`baby-monitor-timmy-core`**.

It covers the Firestore collections, callable Cloud Functions, and extracted
client-side primitives that together make up the security-critical protocol
surface of Baby Monitor Timmy.

## Firestore collections used as protocol surface

### `pairing_codes/{meetingKey}`

Purpose:

- short-lived ECDH meeting point
- stores public keys only
- never stores the pairing key itself

Typical fields:

- `createdAt`
- `status`
- `pubkeys`

### `pairings/{documentKey}`

Purpose:

- persistent shared pairing state between devices
- mode selection and shared session pointer

Typical fields:

- `status`
- `createdAt`
- `updatedAt`
- `activeSessionId`
- `selectedMode`
- `selectedBy`
- `subscriptionMembers`

### `sessions/{sessionId}`

Purpose:

- temporary signaling document for a single connection attempt

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

Purpose:

- encrypted ICE candidate exchange

Typical fields:

- `candidate`
- `sdpMid`
- `sdpMLineIndex`
- `ts`

### Additional backend collections currently used by the app

- `gift_codes/{nonce}`
- `campaign_codes/{slug}`
- `campaign_redemptions/{id}`

These collections are part of the public backend contract even though they are
not represented by a dedicated Dart API in the extracted package.

## Callable Cloud Functions used by the app

### `getTurnCredentials`

Returns ordered ICE server credentials for TURN usage.

### `getAppConfig`

Returns remotely managed restriction flags and admin banners.

### `mintGiftCode`

Creates a new gift code for an active subscriber.

### `redeemGiftCode`

Redeems a gift code for an eligible subscription purchase.

### `checkGiftCodeStatus`

Polls the backend for the redemption status of outstanding codes.

### `redeemCampaignCode`

Applies a campaign-based billing defer for an eligible purchase.

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

- Firestore collection names
- Firestore field names
- session and candidate status constants

## Repository boundary

This repository intentionally does **not** contain:

- app UI and navigation
- product orchestration outside the security-relevant flow
- store and release management tooling

See [`public-scope.md`](public-scope.md) for a more detailed boundary description.

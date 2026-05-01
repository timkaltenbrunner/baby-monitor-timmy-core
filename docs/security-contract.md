# Security Contract Overview

This document describes the security-relevant backend and protocol surface of
**`baby-monitor-timmy-core`**.

The repository is currently private. Its purpose is to keep the contract
explicit while the split from the product repository is completed.

## 1. Firestore collections used as protocol surface

### `pairing_codes/{meetingKey}`

Purpose:

- short-lived ECDH meeting point
- stores public keys only
- no pairing key is ever written to Firestore

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

- temporary signaling document for one connection attempt

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

These belong to the same overall client/server contract, but are not yet part
of the extracted Dart package surface.

## 2. Callable Cloud Functions used by the app

### `getTurnCredentials`

Returns ordered ICE server credentials for TURN usage.

### `getAppConfig`

Returns remotely managed restriction flags and admin banners.

### `mintGiftCode`

Creates a new gift code for an active subscriber.

### `redeemGiftCode`

Redeems a gift code for an active subscription purchase.

### `checkGiftCodeStatus`

Polls the backend for redemption status of outstanding codes.

### `redeemCampaignCode`

Applies a campaign-based billing defer for an eligible purchase.

## 3. Security-critical client primitives already extracted

### Pairing / crypto

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
- session/candidate status constants

## 4. Next extraction steps

1. split the full Firestore signaling adapter more cleanly from app orchestration
2. move additional protocol-facing client code into this repository
3. keep the app repo focused on UI, product flow, and non-core logic

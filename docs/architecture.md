# Architecture Overview

`baby-monitor-timmy-core` contains the pieces that define or protect the trust
boundary between two Baby Monitor Timmy devices and the Firebase backend.

## Main components

### 1. Pairing primitives

The Dart package implements:

- short-code handling
- ECDH P-256 key exchange
- pairing-key derivation
- SAS derivation for manual verification

The short code is only a rendezvous hint. The actual long-term pairing key is
derived from the ECDH shared secret and never sent to Firebase.

### 2. Firestore protocol surface

Firestore is used as a transport and coordination layer for:

- pairing meeting points
- persistent pairing state
- temporary WebRTC signaling documents
- ICE candidate exchange

Sensitive signaling payloads are encrypted on-device before they are written to
Firestore.

### 3. Backend logic

Cloud Functions handle backend-only tasks such as:

- issuing TURN credentials
- exposing remote config to clients
- gift and campaign code flows
- periodic cleanup and analytics snapshots

### 4. Firestore rules

`firestore.rules` constrains the document shapes that clients may create and
update. The rules are unusual by design: document-path secrecy is part of the
pairing model, so broad authenticated access is paired with derived,
hard-to-guess document keys and encrypted signaling payloads.

## Data flow summary

1. Devices rendezvous through `pairing_codes/{meetingKey}`.
2. Each device publishes only its ECDH public key.
3. Both devices derive the same pairing key locally.
4. The pairing key derives the persistent document key and signaling encryption key.
5. WebRTC offer/answer and ICE data are encrypted and exchanged through Firestore.
6. Media then flows end-to-end encrypted over DTLS/SRTP.

## Important boundary decisions

- The private app repo owns UI and orchestration.
- This repo owns the protocol surface and cryptographic primitives.
- Secrets are not checked into this repository.
- Deployment-specific infrastructure values are documented, not bundled.

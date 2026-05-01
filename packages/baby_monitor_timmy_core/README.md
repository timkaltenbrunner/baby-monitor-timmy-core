# baby_monitor_timmy_core

Core security, pairing, and signaling primitives for Baby Monitor Timmy.

This package now lives inside the separate repository
**`baby-monitor-timmy-core`**.

## Purpose

The goal is to separate the security-critical logic from the rest of the app so
it can later live in its own repository with clear boundaries.

Current extraction focus:

- pairing cryptography
- signaling contracts
- pair-data model
- Firestore meeting-point repository for pairing

## Repository scope

`baby-monitor-timmy-core` contains:

1. Dart packages for pairing, signaling, and shared security primitives
2. Firebase backend code (`functions/`)
3. Firestore rules
4. Security and protocol documentation
5. Client/server contract documentation

## Sync model

The target maintenance model is:

1. reusable Dart security code lives here
2. the app consumes that code as a dependency
3. backend artifacts such as `functions/`, `firestore.rules`, and selected docs
   are curated here while the remaining split is completed

This avoids long-term drift between a private product repo and a separately
reviewable security core.

## Current package boundaries

### Included here

- `src/pairing/crypto_service.dart`
- `src/pairing/ecdh_service.dart`
- `src/pairing/pairing_contract.dart`
- `src/pairing/pairing_meeting_repository.dart`
- `src/pairing/pairing_model.dart`
- `src/signaling/signaling_contract.dart`

### Still in the app repo

- UI and screen flow
- app orchestration
- full Firestore signaling adapter
- release/distribution tooling

## Why this package exists

Previously, the pairing flow mixed UI, Firestore access, and cryptographic
logic too closely. This package is part of the refactor that makes those
boundaries explicit inside the dedicated core repository.

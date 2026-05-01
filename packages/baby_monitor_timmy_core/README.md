# baby_monitor_timmy_core

Core pairing, cryptography, and signaling primitives for **Baby Monitor Timmy**.

This package is consumed via Git from the
[`baby-monitor-timmy-core`](https://github.com/timkaltenbrunner/baby-monitor-timmy-core)
repository. It is intentionally focused on logic that benefits from independent
security review.

## Included APIs

- `CryptoService`
- `EcdhService`
- `PairData`
- `PairingContract`
- `PairingMeetingRepository`
- `SignalingContract`

## What this package covers

- short-code normalization and meeting-key derivation
- pairing-key derivation from ECDH
- AES-256-GCM encryption for signaling payloads
- Firestore collection and field contracts
- pairing meeting-point storage helpers

## What stays outside this package

- app UI and flow orchestration
- the full Firestore signaling adapter
- release and store tooling
- non-security product logic

## Local verification

```bash
flutter pub get
flutter analyze
flutter test
```

For the repository-wide contract and architecture docs, see:

- `../../docs/architecture.md`
- `../../docs/security-contract.md`
- `../../docs/SECURITY.md`

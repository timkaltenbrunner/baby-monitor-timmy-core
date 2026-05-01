# baby-monitor-timmy-core

![Baby Monitor Timmy](assets/timmy-logo.png)

Separated security core for **Baby Monitor Timmy**.

This repository is the dedicated home for the security-relevant parts of the
project:

- Firebase backend logic in `functions/`
- Firestore rules in `firestore.rules`
- documented client/server and Firestore contracts
- extracted Dart pairing, crypto, and signaling primitives

The full mobile app stays in the private product repository. This repository
focuses on the parts that matter most for security review and long-term
transparency.

## Structure

| Path | Purpose |
| --- | --- |
| `functions/` | Firebase Cloud Functions used by the app |
| `firestore.rules` | Firestore access rules |
| `packages/baby_monitor_timmy_core/` | Extracted Dart security package |
| `docs/security-contract.md` | Firestore + callable API surface |
| `docs/SECURITY.md` | WebRTC and signaling security model |
| `docs/pairing.md` | Pairing and ECDH flow |
| `docs/referral-system.md` | Gift/campaign backend contract |

## Current status

This is the first real split-out of the security core. The app already consumes
the extracted Dart package shape, but some higher-level signaling and app
orchestration logic still lives in the product repository.

## Maintenance model

Reusable security code should move here permanently. Until the extraction is
finished, some backend and documentation files are still curated copies from the
product repository so the split can happen incrementally without drifting.

## Firebase

Use explicit `--project` flags when deploying from this repository. Secrets and
local `.env` files are intentionally not stored here.

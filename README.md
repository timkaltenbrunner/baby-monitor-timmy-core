# baby-monitor-timmy-core

Security-relevant backend, protocol, and pairing primitives for **Baby Monitor Timmy**.

This repository is the public home of the parts that matter most for security review:

- Firebase Cloud Functions in `functions/`
- Firestore rules in `firestore.rules`
- Dart pairing and crypto primitives in `packages/baby_monitor_timmy_core/`
- protocol and architecture documentation in `docs/`

The full mobile application is intentionally **not** part of this repository. UI,
navigation, product-specific flows, and release tooling stay in the private app
repository.

## Why this repo exists

Baby Monitor Timmy makes a narrow transparency promise: the security-critical
backend logic, Firestore contract, and client-side pairing/signaling primitives
should be inspectable without publishing the entire product codebase.

That allows external reviewers to verify:

- how pairing keys are established
- what the Firestore protocol surface looks like
- how signaling data is protected before it reaches Firestore
- how backend-issued TURN credentials and admin configuration are handled

## Repository structure

| Path | Purpose |
| --- | --- |
| `functions/` | Firebase Cloud Functions used by the app |
| `firestore.rules` | Firestore access rules and schema validation |
| `packages/baby_monitor_timmy_core/` | Extracted Dart package for crypto, pairing, and signaling contracts |
| `docs/architecture.md` | System overview and security-relevant data flow |
| `docs/security-contract.md` | Firestore collections and callable API contract |
| `docs/SECURITY.md` | Technical security architecture for WebRTC and pairing |
| `docs/public-scope.md` | What is public here and what remains in the private app repo |
| `docs/verification.md` | Local verification commands for package, functions, and rules |

## Quickstart

### Dart package

```bash
cd packages/baby_monitor_timmy_core
flutter pub get
flutter analyze
flutter test
```

### Cloud Functions

```bash
cd functions
npm ci
npm run lint
npm run test:unit
```

### Firestore rules

Firestore rules tests need the Firestore emulator and Java:

```bash
cd functions
npx firebase emulators:exec --only firestore --project demo-timmy-core "npm run test:rules"
```

This repository owns the canonical production Firestore rules. Deploy rules from
the core repository root:

```bash
firebase deploy --only firestore:rules --project baby-monitor-timmy
```

More detail is available in [`docs/verification.md`](docs/verification.md).

## Security model at a glance

1. Devices pair via an ECDH P-256 exchange using Firestore only as a meeting point.
2. The pairing key is derived locally and never sent to the backend.
3. SDP and ICE signaling payloads are encrypted with AES-256-GCM before they are written to Firestore.
4. Media stays end-to-end encrypted by DTLS/SRTP once WebRTC is established.
5. Firestore signaling writes require either a mobile custom claim or an active Web Companion lease written by a premium mobile app.

For the full technical breakdown, see:

- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security-contract.md`](docs/security-contract.md)

## Public scope and limitations

- This repo is **not** a full self-hosting distribution of the Baby Monitor Timmy product.
- Some deployment-specific values still exist because Firebase rules and Cloud Functions rely on project-specific infrastructure.
- The private app repo still owns UI, orchestration, and non-security product logic.

Those boundaries are documented in [`docs/public-scope.md`](docs/public-scope.md).

## Contributing

Contributions are welcome, but changes should preserve the repository's narrow scope:

- security-relevant backend logic
- protocol surface
- pairing and signaling primitives
- public verification and documentation

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and expectations.

## Security reporting

Please do **not** open a public issue for exploitable vulnerabilities. Use the
private disclosure guidance in [`SECURITY.md`](SECURITY.md).

## License

This repository is licensed under the [Apache License 2.0](LICENSE).

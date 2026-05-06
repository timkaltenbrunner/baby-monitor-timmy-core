# Verification Guide

These commands verify the main public surfaces of `baby-monitor-timmy-core`.

## Prerequisites

- Flutter SDK
- Node.js 22
- Java runtime for the Firebase emulator
- `firebase-tools` available through `npx` or a global install

## 1. Verify the Dart package

```bash
cd packages/baby_monitor_timmy_core
flutter pub get
flutter analyze
flutter test
```

## 2. Verify Cloud Functions helpers

```bash
cd functions
npm ci
npm run lint
npm run test:unit
```

## 3. Verify Firestore rules

```bash
cd functions
npx firebase emulators:exec --only firestore --project demo-timmy-core "npm run test:rules"
```

## Deploy Firestore rules

`firestore.rules` in the core repository root is the canonical production rules
file. Deploy it from this repository, not from the private app repo:

```bash
firebase deploy --only firestore:rules --project baby-monitor-timmy
```

## What each check covers

- `flutter analyze` / `flutter test`
  - pairing crypto
  - ECDH key exchange helpers
  - pair-data serialization
  - protocol constants
- `npm run test:unit`
  - pure backend helper behaviour
  - normalization logic
  - debug-token guards
  - rate limiting helpers
- `npm run test:rules`
  - authenticated vs unauthenticated access
  - schema validation for public collections
  - admin-only write behaviour
  - Firebase deploy config points at the canonical root `firestore.rules`

# Public Scope

This repository is intentionally narrower than the full Baby Monitor Timmy
product.

## Included here

- Firebase Cloud Functions relevant to the public client/server contract
- Firestore rules
- pairing, crypto, and signaling contract code
- architecture and verification documentation

## Intentionally not included

- Flutter UI and screen flow
- app navigation and lifecycle orchestration
- product analytics outside the public security surface
- store submission, release packaging, and marketing tooling

## What external reviewers can verify here

- how pairing keys are established
- which Firestore collections and fields form the protocol surface
- how signaling payloads are encrypted before backend storage
- what backend endpoints exist and what they are responsible for
- what data validation the Firestore rules enforce

## Deployment-specific values

Some values are deployment-specific even in a public repository:

- Firebase project IDs
- secret names and secret provisioning
- admin identifiers used in Firestore rules or admin-only flows

Those values are not treated as secrets, but they should be reviewed and adapted
for any independent deployment.

## Why the full app stays private

The goal of this repo is targeted transparency, not publication of the entire
product. Security reviewers need the trust boundary, protocol, and crypto
implementation far more than they need app-specific presentation code.

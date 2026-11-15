# Security Policy

If you believe you have found a security vulnerability in Baby Monitor Timmy's
public security core, please report it privately.

## Please avoid public disclosure first

Do **not** open a public GitHub issue for exploitable vulnerabilities.

## Preferred reporting path

Use [Report a vulnerability](https://github.com/timkaltenbrunner/baby-monitor-timmy-core/security/advisories/new)
to send a private report directly to the maintainers. The report opens a
private conversation for follow-up.

If you cannot use the GitHub form, use the developer support email listed under
**App support** in [Google Play](https://play.google.com/store/apps/details?id=com.babymonitortimmy.app).

## What to include

- affected component or file
- attack scenario
- impact
- reproduction steps or proof of concept
- any mitigation ideas you already tested

## Scope

This policy applies to the contents of this repository:

- Cloud Functions
- Firestore rules
- pairing and signaling primitives
- documented client/server security contract

The technical security architecture itself is documented in
[`docs/SECURITY.md`](docs/SECURITY.md).

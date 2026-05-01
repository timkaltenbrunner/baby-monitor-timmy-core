# Contributing

Thanks for improving `baby-monitor-timmy-core`.

## Scope

Please keep contributions aligned with the repository's purpose:

- security-relevant backend logic
- Firestore protocol and validation rules
- pairing and signaling primitives
- documentation that helps external reviewers verify the above

Product UI and unrelated app behaviour belong in the private application repo.

## Local workflow

1. Make focused changes.
2. Update docs when public behaviour or verification steps change.
3. Run the relevant checks from [`docs/verification.md`](docs/verification.md).

## Pull request expectations

- explain the security or correctness motivation
- keep public API changes explicit
- include tests for new behaviour where practical
- avoid unrelated cleanup in the same change

## Reporting bigger changes

For larger protocol or security-model changes, start with an issue or discussion
so the boundary and threat-model impact can be reviewed first.

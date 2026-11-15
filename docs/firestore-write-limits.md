# Firestore write limits

The rules cap the quality event tail at 20 entries, matching the shared mobile
and web client code, and cap an encrypted ICE media ID at 1,024 characters.
The existing ICE candidate limit stays below 8,192 characters. Unrelated
updates can still touch session documents with older telemetry shapes.

## Measure before enforcing creation quotas

The four observation functions emit sampled Cloud Logging entries on creation.
They perform no Firestore reads or writes. Candidate sampling selects by session,
so both sides and subsequent ICE rounds share a sample decision. Session and
meeting creation sample by authenticated principal and UTC day where Eventarc
supplies an identity. Unattributed events are reported separately. The log
contains HMAC digests and payload lengths. The identity digest changes daily,
and the session digest is stable across ICE rounds.

The functions default to zero logging. Leave them undeployed until a measurement
window is agreed. For a pilot, set `SIGNALING_METRICS_SAMPLE_PERCENT=5`,
deploy only the four `observe*Creates` functions, and verify that a normal test
write delivers useful auth context before relying on per-device summaries.
The functions still receive creation events for writes outside the sample, so
check invocation volume and logging costs during the window. Keep the sample
rate and analytics HMAC key stable for the window. Disable or remove the
observers when the window ends.

Export the selected window from Cloud Logging and summarize it from
`functions/`:

```sh
gcloud logging read 'jsonPayload.metric="firestore_signaling_usage"' \
  --project baby-monitor-timmy --freshness=7d --format=json |
  jq -c '.[]' | node scripts/summarize_firestore_usage.js
```

The report shows counts per sampled device-day for session and meeting
creation, plus per-session counts and payload sizes by ICE side. Filter to a
known pilot window and exclude partial first/last days from device-day analysis.
Candidate counts are observed over each sampled session, including reconnect
rounds, and may be incomplete at the edges of the observation window.

Review the results alongside two-parent monitoring and reconnect tests before
choosing hard creation quotas. An enforceable quota requires a transaction or
backend-mediated write that checks and advances an authoritative counter before
accepting the create.

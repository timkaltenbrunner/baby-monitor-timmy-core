# Daily session analytics

This subsystem derives private operational statistics from the existing
`/sessions` contract. It does not require or permit an app/Web Companion
change, and no analytics function writes to `/sessions`.

## Private collections

- `session_analytics_segments` — idempotent per raw session, 35 days
- `session_analytics_pairing_days` — per pairing/day review, 365 days
- `session_analytics_daily` — daily totals, 365 days
- `session_analytics_overrides` — admin corrections; bounded corrections expire
  after 365 days, while an explicitly open-ended active correction remains
  configuration until it is superseded
- `session_analytics_override_audit` — immutable correction audit, 365 days
- `session_analytics_rebuild_jobs` — asynchronous rebuild state, 365 days
- `session_analytics_dirty_days` — bounded scheduling markers
- `session_analytics_day_leases` — short-lived scheduler serialization leases

Firestore rules deny every client, including the admin UID, direct access to
these collections. The admin console uses App-Check- and admin-protected
callables. Pairing ids returned for review are shortened opaque ids; pagination
and review tokens are authenticated/encrypted with the analytics secret.

## Fail-closed configuration

Document: `admin/session_analytics_config`

```json
{
  "captureEnabled": false,
  "aggregationEnabled": false,
  "autoExclusionEnabled": false,
  "adminVisible": false,
  "hmacKeyVersion": 1
}
```

Any missing field, non-boolean switch value, or invalid key version disables
the entire subsystem. The capture trigger caches this small config for at most
60 seconds.
`autoExclusionEnabled=false` is also enforced at read time: automatic results
are returned as `unclassified` and never leak into likely-real KPIs, even if a
previous aggregate was built while the switch was enabled.
Manual and automatic breakdowns are materialised separately, so enabling or
disabling automatic exclusion after the shadow period needs neither a raw
session scan nor a synchronous historical rebuild.
Rebuild jobs use 14-day chunks and a 15-minute lease. A crashed `processing`
job is picked up idempotently after the lease instead of remaining stuck.
Override rebuilds update existing retained daily documents only; they never
recreate a document concurrently removed by retention cleanup.
The daily scheduler runs at 04:15 Europe/Zurich rather than inside the 02:00
DST transition hour, so every civil day has exactly one run.

Aggregation reads only the selected day plus the ten-minute grouping boundary
around midnight. If a successful target-day group itself carries a later
reconnect fact, successor windows are followed transitively for at most the
24-hour finalisation horizon, so late Premium/Testphase evidence stays with the
original logical run. A segment in the first ten minutes of a day also
marks the preceding day dirty so late reconnect evidence cannot leave the
previous aggregate stale. Each day is hard-capped at 5,000 unique segments and
500 pairing-day summaries; exceeding a cap fails the aggregation visibly
instead of continuing an unexpected scan.
If aggregation is paused longer than the 35-day segment retention, a later run
preserves existing summaries rather than replacing an unreconstructable day
with fabricated zero values.

Relevant writes for one raw session are coalesced for eight quiet seconds in a
single capture instance. The flush uses the sanitized event snapshots already
delivered by Firestore and performs only the monotone segment transaction; an
extra point-read of `/sessions` is neither needed nor billed. This preserves short-lived
`connected` evidence and normally keeps a connect burst plus a later user end
to two segment writes. Each actual evidence change also refreshes its bounded
dirty-day marker; unchanged Eventarc retries do not. This stays within the
four-write shadow threshold without delaying or writing back to the source
session. `dirtyAt` is sampled only after the segment transaction commits, so a
marker written after an aggregation query cannot appear older than that run's
cutoff; retries repair a missing older marker with their later observation
time.
Documents without a usable `pairingDocKey` are retained only as minimal,
unpairable coverage records (same internal raw-document id, no pairing id). The
daily aggregate reports captured, materialised, invalid-source, and
success-evidence counts so mixed-version gaps are visible during shadow review.
30/90/365 always means Zurich calendar days within known capture coverage;
missing materialisations are returned explicitly as gaps, not fabricated zeros.
Daily aggregation and override rebuilds share a per-day transaction lease, so
separate scheduler instances cannot overwrite the same pairing-day summaries
or daily aggregate concurrently. A late capture keeps its dirty marker when it
arrives after the running aggregation began and is therefore retried.

## Secret and staged deployment

Create one dedicated secret (do not reuse TURN, gift, or signaling secrets):

```bash
printf %s "$(openssl rand -hex 32)" | firebase functions:secrets:set SESSION_ANALYTICS_HMAC_KEY \
  --data-file=- --project baby-monitor-timmy
```

Each `secrets:set` creates a billable enabled version; rotate only intentionally
and destroy obsolete versions after all bound functions use the latest one.
Secret rotation is an ordered maintenance operation: set `captureEnabled=false`
and wait 60 seconds, create the new secret version, redeploy all three
secret-bound functions (`captureSessionAnalyticsSegment`,
`listSessionAnalyticsPairingDays`, `setSessionAnalyticsOverride`), increment
`hmacKeyVersion`, then re-enable capture. Never increment the version before the
new function revision is serving; otherwise old and new secrets can share one
version namespace. New sessions start a new namespace and old/new pairing
pseudonyms are deliberately never joined. Existing review tokens and cursors
become invalid after rotation and must be reloaded in the Admin UI.

Expiry timestamps use a one-day safety margin (34/364 days). Cleanup runs every
six hours with three bounded retries; reaching the 5,000-document safety cap is
treated as a failed attempt so the next retry continues promptly. This keeps
physical deletion within the publicly stated maxima of 35/365 days. The retention job
deletes in 400-document batches up to 5,000 expired
documents per collection and reports any collection that reaches that safety
cap. This is sufficient to clear the maximum permitted one-time backfill in a
single run without turning cleanup into an unbounded delete.

Deploy rules, then only the new functions:

```bash
firebase deploy --only firestore:rules --project baby-monitor-timmy
firebase deploy --only \
functions:captureSessionAnalyticsSegment,\
functions:aggregateDailySessionAnalytics,\
functions:processSessionAnalyticsRebuilds,\
functions:cleanupSessionAnalytics,\
functions:getDailySessionAnalytics,\
functions:listSessionAnalyticsPairingDays,\
functions:setSessionAnalyticsOverride,\
functions:getSessionAnalyticsRebuildStatus \
--project baby-monitor-timmy
```

Seed the config with all switches false before deploying the trigger. Update the
public privacy notice before enabling capture.

## Bounded backfill

The script queries only the last 24 hours and aborts before writes if its
5,000-document safety cap is reached. Because query field `createdAt` is
client-writable, it additionally accepts a document only when Firestore's
server-owned `updateTime` lies inside the same 24-hour window; skipped
candidates are reported. Supply the HMAC key through the process environment
without logging it:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/admin-service-account.json \
SESSION_ANALYTICS_HMAC_KEY="$(firebase functions:secrets:access \
  SESSION_ANALYTICS_HMAC_KEY --project baby-monitor-timmy | sed -n '/^[0-9a-f]\{64\}$/p')" \
node functions/scripts/backfill_session_analytics.js --dry-run
```

Remove `--dry-run` only after checking the bounded document count. Backfill and
the live trigger use the same raw-session document id, monotone evidence, and
source update time.

## Shadow acceptance and rollback

Initial shadow config:

- capture: on
- aggregation: on
- automatic exclusion: off
- admin visibility: off

For seven days, compare controlled simulator runs and inspect all observed
pairing-days (up to 50), focusing on possible false exclusions. Stop and set all
switches false if any of these occurs:

- session writes or cleanup are affected
- trigger errors exceed 0.5%
- an unbounded Firestore scan appears
- average exceeds four analytics writes or three analytics reads per raw session
- known simulator runs are missed
- one confirmed real case is automatically excluded as a test

If invocation cost itself becomes a problem, remove only
`captureSessionAnalyticsSegment`. Existing sessions and signaling continue
unchanged. Keep the old snapshot chart for at least 14 days after visibility is
enabled.

# Firestore cleanup

The scheduled cleanup uses the existing 30-minute interval and retention
windows. It reads one page of up to 50 eligible documents per query and
removes up to 400 ICE candidates per run. Expired sessions with candidates
remaining stay in the queue. Each session deletion and its final candidate
deletions occur in one transaction. The ended-pairing query has a server-owned
cursor to cycle through records even when some are still fresh. The log entry
`Firestore stale cleanup` records deletions, remaining work, and errors.
Repeated backlog indicators warrant checking the job before changing the limits.

## Review historic records

Use the Core repo and Application Default Credentials targeting
`baby-monitor-timmy`. Run the read-only inventory from `functions/`:

```sh
node scripts/firestore_cleanup_inventory.js --dry-run /tmp/timmy-cleanup.json
```

The manifest contains Firestore paths and exact document update times. Keep it
private. The inventory considers records with missing, invalid, or future
retention timestamps only when their server update time is more than 24 hours
old. It also looks for old ICE candidates whose session document is missing.
The console prints only aggregate counts. The scan reads up to 500 documents per
top-level collection and 500 orphan candidates. A nonempty `truncated` list
marks an incomplete inventory.

Review the manifest before applying it. An apply accepts at most 100 proposed
documents and removes at most 400 additional ICE children. It rechecks both
eligibility and version in a transaction and skips candidates whose session
now exists. Sessions with more than 50 candidates on either side are skipped
for separate review. A fast retry of the same manifest skips already deleted
documents.

```sh
node scripts/firestore_cleanup_inventory.js --apply /tmp/timmy-cleanup.json
```

For rollout, deploy `functions:cleanupStaleSessions` and inspect its first
scheduled run. The inventory is independent of the scheduled job and can be
run before or after that deployment.

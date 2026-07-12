# PostgreSQL backup and restore

The database is authoritative for transactional records, authorization, audit evidence, workflow state, document metadata, notifications, and the outbox. A backup is not accepted merely because `pg_dump` exited successfully; it must pass checksum validation and an isolated restore drill.

## Scheduled backup

Run `scripts/backup-postgres.sh` from a restricted backup host using a read-capable backup identity and a `BACKUP_DIRECTORY` on NIET-approved encrypted storage. The script creates a private custom-format dump, validates its archive catalogue, emits a SHA-256 sidecar, and never overwrites an existing timestamped archive.

The storage layer must provide encryption at rest, immutability or object lock, replication to the approved recovery location, retention enforcement, and access logging. These controls are infrastructure responsibilities and are not falsely simulated by the application script. Database credentials must come from the platform secret store rather than command history.

## Restore drill

`scripts/restore-postgres.sh` verifies the sidecar before using `pg_restore --exit-on-error`. It refuses a non-test target unless the operator supplies the explicit approved-change acknowledgement. For every drill:

1. Restore into an isolated network and a newly created database.
2. Run migrations in verification mode and `npm run db:verify` against the restored target.
3. Reconcile schema migration history, audit/outbox counts, workflow counts, document checksums, and domain control totals.
4. Record backup timestamp, recovery start/end, achieved RPO/RTO, exceptions, operator, reviewer, and change ticket.
5. Destroy recovered restricted data according to the approved test-data procedure.

`npm run restore:verify` automates the safe development drill: it requires a `_test` source, inserts a random control record, creates and checksums a backup, restores into a separate `_restore_test` database, verifies both the control and migration history, and removes the temporary database and files.

## Failure handling

- A checksum mismatch is a hard failure; do not attempt recovery from that archive.
- Preserve the failed artifact and logs under restricted incident evidence handling.
- If the latest recovery point fails, use the preceding verified recovery point and report the RPO breach.
- Search indexes, Redis caches, and RabbitMQ transient delivery state are rebuilt or reconciled from PostgreSQL/outbox ownership; they are not substituted for the database backup.
- Production restore authorization, RPO, RTO, retention, and DR-site selection remain blocked by decision D-11.

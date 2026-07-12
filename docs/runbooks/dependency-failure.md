# Dependency and process failure

## Automated drill

`npm run failure:verify` is destructive and therefore requires both the exact disposable PostgreSQL container ID and `FAILURE_DRILL_CONFIRM=DISPOSABLE_TEST_SERVICES`. It must never target production or a shared development database.

The drill starts the compiled API, confirms PostgreSQL readiness, stops the database container, proves that readiness returns `503` while process liveness remains `200`, restarts PostgreSQL, proves connection-pool recovery, replaces the API process, and proves that the replacement reconnects to the same authoritative state. Cleanup attempts to restart PostgreSQL even when an assertion fails.

This validates application behavior for one dependency outage and one stateless API replacement. It does not claim a production HA result: node count, failover manager, fencing, synchronous-replication posture, quorum, RPO, RTO, and failure-domain placement remain governed by D-11 and the approved infrastructure design.

## Operational response

1. Alert on readiness failure, error-rate increase, pool exhaustion, outbox backlog age, and workflow SLA risk. Liveness must not restart a healthy process merely because PostgreSQL is unavailable.
2. Freeze risky administrative changes and communicate degraded status through the approved incident channel.
3. Confirm the failure domain before failover. Never promote two PostgreSQL primaries or bypass fencing.
4. After recovery, reconcile schema migration history, audit/outbox continuity, open workflow tasks, document promotion jobs, notification delivery, and search projection backlog.
5. Replay only idempotent derived work from its authoritative source. Do not replay ledger, result, or approval commands blindly.
6. Record the incident timeline, data-loss boundary, achieved recovery measurements, reconciliation exceptions, and accountable approvals.

Redis, RabbitMQ, MinIO, OpenSearch, Keycloak, network, and storage-node failures require separate approved drills before production acceptance. Their recovery order and thresholds depend on D-11 and selected HA products; this runbook does not invent them.

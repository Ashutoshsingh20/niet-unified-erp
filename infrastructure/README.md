# On-premise infrastructure

The Compose definition is a development and controlled-VM baseline, not a production sizing claim. Production uses separate DMZ, application, data, and management VLANs as specified in the Phase 0 architecture.

It runs the migration job, API, web BFF, TLS gateway, PostgreSQL, Redis, RabbitMQ, MinIO, Keycloak, separate outbox/search workers, OpenSearch, and Prometheus. Application and data networks are internal; only the TLS gateway publishes a host port. Keycloak administration must additionally be restricted at the firewall and administrator-VPN layers.

## Image supply chain

All images must be mirrored into NIET's Harbor registry, pinned by digest, scanned, signed, and approved before deployment. Copy `compose/.env.example` to a protected environment file and replace the `:approved` placeholders with immutable digests.

Build the four application targets from `container/Containerfile`: `api`, `web`, `worker`, and `migrate`.

## Secrets

Secrets are files outside the repository. The example expects a root-readable directory containing one value per named secret. Production should use NIET's approved on-premise secrets/KMS service and short-lived workload credentials where supported.

Create every file listed under `secrets:` with mode `0600`. The document storage identity is provisioned with the bucket-scoped policy in `minio/document-service-policy.json`. Search query and projection identities are separate. TLS private keys and service passwords must never be placed in the environment file.

## Network posture

The Compose networks are internal by default. The included TLS gateway is the only service publishing a host port and is the integration point behind NIET's managed reverse proxy/WAF. Operators may add loopback-only development bindings in an untracked override file; those bindings must never be copied to production.

Prometheus scrapes the API's internal-only `/api/internal/metrics` endpoint. `/api/v1/health/live` proves process liveness, while `/api/v1/health/ready` proves the authoritative PostgreSQL dependency is reachable. Derived-service outages do not incorrectly fail transactional readiness.

Keycloak uses a separate `niet_keycloak` database. Its administration route is not published by the gateway; administrative access requires a separately managed, network-restricted path. Back up and restore that identity database under the Keycloak-supported procedure in addition to the ERP transactional backup.

## Operations gate

Do not report this stack as production-ready until NIET has selected approved images, completed capacity tests, configured HA nodes and certificates, exercised backup restoration, and verified monitoring and incident runbooks.

Backup and recovery operation is defined in `docs/runbooks/backup-restore.md`.

## Initial access bootstrap

After Keycloak is configured and the database migrations have run, one named security administrator may establish the first technical access-governance role:

```bash
DATABASE_URL='postgresql://...' \
BOOTSTRAP_SUBJECT_ID='keycloak-subject-id' \
npm run access:bootstrap
```

The command takes an advisory lock, refuses to run if access data already exists, and writes an immutable audit event. The bootstrap assignment should be replaced with institution-approved roles after NIET resolves decision D-02.

## OpenSearch identities

The Compose file declares a dedicated search worker identity placeholder. Before enabling the `search` profile, create separate query and indexing service identities through the approved OpenSearch security administration process, install the NIET internal CA in the API and worker images, and write only the service password files referenced by Compose. Do not reuse the OpenSearch administrator account in application configuration.

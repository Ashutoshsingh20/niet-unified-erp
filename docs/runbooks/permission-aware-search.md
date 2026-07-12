# Permission-aware search runbook

## Security boundary

OpenSearch is a derived candidate index, not an authorization authority. Every result follows two independent filters:

1. OpenSearch filters candidates by the caller's effective permission and scope claims.
2. The API rehydrates candidate IDs from the PostgreSQL search registry and re-evaluates permission and scope from that authoritative record.

If the index is stale, corrupted, or deliberately altered, it may hide results but must not expose a record the PostgreSQL policy denies.

## Projection lifecycle

Domain modules register a source-owned projection containing source type and ID, monotonic source version, plain-text title and summary, required capability, scope, classification, and an internal action path. Registration and its audit/outbox evidence commit together.

The background worker claims pending records with `FOR UPDATE SKIP LOCKED`, creates the strict-mapped index if necessary, indexes the projection, and only then records the indexed version. Failures use bounded retry and terminal failure state without blocking transactional ERP operations.

Consumers must never write a projection version lower than the source's current version. Full source records, protected notes, government identifiers, bank details, health information, or document bodies must not be indexed merely because they are searchable in a source UI.

## OpenSearch controls

- Deploy only in the data VLAN with TLS and service authentication.
- Use separate least-privilege credentials for API query and worker indexing.
- Disable dynamic mappings; the worker creates an explicit schema.
- Encrypt storage and snapshots; apply retention and capacity monitoring.
- Do not expose OpenSearch Dashboards or the REST endpoint to general users or the internet.
- Alert on projection backlog age, failed projections, query latency/errors, index health, disk watermarks, and authorization-filter anomalies.

## Degradation

If OpenSearch is unavailable, the search endpoint returns a service-unavailable response. Core records and workflows remain available through their owning modules. Do not fall back to an unbounded transactional-database search that could overload PostgreSQL during an outage.

## Verification

Against an isolated `_test` PostgreSQL database and test OpenSearch index:

```bash
DATABASE_URL='postgresql://.../niet_erp_test' \
OPENSEARCH_NODE='https://127.0.0.1:9200' \
OPENSEARCH_USERNAME='test-indexer' \
OPENSEARCH_PASSWORD='test-password' \
OPENSEARCH_INDEX='niet-erp-search-verification' \
npm run search:verify
```

The verifier proves successful projection, allowed retrieval, permission denial, scope denial, and that tampering with authorization fields in OpenSearch cannot bypass PostgreSQL re-authorization.

On a disposable developer machine already below OpenSearch's disk watermark, set `OPENSEARCH_TEST_DISABLE_DISK_THRESHOLDS=true` for this verifier only. The script clears the test cluster's create-index block. Never disable disk thresholds in NIET production; expand capacity or remove data according to the approved retention plan.

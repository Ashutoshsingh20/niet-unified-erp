# Performance baseline

`npm run load:verify` provides a repeatable HTTP saturation smoke test with bounded concurrency, a five-second per-request timeout, a zero-error requirement, and a configurable p95 ceiling. The checked-in Phase 1 evidence targets `/api/v1/health/ready`, so it proves the API runtime, network stack, and one PostgreSQL round trip under modest concurrency. It does not claim domain-scale capacity.

Example:

```bash
LOAD_TEST_URL=http://127.0.0.1:3001/api/v1/health/ready \
LOAD_TEST_REQUESTS=500 LOAD_TEST_CONCURRENCY=25 LOAD_TEST_MAX_P95_MS=500 \
npm run load:verify
```

Production capacity acceptance remains blocked by D-11 and requires approved concurrency, data volume, workflow mix, report mix, search mix, network conditions, SLOs, and headroom. Once those inputs exist, run workload-specific tests against synthetic representative data, retain percentile/error/resource graphs, test soak and spike behavior, and size every tier from measured saturation rather than the Phase 1 smoke threshold.

# Phase 1 acceptance audit

This audit distinguishes implemented evidence from institutional acceptance. “Verified” means an executable repository or CI check directly proves the stated scope. “Partial” means useful implementation exists but the phase-level claim is broader than its evidence. “Blocked” means NIET policy, infrastructure, or accountable approval is required and no default has been invented.

## Foundation gate

| Requirement | Status | Authoritative evidence | Remaining boundary |
|---|---|---|---|
| Reproducible Node 24 monorepo | Verified | `npm ci`, `npm run verify`, public `quality` workflow | Approved internal npm mirror remains an operations input. |
| API validation, correlation, errors, versioning, OpenAPI | Verified | validation pipe, request-context tests, `npm run contract:verify` | Contract compatibility policy for later public versions is not yet needed. |
| Keycloak/OIDC and deny-by-default authorization | Partial | `npm run oidc:verify`, policy tests, BFF OIDC/PKCE implementation | A real NIET realm, MFA policy, canonical identifiers, and production certificates require D-01/D-02 and identity-owner acceptance. |
| Organization scope, roles, delegation, reviews | Verified for platform model | `npm run access:verify`, access-governance runbook | Production role catalogue and SoD decisions require D-02. |
| Immutable audit and transactional outbox | Verified | `npm run db:verify`, workflow/outbox verifiers | Retention, legal hold, and SIEM operating ownership require D-03. |
| Versioned workflow and approval inbox | Verified | `npm run workflow:verify`, `npm run platform-slice:verify`, web tests | Domain-specific approval rules remain policy-owned. |
| Secure document lifecycle | Verified | document unit/integration verifiers and real MinIO verifier | Retention periods and production malware engine selection require D-03 and procurement. |
| Notification centre and opaque push | Verified | `npm run notifications:verify`, outbox verifier, notification UI tests | External push posture requires D-10. |
| Permission-aware search | Verified | real OpenSearch verifier plus tampered-index and platform-slice denial checks | Production taxonomy and capacity require representative data and D-11. |
| Accessible design system/web shell | Partial | automated axe checks, keyboard search, responsive shell build | Formal WCAG audit with representative users and assistive technologies remains external acceptance. |
| On-premise service topology and observability | Partial | Compose definition, four successful container builds, metrics/readiness tests | Approved images, certificates, HA nodes, firewall/WAF rules, sizing, and complete stack commissioning require NIET infrastructure. |
| Migration, authorization, contract, accessibility, load, restore tests | Verified for Phase 1 synthetic scope | CI database/access/contract/axe/load/restore evidence | Production volumes and SLO thresholds require D-11 and representative data. |
| Correlated approval vertical slice | Verified at application-service boundary | `npm run platform-slice:verify` | Final browser-to-Keycloak-to-object-store acceptance requires commissioned on-premise services. |

## Threat-control evidence

| Threat/control | Automated evidence |
|---|---|
| Forged, wrong-issuer, wrong-audience, expired, malformed, or subjectless tokens | `npm run oidc:verify` |
| Missing permission, insufficient assurance, or wrong scope | policy tests and `npm run access:verify` |
| Maker approving own request | `npm run workflow:verify` |
| Concurrent stale workflow/preference changes | workflow and notification verifiers |
| Audit mutation or deletion | `npm run db:verify` |
| Lost transactional event between state and publication | workflow/outbox verifiers and RabbitMQ confirms |
| Malicious filename, MIME/hash mismatch, or unscanned download | document and object-storage verifiers |
| Search-index permission tampering | `npm run search:verify` |
| Sensitive external push content | `npm run notifications:verify` asserts event-ID-only payload |
| Database outage and API crash-loop confusion | `npm run failure:verify` distinguishes readiness from liveness |
| Corrupt or unrestorable logical backup | `npm run restore:verify` validates checksum and isolated recovery |

## Exit-gate decision

Phase 1 implementation is materially complete for the synthetic, repository-owned foundation, but the architecture’s production exit gate is **not approved**. The following cannot be honestly satisfied from code alone:

- accountable approval of D-01 through D-04 and D-11;
- NIET identity realm and MFA acceptance;
- approved production roles, SoD, retention, and recovery objectives;
- commissioned HA infrastructure, WAF/firewalls, certificates, immutable backup storage, and admin network path;
- representative capacity and accessibility acceptance;
- operational-runbook acceptance by named NIET owners.

These are release blockers, not reasons to fabricate defaults. Later domain development may proceed behind unpublished, versioned configuration and synthetic test fixtures, but no phase is represented as production-approved until its accountable gate is signed.

# Delivery plan

This backlog operationalizes [PHASE_0_ARCHITECTURE.md](../PHASE_0_ARCHITECTURE.md). A phase is complete only after its workflows, authorization, audit, tests, deployment, monitoring, and recovery evidence pass its gate.

## Policy decision register

Unknown NIET rules remain configurable and blocked from production publication until an accountable owner approves them.

| ID | Decision | Owner | Status |
|---|---|---|---|
| D-01 | Canonical identity sources and identifiers | Registrar, HR, IT | Open |
| D-02 | Roles, scopes, delegation, and segregation of duties | Registrar, HR, Finance, Exam Cell | Open |
| D-03 | Classification, retention, legal hold, and deletion | Data Governance, Legal, Security | Open |
| D-04 | Guardian consent and exceptional access | Student Affairs, Legal | Open |
| D-05 | Academic and examination regulations | Academic Council, CoE | Open |
| D-06 | Admission, seat, refund, and scholarship rules | Admissions, Finance | Open |
| D-07 | Fee, accounting, tax, and approval policy | Finance | Open |
| D-08 | Question-paper custody and confidentiality | CoE | Open |
| D-09 | Wellbeing and medical access policy | Student Welfare, Medical, Legal | Open |
| D-10 | External providers and mobile push posture | Management, Security | Open |
| D-11 | Per-module SLO, RPO, RTO, and maintenance windows | Management, IT | Open |

## Phase 1 foundation gate

- [ ] Reproducible monorepo build on Node 24 LTS.
- [ ] API convention, validation, correlation, error, and OpenAPI contracts.
- [ ] Keycloak integration and deny-by-default resource authorization.
- [ ] Organization scopes, versioned roles/policies, delegation, and access review.
- [ ] Immutable audit trail coupled to transactions through an outbox.
- [ ] Versioned workflow definition, task inbox, approval, rejection, delegation, and SLA model.
- [ ] Document quarantine, validation, malware scan adapter, versioning, and signed retrieval.
- [ ] In-app notification centre with opaque external push events.
- [ ] Permission-aware search foundation with source re-authorization.
- [ ] Accessible design system and initial web shell.
- [ ] PostgreSQL, Redis, RabbitMQ, MinIO, Keycloak, and observability development stack.
- [ ] Migration, negative authorization, API contract, accessibility, load, and restore tests.
- [ ] End-to-end approval vertical slice and operational runbook.

### Verified implementation evidence

- PostgreSQL migrations are checksum-protected and idempotent on a fresh database.
- Immutable audit mutation rejection is exercised by `npm run db:verify`.
- Effective role, descendant organization scope, bounded delegation, source-revocation, and access-review revocation are exercised by `npm run access:verify`.
- Workflow publication, maker/checker denial, approval, optimistic versioning, audit, and outbox coupling are exercised by `npm run workflow:verify`.
- Access operating procedures are documented in `docs/runbooks/access-governance.md`.
- Document quarantine, scanner-computed integrity, MIME enforcement, promotion, signed download, audit, and outbox behavior are exercised by `npm run documents:verify`.
- Presigned upload, MinIO metadata, bucket promotion, and signed download are exercised against a real local MinIO service by `npm run object-storage:verify`.
- Document security operations are documented in `docs/runbooks/document-security.md`.
- Notification template publication, optimistic push consent, recipient-only inbox, read state, and opaque-payload structure are exercised by `npm run notifications:verify`.
- RabbitMQ publisher confirms, persistent event envelopes, PostgreSQL publication state, and retry scheduling are exercised by `npm run outbox:verify`.

## Subsequent gates

Phases 2–7 follow the scope and gates defined in the architecture document. Each domain receives its own specification before implementation and may not bypass unresolved policy decisions with assumed rules.

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
- The web ERP shell provides OIDC/PKCE/nonce sign-in, encrypted HTTP-only BFF sessions, a live role-aware overview, scope-filtered approval inbox, request submission, decision actions, and the notification centre.
- Automated accessibility checks cover the shell landmark/navigation structure; production build and local sign-in preview are verified without public hosting.
- Search projections use strict OpenSearch mappings and bounded retry; API results are filtered in the index and re-authorized from PostgreSQL before disclosure.
- The API exposes bounded-label Prometheus process/request metrics plus separate liveness and PostgreSQL readiness probes; the on-premise topology keeps metrics and application/data tiers off published host ports.
- `npm run restore:verify` creates a checksum-protected logical backup and proves an isolated PostgreSQL recovery with migration history and a random control record. Production encryption, immutability, retention, RPO, and RTO remain explicit infrastructure/policy gates.
- `npm run load:verify` passes a 500-request, concurrency-25 runtime/PostgreSQL smoke baseline with a zero-error and p95 threshold; it is not substituted for the D-11 production capacity workload.
- GitHub quality gates reproduce Node 24 build, lint, tests, database migration and platform verifiers, restore proof, audit, and all four deployment-image builds.
- `npm run platform-slice:verify` correlates one clean document, independently approved request, recipient notification, authorized search result, forbidden search denial, audit trail, and outbox evidence under one request context using real PostgreSQL and OpenSearch.
- `npm run failure:verify` proves database-loss readiness isolation, continued API liveness, connection recovery, and stateless API process replacement against disposable CI services.
- `npm run contract:verify` boots the compiled API and validates the generated OpenAPI 3 document for required versioned operations, request schemas, bearer declarations, and absence of unversioned workflow routes.
- `npm run oidc:verify` serves an ephemeral JWKS and proves signature, issuer, audience, expiry, subject, session, and assurance-level handling, including negative tokens.

## Subsequent gates

Phases 2–7 follow the scope and gates defined in the architecture document. Each domain receives its own specification before implementation and may not bypass unresolved policy decisions with assumed rules.

Phase 2 implementation is governed by [PHASE_2_STUDENT_CORE_SPEC.md](phases/PHASE_2_STUDENT_CORE_SPEC.md). The specification keeps D-01/D-02/D-05/D-06/D-07/D-11-dependent rules unpublished while permitting synthetic, versioned foundations and verification work.

### Phase 2 implementation evidence

- The canonical student foundation creates only `PROVISIONAL` records, preserves immutable source provenance, enforces exact-retry idempotency, records append-only status history, couples audit/outbox evidence transactionally, and denies reads outside scope through `npm run students:verify`.
- Restricted alternate identifiers have no plaintext column: storage requires encrypted bytes plus a non-reversible lookup fingerprint. Identifier authority, matching, student-number format, and account-link policy remain blocked by D-01 rather than hardcoded.
- The curriculum regulation registry stores immutable versioned rule documents, requires scope and optimistic publication state, emits audit/outbox evidence, and defaults production publication off through `ACADEMIC_POLICY_PUBLICATION_ENABLED=false`; `npm run curriculum:verify` publishes only an explicitly empty synthetic preview.
- Registration periods and offerings are immutable after gated publication; requests are idempotent and remain pending until an enabled evaluator records its version, published regulation, trace, and reason. `npm run registration:verify` proves disabled gates, serialized capacity, append-only decisions, audit, and minimum-data events with synthetic rules only.
- Attendance stores one immutable raw observation per confirmed roster member and keeps raw presence separate from any institutional consequence. Finalization requires a complete roster and records a canonical evidence hash; approved corrections append maker-checker deltas instead of rewriting history. Both policy-dependent actions default off, while `npm run attendance:verify` proves scope isolation, gates, evidence immutability, correction separation, audit, and minimum-data events using synthetic data.
- The student subledger stores money only as integer minor units with ISO currency, creates balanced double-entry demand/payment journals, rejects changed idempotent retries, and appends exact inverse maker-checker reversals. Posting and reversal gates default off until NIET rules and providers are approved; `npm run finance:verify` proves scope, gates, balance-at-commit, immutability, derived receivable balance, audit, and minimum-data events.
- Migration batches retain only encrypted candidate payloads plus immutable source hashes, require exact row-count and canonical-hash reconciliation, and separate reconciliation from approval. Application defaults off and fails closed even when enabled unless a domain-specific approved adapter exists; `npm run migration:verify` proves scope, duplicate rejection, control totals, maker-checker, immutable evidence, audit, and minimum-data events without importing unverified records.
- Separate React Native CLI foundations now exist for NIET Student and NIET Staff with native Android/iOS projects, accessible role-specific preview shells, dark-mode support, no production mock records, and explicit fail-closed identity/offline/push posture. Workspace typecheck, lint, and render tests cover both apps; native signing, devices, and approved mobile-security policy remain acceptance gates documented in `docs/runbooks/mobile-build.md`.
- Admissions drafts retain encrypted application content plus integrity hashes, enforce exact idempotent retries and applicant-owned submission, freeze submitted payloads, and record evaluator/version/regulation evidence for every decision. Production decisions default off until D-06 is approved; `npm run admissions:verify` proves the encryption boundary, scope, ownership, gate, append-only evidence, audit, and minimum-data events.
- Timetable meetings use recurring weekday/minute slots with PostgreSQL exclusion constraints for room, instructor, and offering overlaps. Published meetings are immutable and publication defaults off until scheduling policy is approved; `npm run timetable:verify` proves scope, the gate, conflicting overlap rejection, adjacent-slot acceptance, audit, and minimum-data schedule events.

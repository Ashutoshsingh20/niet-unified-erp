# Phase 2 — Student core specification

Status: implementation specification using synthetic data only. This document does not approve NIET policy. D-01, D-02, D-05, D-06, D-07, and D-11 remain authoritative blockers for production publication.

## 1. Problem and outcomes

Phase 2 establishes one provenance-preserving student record from admission conversion through programme enrolment, curriculum assignment, term registration, timetable, attendance, and fee subledger. It must eliminate duplicate identities, hidden rule changes, direct balance edits, and unverifiable migration while giving students a usable web/mobile minimum journey.

Success means a synthetic applicant can be converted exactly once into a scoped canonical student; assigned an effective-dated programme/curriculum; registered under a published rule version; given a conflict-free schedule; have attendance finalized from immutable session evidence; receive balanced fee demands/payments; and reconcile to source/control totals with complete authorization, audit, outbox, and failure evidence.

## 2. Roles and access boundaries

- Applicant/student: own application, profile, registration, schedule, attendance, and fee view.
- Admissions processor/approver: assigned application scope with maker-checker for offers, conversion, and exceptional decisions.
- Registrar/records officer: scoped canonical record and status operations; no automatic finance or protected-case access.
- Curriculum author/publisher: separate draft and publication capability with step-up.
- Programme registration operator/adviser: assigned programme/cohort scope; exception approval is separate.
- Faculty/attendance finalizer: assigned section/session only; finalization separate from correction approval where configured.
- Finance operator/approver: fee subledger capability; reversal/refund maker-checker and step-up.
- Student auditor/data steward: read-only approved scope, provenance, reconciliation, and change history.
- Technical/security administrator: technical metadata only, never implicit student-business access.

Named roles, inheritance, SoD combinations, delegation, guardian access, and exceptional access are D-02/D-04 decisions. APIs use capabilities and scopes, not hardcoded job titles.

## 3. User journeys

1. Applicant saves and submits an application with required evidence and receives immutable submission acknowledgement.
2. Two authorized actors evaluate and approve an offer/exception where the published workflow requires it.
3. Acceptance converts the application exactly once into a person link, student number, and programme enrolment with source provenance.
4. Registrar resolves an identity-match exception without overwriting either source record and records disposition evidence.
5. Curriculum owner publishes a regulation/curriculum version effective for explicit cohorts.
6. Student previews degree requirements and registers for eligible sections; unresolved holds/conflicts return explainable denials.
7. Student sees schedule changes and attendance; faculty records session evidence and an authorized finalizer closes it.
8. Finance raises versioned demands, posts provider-confirmed payments idempotently, and processes reversals/refunds through approval.
9. Student receives in-app notifications and can search only their authorized records.
10. Data steward imports a synthetic migration batch, reconciles counts/control totals, quarantines exceptions, and obtains approval.

## 4. Policy and rule configuration

Rules are effective-dated, versioned, drafted, validated, impact-tested, and published by separate capabilities. No production rule is inferred from common university practice.

- D-01: canonical identifiers, matching attributes, number formats, source precedence.
- D-05: programme structures, credit limits, prerequisites, equivalence, progression, repeats, attendance consequences.
- D-06: eligibility, seat matrices, category/reservation, merit, offer expiry, conversion and refund interaction.
- D-07: fee heads, demand schedules, waivers, scholarships, taxes, allocation, reversal/refund and accounting mappings.
- D-04: guardian relationship, consent, visibility, age/status transitions.
- D-11: capacity, SLO, RPO/RTO, batch windows, timetable/registration peak targets.

Unpublished rules may run only in synthetic preview. Transactions reference the exact published rule version used; later changes never silently reinterpret history.

## 5. Workflows and state machines

- Application: `DRAFT → SUBMITTED → UNDER_REVIEW → OFFERED/REJECTED → ACCEPTED/EXPIRED/WITHDRAWN → CONVERTED`.
- Student record: `PROVISIONAL → ACTIVE → SUSPENDED/ON_LEAVE → COMPLETED/WITHDRAWN/TERMINATED`; transitions are policy-driven and append history.
- Curriculum: `DRAFT → VALIDATED → PUBLISHED → SUPERSEDED/RETIRED`; published versions are immutable.
- Registration: `DRAFT → SUBMITTED → CONFIRMED/WAITLISTED/REJECTED → DROPPED/WITHDRAWN`; decisions retain evaluated-rule evidence.
- Attendance session: `PLANNED → OPEN → RECORDED → FINALIZED → CORRECTED`; corrections append approved deltas.
- Fee transaction: demands, allocations, receipts, waivers, reversals, refunds, and journals are append-only ledger entries; status is derived.
- Migration batch: `CREATED → STAGED → VALIDATED → RECONCILED → APPROVED → APPLIED/REJECTED`.

Transition matrices are configuration where policy-dependent. Illegal and stale transitions fail closed.

## 6. Data ownership and model

Bounded schemas own their writes:

- `admissions`: applications, application versions, evaluations, offers, seat decisions, conversion idempotency.
- `student`: person links, student records, identifiers, programme-enrolment history, contacts, guardian/consent references, holds, provenance.
- `curriculum`: regulations, programmes, course catalogue, curriculum versions, requirements, equivalences, evaluation snapshots.
- `registration`: academic periods, offerings, sections, capacities, registrations, waitlist entries, timetable meetings/conflicts.
- `teaching`: class sessions, attendance observations, finalizations, approved corrections.
- `finance`: accounts, fee-rule versions, demands, immutable subledger entries, provider events, reconciliations.
- `migration`: immutable source snapshots, batches, mappings, staged rows, exceptions, control totals, approvals.

Cross-domain write joins are forbidden. Stable IDs, application services, and versioned events connect domains. Restricted identifiers are envelope-encrypted outside index/log/event payloads. Every migrated row carries source system, source key, snapshot/batch, extraction time, mapping version, and row hash.

## 7. API contracts

All endpoints are `/api/v1`, validated, paginated, scope-filtered, optimistic-locking aware, and described in OpenAPI. Planned groups:

- `/admissions/applications`, `/offers`, `/conversions`
- `/students`, `/students/{id}/status`, `/identifiers`, `/holds`
- `/curricula`, `/programmes`, `/courses`, `/degree-audits`
- `/academic-periods`, `/sections`, `/registrations`, `/timetables`
- `/sessions`, `/attendance`, `/attendance-corrections`
- `/student-accounts`, `/fee-demands`, `/payments`, `/reversals`, `/refunds`, `/reconciliations`
- `/migration/batches`, `/rows`, `/exceptions`, `/control-totals`, `/approvals`

Create/command endpoints accept an idempotency key where retries can duplicate a business effect. Responses never expose restricted identifiers without a field-specific step-up capability.

## 8. Permission catalogue

Capabilities use domain/action names and explicit scope, including `admission.application.*`, `admission.offer.*`, `student.record.read/write/status`, `student.identifier.restricted`, `curriculum.draft/publish`, `registration.submit/decide/override`, `attendance.record/finalize/correct`, `finance.student-account.read`, `finance.demand.raise`, `finance.payment.post`, `finance.reversal.approve`, and `migration.student.*`.

Self access is an ownership constraint in addition to permission. Publication, overrides, conversion, restricted identifiers, bulk export, status termination, attendance correction, payment reversal, and refund require configurable step-up/maker-checker. Deny is the default.

## 9. Audit and event evidence

Audit records capture actor, delegated actor, action, aggregate/version, scope, rule version, reason, correlation/causation, changed field names (not sensitive values), source provenance, and outcome. Key events include `ApplicationSubmitted`, `OfferAccepted`, `StudentCreated`, `StudentStatusChanged`, `CurriculumPublished`, `RegistrationConfirmed`, `ScheduleChanged`, `AttendanceFinalized`, `DemandRaised`, `PaymentPosted`, `RefundApproved`, and migration events. Outbox payloads contain only minimum classified data.

## 10. Screens and accessibility

- Applicant application/evidence checklist with save, validation, submission, and status states.
- Student home, profile, programme/curriculum, degree progress, registration, timetable, attendance, and fee statement.
- Staff worklists for application review, identity exceptions, record changes, curriculum publication, registration exceptions, attendance finalization, finance reconciliation, and migration exceptions.
- Mobile minimum: own tasks/notifications, schedule, attendance, registration status, fee balance/receipts; offline cache excludes restricted identifiers and financial details unless explicitly approved.

Every screen includes loading, empty, error, stale/conflict, permission-denied, and degraded states; keyboard, screen-reader, focus, contrast, reflow, and reduced-motion checks are required.

## 11. Validation and invariants

- IDs are immutable and opaque; alternate identifiers are typed, unique within approved authority, normalized without losing original provenance.
- Conversion is idempotent and cannot create a second student for the same accepted application.
- Programme-enrolment histories cannot overlap for the same policy-defined relationship.
- Published curricula/rules are immutable and effective ranges cannot create ambiguous selection.
- Registration decisions persist evaluated prerequisites, holds, capacity, conflicts, and rule version.
- Timetable overlaps, room capacity, instructor conflicts, and section capacity fail unless a separately authorized override rule permits them.
- Attendance finalization has one version per session; corrections are signed deltas, never destructive edits.
- Every financial posting is balanced in the student subledger; provider events and receipts are unique; reversals reference original entries.
- Money uses integer minor units plus ISO currency; no floating-point arithmetic.
- Migration cannot apply before reconciliation and approval; invalid rows remain quarantined.

## 12. Notifications

In-app notifications cover submission, evidence deficiency, offer/expiry, conversion, registration decision/waitlist, schedule change, attendance finalization/correction, demand/receipt/refund, hold changes, and migration exception assignment. External push remains opaque and policy-gated. Notification creation is idempotent by source event and recipient.

## 13. Reports and reconciliation

Operational reports include application funnel, seat decisions, active student/cohort counts, registration/section capacity, timetable conflicts, attendance completeness, student account ageing, provider reconciliation, refunds, and migration exceptions. Certified totals carry definition/version, source lineage, refresh time, owner, quality state, and approval; heavy reports use a reporting projection rather than OLTP.

## 14. Integrations

Adapters—not domain services—handle identity sources, admission portals, payment providers/banks, accounting, ABC/APAAR/DigiLocker/NAD when approved, email/SMS/push, timetable/room sources, and legacy extracts. Each adapter validates signatures/schema, deduplicates provider IDs, quarantines unknown mappings, rate-limits, retries boundedly, and reconciles acknowledgements. No external provider is assumed selected.

## 15. Failure and recovery behavior

- Identity-match ambiguity creates a restricted exception; it never guesses.
- Seat/capacity races use locking/constraints and deterministic retry feedback.
- Registration/payment retries are idempotent and return the original outcome.
- Provider timeout remains `PENDING_CONFIRMATION`; it is not presented as payment success or failure without evidence.
- Search/reporting/notification outages do not mutate authoritative decisions; backlogs recover from outbox/source versions.
- Partial migration batches never become visible as production truth.
- Restore/failover reconciliation includes students, registrations, attendance versions, subledger totals, outbox, and provider cursors.

## 16. Security, privacy, and abuse risks

Primary risks are duplicate/merged identities, enumeration, overbroad staff scope, guardian overreach, bulk export, insider record changes, attendance fabrication, seat manipulation, fee reversal fraud, webhook replay, restricted-ID leakage, and migration poisoning. Controls include opaque IDs, rate limits, field-level capabilities, step-up, maker-checker, signed evidence, append-only histories/ledger, export controls, anomaly alerts, encrypted restricted fields, synthetic non-production data, and immutable audit.

## 17. Test strategy

- Unit/property tests for identifiers, effective dates, state machines, money/ledger balance, prerequisites, conflict detection, and idempotency.
- PostgreSQL integration tests for uniqueness, exclusion/check constraints, optimistic locking, append-only histories, outbox coupling, and concurrent seats/payments.
- Negative authorization for every capability, self/assigned/programme/institution scopes, restricted fields, delegation, and revoked access.
- Contract, accessibility, browser/mobile, event-schema, adapter, migration, reconciliation, load/soak/spike, backup/restore, and dependency-failure tests.
- Synthetic cohort fixtures include duplicates, changed names, missing IDs, transfer/equivalence, waitlists, conflicting schedules, attendance corrections, partial/duplicate payments, reversals, and corrupt legacy rows.

## 18. Deployment and observability

Phase 2 remains modules in the modular monolith plus isolated workers/adapters. Migrations are backward-compatible and checksum-protected. Metrics cover workflow/backlog age, conversion duplicates, identity exceptions, registration latency/conflicts, timetable conflicts, attendance finalization lag, ledger imbalance invariant failures, provider reconciliation age, migration exceptions, and authorization denials—without student identifiers in labels/logs.

## 19. Migration wave one

Only immutable synthetic or approved masked snapshots enter development. Production migration requires source inventory, owner, extraction/hash manifest, mapping version, canonical-ID strategy, dry runs, count/control-total reconciliation, exception ownership, approval, rollback/cutover, dual-run limit, and archive/decommission acceptance. Wave one targets canonical students, programme enrolments, curricula, current registrations, attendance aggregates/source evidence references, open fee balances with ledger provenance, and document links.

## 20. Acceptance gate

The Phase 2 implementation gate requires one admission-to-student conversion and registration/fee/attendance journey to pass authorization, maker-checker, audit/outbox, document, notification, search, accessibility, load, recovery, migration, and reconciliation tests using approved rules and representative masked/synthetic volumes. Production exit additionally requires D-01/D-02/D-05/D-06/D-07/D-11 approval, business-owner/data-steward sign-off, and reconciled control totals. Until then, the modules are deployable only as unpublished preview configuration.

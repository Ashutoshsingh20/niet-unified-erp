# ADR 0001: Begin as a modular monolith

- Status: Accepted by architecture baseline; institutional review pending
- Date: 2026-07-12

## Context

NIET Unified ERP spans many domains, but NIET must be able to operate, secure, recover, and evolve the system with an internal team. Premature service decomposition would add distributed transactions, deployment coordination, network failure modes, and operational cost before real scaling evidence exists.

## Decision

The transactional application begins as a TypeScript modular monolith. Every domain owns its application services, domain model, persistence schema, APIs, permissions, and events. Modules cannot write another module's tables. External integrations and derived workloads communicate through versioned ports and events.

Independent deployment is reserved for identity, document processing/storage, notifications, search, reporting, workers, and external integrations where isolation or scaling is demonstrated.

## Consequences

- Local domain operations retain ACID transactions.
- Cross-domain processes use durable workflows and outbox events.
- Automated dependency rules and database ownership tests are required.
- A module may be extracted only through a reviewed ADR supported by operational evidence.


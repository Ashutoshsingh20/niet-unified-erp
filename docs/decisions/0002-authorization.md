# ADR 0002: Application-enforced RBAC and ABAC

- Status: Accepted by architecture baseline; NIET role policy pending
- Date: 2026-07-12

## Context

Realm roles alone cannot represent programme, department, cohort, relationship, consent, purpose, record-state, delegation, or step-up requirements.

## Decision

Keycloak authenticates users and supplies stable identity and coarse platform claims. The ERP makes every resource decision using application-owned RBAC and ABAC policy evaluation. Authorization is deny-by-default and evaluates subject, action, resource, scope, relationship, purpose, consent, record state, time, and assurance level.

Roles and policy bindings are versioned data. They are never hard-coded in UI components. High-risk actions require configurable step-up, segregation-of-duties, reason, and approval controls.

## Consequences

- APIs must authorize every resource access, including search result hydration and WebSocket subscriptions.
- Every role and action requires negative authorization tests.
- System administration does not imply access to business records.


# NIET Unified ERP

Architecture and delivery planning for a production-grade, on-premise enterprise resource planning platform designed for Noida Institute of Engineering and Technology, Greater Noida.

## Current status

Phase 0 architecture is documented and implementation is progressing through the governed Phase 1
and Phase 2 platform/domain foundations. Authentication, scoped authorization, workflows, audit,
outbox processing, student/curriculum/registration foundations, finance/admissions foundations, and
on-premise deployment assets are present. Policy-gated operations remain disabled until NIET owners
approve the corresponding institutional rules; see the delivery plan for the exact acceptance gaps.

The proposed system architecture, security model, deployment topology, migration strategy, institutional decision gates, and phased delivery plan are documented in [PHASE_0_ARCHITECTURE.md](./PHASE_0_ARCHITECTURE.md).

## Deployment principle

Institutional data, authentication, files, logs, backups, and business services are designed to remain on infrastructure physically controlled by NIET. External integrations are limited to approved government, financial, communications, and mobile distribution services where technically or legally required.

## Next step

Continue closing the documented Phase 2 acceptance gaps while NIET stakeholders resolve the policy
and data-governance decisions that cannot be inferred safely.

## Development status

Phase 1 implementation is active. The repository now includes the strict TypeScript API foundation, Keycloak-compatible authentication, database-owned RBAC/ABAC grants, transactional workflows, immutable audit records, an outbox, checksum-verified PostgreSQL migrations, and an on-premise infrastructure baseline.

### Local quality gate

Use Node 24 LTS, then run:

```bash
npm ci
npm run verify
```

Database migrations require an isolated PostgreSQL database and an explicit connection string:

```bash
DATABASE_URL='postgresql://user:password@host:5432/database' npm run db:migrate
```

Never point development or automated tests at a production database.

For local sign-in and account-registration setup, follow
[`docs/runbooks/web-identity-and-bff.md`](./docs/runbooks/web-identity-and-bff.md#local-review-bootstrap).

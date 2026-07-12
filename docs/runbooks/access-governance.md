# Access governance runbook

## Purpose

This runbook covers the technical access-governance foundation. It does not define NIET business roles or approval policy; those remain blocked by decision D-02.

## Initial bootstrap

1. Configure Keycloak and identify the immutable `sub` claim of the named NIET security administrator.
2. Run all checksum-verified database migrations.
3. Execute `npm run access:bootstrap` with `DATABASE_URL` and `BOOTSTRAP_SUBJECT_ID` supplied through the protected operator environment.
4. Confirm the `access.bootstrap.completed` event exists in `platform.audit_events`.
5. Create and publish institution-approved role versions through the protected API.
6. Assign at least two separately accountable security administrators.
7. Revoke the bootstrap assignment through the API and verify active sessions are terminated when session revocation is implemented.

The bootstrap command takes a PostgreSQL advisory lock and refuses to create privileges if access data already exists. It is not a general-purpose administrator creation tool.

## Role lifecycle

- Roles begin in `DRAFT` and cannot be assigned.
- Publishing retires the previous active version and activates the selected draft.
- Existing assignments remain bound to the exact historical role version. A retired version cannot receive new assignments, but existing effective assignments remain valid until reviewed, expired, or revoked.
- Permission changes therefore require an access review and deliberate reassignment; publishing a new version never silently changes an existing user's privileges.

## Scope behavior

- `institution:*` grants institution-wide scope.
- Organization assignments cover the selected active unit and its active descendants.
- Other scope types match their explicit identifier until a domain defines a reviewed hierarchy policy.
- A capability and an applicable scope are both required for resource access.

## Delegation

- Delegation requires step-up authentication, the delegation-management capability, the delegated capability, and access to the delegated scope.
- A delegation is bound to a direct source assignment and cannot outlive that assignment.
- Revoking or expiring the source assignment immediately removes the delegated capability at the next request.
- Delegations are effective-dated, reason-bound, audited, and represented as confidential outbox events.

## Access reviews

1. Select a narrowly defined scope and accountable reviewer.
2. Create the review; the service snapshots active assignments and their optimistic versions.
3. The assigned reviewer records `RETAIN` or `REVOKE` with a reason for every item.
4. If an assignment changed after the snapshot, the decision fails and must be reconciled rather than overwriting newer state.
5. A revoke decision updates the assignment and review item in the same transaction.
6. The review closes automatically only when every item has a decision.

## Evidence and monitoring

Monitor `AccessAssigned`, `AccessRevoked`, `AccessDelegated`, `AccessReviewCreated`, and `AccessRevokedByReview` outbox events. Alert on repeated privilege changes, self-directed assignments, override use, overdue reviews, and bootstrap execution. Audit tables reject update and delete operations at the database layer.

## Verification

Use an isolated database whose name ends in `_test`:

```bash
npm run build --workspace @niet/api
DATABASE_URL='postgresql://.../niet_erp_test' npm run db:migrate
DATABASE_URL='postgresql://.../niet_erp_test' npm run db:verify
DATABASE_URL='postgresql://.../niet_erp_test' npm run access:verify
DATABASE_URL='postgresql://.../niet_erp_test' npm run workflow:verify
```

The verification scripts intentionally refuse to modify a database without the `_test` suffix.


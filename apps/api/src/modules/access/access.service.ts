import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type {
  AssignRoleDto,
  CreateDelegationDto,
  CreateOrganizationUnitDto,
  CreateRoleDto,
  RevokeAssignmentDto,
  CreateAccessReviewDto,
  DecideAccessReviewItemDto,
} from './access.dto';

@Injectable()
export class AccessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
  ) {}

  async createOrganizationUnit(input: CreateOrganizationUnitDto, actor: Principal): Promise<{ id: string }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      if (input.parentId !== undefined) {
        const parent = await manager.query<readonly { id: string }[]>(
          "SELECT id FROM organization.units WHERE id = $1 AND status = 'ACTIVE'",
          [input.parentId],
        );
        if (parent.length !== 1) throw new NotFoundException('Active parent organization unit not found');
      }
      await manager.query(
        `INSERT INTO organization.units
          (id, unit_key, unit_type, name, parent_id, status, effective_from, created_by)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)`,
        [id, input.unitKey, input.unitType, input.name, input.parentId ?? null,
          input.effectiveFrom, actor.subjectId],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'organization.unit.created',
        resourceType: 'organization-unit',
        resourceId: id,
        details: { unitKey: input.unitKey, unitType: input.unitType, parentId: input.parentId },
      });
      await this.evidence.outbox(manager, {
        eventType: 'OrganizationUnitCreated',
        aggregateType: 'organization-unit',
        aggregateId: id,
        payload: { unitId: id, unitKey: input.unitKey },
      });
    });
    return { id };
  }

  async createRole(input: CreateRoleDto, actor: Principal): Promise<{ id: string }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO access.roles
          (id, role_key, title, description, status, version, created_by)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6)`,
        [id, input.roleKey, input.title, input.description, input.version, actor.subjectId],
      );
      for (const permission of input.permissions) {
        await manager.query(
          'INSERT INTO access.role_permissions (role_id, permission) VALUES ($1, $2)',
          [id, permission],
        );
      }
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.role.created',
        resourceType: 'access-role',
        resourceId: id,
        details: { roleKey: input.roleKey, version: input.version, permissions: input.permissions },
      });
    });
    return { id };
  }

  async publishRole(id: string, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const drafts = await manager.query<readonly { role_key: string }[]>(
        "SELECT role_key FROM access.roles WHERE id = $1 AND status = 'DRAFT' FOR UPDATE",
        [id],
      );
      const draft = drafts[0];
      if (draft === undefined) throw new ConflictException('Only a draft role can be published');
      await manager.query(
        "UPDATE access.roles SET status = 'RETIRED' WHERE role_key = $1 AND status = 'ACTIVE'",
        [draft.role_key],
      );
      await manager.query("UPDATE access.roles SET status = 'ACTIVE' WHERE id = $1", [id]);
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.role.published',
        resourceType: 'access-role',
        resourceId: id,
        details: { roleKey: draft.role_key },
      });
      await this.evidence.outbox(manager, {
        eventType: 'AccessRolePublished', aggregateType: 'access-role', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { roleId: id, roleKey: draft.role_key },
      });
    });
  }

  async assignRole(input: AssignRoleDto, actor: Principal): Promise<{ id: string }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      const roles = await manager.query<readonly { role_key: string; version: number }[]>(
        "SELECT role_key, version FROM access.roles WHERE id = $1 AND status = 'ACTIVE'",
        [input.roleId],
      );
      if (roles.length !== 1) throw new NotFoundException('Active role not found');
      if (input.scopeType === 'organization') {
        const scopes = await manager.query<readonly { id: string }[]>(
          "SELECT id FROM organization.units WHERE id::text = $1 AND status = 'ACTIVE'",
          [input.scopeId],
        );
        if (scopes.length !== 1) throw new NotFoundException('Active organization scope not found');
      }
      await manager.query(
        `INSERT INTO access.subject_role_assignments
          (id, subject_id, role_id, scope_type, scope_id, effective_from, effective_until,
           granted_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, input.subjectId, input.roleId, input.scopeType, input.scopeId, input.effectiveFrom,
          input.effectiveUntil ?? null, actor.subjectId, input.reason],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.assignment.created',
        resourceType: 'access-assignment',
        resourceId: id,
        details: { subjectId: input.subjectId, roleId: input.roleId,
          roleKey: roles[0]?.role_key, roleVersion: roles[0]?.version,
          scopeType: input.scopeType, scopeId: input.scopeId, reason: input.reason },
      });
      await this.evidence.outbox(manager, {
        eventType: 'AccessAssigned', aggregateType: 'access-assignment', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { assignmentId: id, subjectId: input.subjectId },
      });
    });
    return { id };
  }

  async revokeAssignment(id: string, input: RevokeAssignmentDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.query<readonly { subject_id: string }[]>(
        `WITH revoked AS (
           UPDATE access.subject_role_assignments
           SET revoked_at = clock_timestamp(), revoked_by = $2, version = version + 1,
               reason = reason || E'\nRevocation: ' || $3
           WHERE id = $1 AND revoked_at IS NULL AND version = $4
           RETURNING subject_id
         ) SELECT subject_id FROM revoked`,
        [id, actor.subjectId, input.reason, input.expectedVersion],
      );
      if (result.length !== 1) {
        throw new ConflictException('Assignment is missing, revoked, or changed by another actor');
      }
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.assignment.revoked',
        resourceType: 'access-assignment',
        resourceId: id,
        details: { subjectId: result[0]?.subject_id, reason: input.reason },
      });
      await this.evidence.outbox(manager, {
        eventType: 'AccessRevoked', aggregateType: 'access-assignment', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { assignmentId: id, subjectId: result[0]?.subject_id },
      });
    });
  }

  async createDelegation(input: CreateDelegationDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertAllowed(actor, { permission: input.permission });
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const start = new Date(input.effectiveFrom);
    const end = new Date(input.effectiveUntil);
    if (end <= start) throw new ConflictException('Delegation end must be after its start');

    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      const sourceAssignments = await manager.query<readonly {
        id: string;
        effective_until: Date | null;
      }[]>(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id FROM organization.units
           WHERE $2 = 'organization' AND id::text = $3
           UNION ALL
           SELECT parent.id, parent.parent_id
           FROM organization.units parent
           JOIN ancestors child ON child.parent_id = parent.id
         )
         SELECT a.id, a.effective_until
         FROM access.subject_role_assignments a
         JOIN access.roles r ON r.id = a.role_id AND r.status IN ('ACTIVE', 'RETIRED')
         JOIN access.role_permissions rp ON rp.role_id = r.id AND rp.permission = $4
         WHERE a.subject_id = $1 AND a.revoked_at IS NULL
           AND a.effective_from <= clock_timestamp()
           AND (a.effective_until IS NULL OR a.effective_until > clock_timestamp())
           AND (
             (a.scope_type = 'institution' AND a.scope_id = '*')
             OR (a.scope_type = $2 AND a.scope_id = $3)
             OR ($2 = 'organization' AND a.scope_type = 'organization'
                 AND a.scope_id IN (SELECT id::text FROM ancestors))
           )
         ORDER BY a.effective_until DESC NULLS FIRST
         LIMIT 1
         FOR SHARE OF a`,
        [actor.subjectId, input.scopeType, input.scopeId, input.permission],
      );
      const source = sourceAssignments[0];
      if (source === undefined) {
        throw new ForbiddenException('Delegation requires a current direct source assignment');
      }
      if (source.effective_until !== null && end > source.effective_until) {
        throw new ConflictException('Delegation cannot outlive its source assignment');
      }
      await manager.query(
        `INSERT INTO access.delegations
          (id, delegator_subject_id, delegate_subject_id, permission, scope_type, scope_id,
           effective_from, effective_until, reason, status, created_by, source_assignment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $2, $10)`,
        [id, actor.subjectId, input.delegateSubjectId, input.permission, input.scopeType,
          input.scopeId, input.effectiveFrom, input.effectiveUntil, input.reason, source.id],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.delegation.created',
        resourceType: 'access-delegation',
        resourceId: id,
        details: { delegateSubjectId: input.delegateSubjectId, permission: input.permission,
          scopeType: input.scopeType, scopeId: input.scopeId, reason: input.reason },
      });
      await this.evidence.outbox(manager, {
        eventType: 'AccessDelegated', aggregateType: 'access-delegation', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { delegationId: id,
          delegateSubjectId: input.delegateSubjectId },
      });
    });
    return { id };
  }

  async createAccessReview(input: CreateAccessReviewDto, actor: Principal): Promise<{ id: string; itemCount: number }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Date(input.dueAt) <= new Date()) {
      throw new ConflictException('Access review due date must be in the future');
    }
    const id = randomUUID();
    const itemCount = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO access.reviews
          (id, title, scope_type, scope_id, reviewer_subject_id, due_at, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7)`,
        [id, input.title, input.scopeType, input.scopeId, input.reviewerSubjectId,
          input.dueAt, actor.subjectId],
      );
      const assignments = await manager.query<readonly { id: string; version: number }[]>(
        `SELECT id, version FROM access.subject_role_assignments
         WHERE scope_type = $1 AND scope_id = $2 AND revoked_at IS NULL
           AND effective_from <= clock_timestamp()
           AND (effective_until IS NULL OR effective_until > clock_timestamp())
         FOR SHARE`,
        [input.scopeType, input.scopeId],
      );
      for (const assignment of assignments) {
        await manager.query(
          `INSERT INTO access.review_items
            (id, review_id, assignment_id, assignment_version_at_review)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), id, assignment.id, assignment.version],
        );
      }
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'access.review.created',
        resourceType: 'access-review',
        resourceId: id,
        details: { scopeType: input.scopeType, scopeId: input.scopeId,
          reviewerSubjectId: input.reviewerSubjectId, dueAt: input.dueAt,
          itemCount: assignments.length },
      });
      await this.evidence.outbox(manager, {
        eventType: 'AccessReviewCreated', aggregateType: 'access-review', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { reviewId: id,
          reviewerSubjectId: input.reviewerSubjectId, itemCount: assignments.length },
      });
      return assignments.length;
    });
    return { id, itemCount };
  }

  async decideAccessReviewItem(
    reviewId: string,
    itemId: string,
    input: DecideAccessReviewItemDto,
    actor: Principal,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const items = await manager.query<readonly {
        assignment_id: string;
        reviewer_subject_id: string;
        review_status: string;
        decision: string | null;
      }[]>(
        `SELECT i.assignment_id, r.reviewer_subject_id, r.status AS review_status, i.decision
         FROM access.review_items i
         JOIN access.reviews r ON r.id = i.review_id
         WHERE r.id = $1 AND i.id = $2
         FOR UPDATE OF i, r`,
        [reviewId, itemId],
      );
      const item = items[0];
      if (item === undefined) throw new NotFoundException('Access review item not found');
      if (item.review_status !== 'OPEN' || item.decision !== null) {
        throw new ConflictException('Access review item is already closed');
      }
      if (
        item.reviewer_subject_id !== actor.subjectId
        && !actor.permissions.has('platform.access.review.override')
      ) {
        throw new ForbiddenException('Only the assigned reviewer may decide this item');
      }

      if (input.decision === 'REVOKE') {
        const revoked = await manager.query<readonly { subject_id: string }[]>(
          `WITH revoked AS (
             UPDATE access.subject_role_assignments
             SET revoked_at = clock_timestamp(), revoked_by = $2, version = version + 1,
                 reason = reason || E'\nAccess review revocation: ' || $3
             WHERE id = $1 AND revoked_at IS NULL AND version = $4
             RETURNING subject_id
           ) SELECT subject_id FROM revoked`,
          [item.assignment_id, actor.subjectId, input.reason, input.expectedAssignmentVersion],
        );
        if (revoked.length !== 1) {
          throw new ConflictException('Assignment changed after the review snapshot');
        }
      } else {
        const current = await manager.query<readonly { id: string }[]>(
          `SELECT id FROM access.subject_role_assignments
           WHERE id = $1 AND revoked_at IS NULL AND version = $2`,
          [item.assignment_id, input.expectedAssignmentVersion],
        );
        if (current.length !== 1) {
          throw new ConflictException('Assignment changed after the review snapshot');
        }
      }

      await manager.query(
        `UPDATE access.review_items
         SET decision = $2, reason = $3, decided_at = clock_timestamp(), decided_by = $4
         WHERE id = $1`,
        [itemId, input.decision, input.reason, actor.subjectId],
      );
      const remaining = await manager.query<readonly { count: string }[]>(
        'SELECT count(*)::text AS count FROM access.review_items WHERE review_id = $1 AND decision IS NULL',
        [reviewId],
      );
      if (remaining[0]?.count === '0') {
        await manager.query(
          "UPDATE access.reviews SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE id = $1",
          [reviewId],
        );
      }
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: `access.review-item.${input.decision.toLowerCase()}`,
        resourceType: 'access-review-item',
        resourceId: itemId,
        details: { reviewId, assignmentId: item.assignment_id, reason: input.reason },
      });
      if (input.decision === 'REVOKE') {
        await this.evidence.outbox(manager, {
          eventType: 'AccessRevokedByReview', aggregateType: 'access-assignment',
          aggregateId: item.assignment_id, classification: 'CONFIDENTIAL',
          payload: { assignmentId: item.assignment_id, reviewId, itemId },
        });
      }
    });
  }
}

import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type {
  CreateWorkflowDefinitionDto,
  DecideWorkflowTaskDto,
  SubmitWorkflowRequestDto,
} from './workflow.dto';
import type {
  WorkflowDefinitionRecord,
  WorkflowDefinitionListItem,
  WorkflowRequestListItem,
  WorkflowTaskListItem,
  WorkflowTaskRecord,
} from './workflow.types';

@Injectable()
export class WorkflowService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
  ) {}

  async createDefinition(input: CreateWorkflowDefinitionDto, actor: Principal): Promise<{ id: string }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO workflow.definitions
          (id, definition_key, version, title, description, status, submit_permission,
           approval_permission, prohibit_requester_approval, created_by)
         VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $9)`,
        [id, input.definitionKey, input.version, input.title, input.description,
          input.submitPermission, input.approvalPermission, input.prohibitRequesterApproval,
          actor.subjectId],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'workflow.definition.created',
        resourceType: 'workflow-definition',
        resourceId: id,
        details: { definitionKey: input.definitionKey, version: input.version },
      });
    });
    return { id };
  }

  async publishDefinition(id: string, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.query<readonly { readonly definition_key: string }[]>(
        `WITH published AS (
           UPDATE workflow.definitions
           SET status = 'PUBLISHED', published_by = $2, published_at = clock_timestamp()
           WHERE id = $1 AND status = 'DRAFT'
           RETURNING definition_key
         ) SELECT definition_key FROM published`,
        [id, actor.subjectId],
      );
      if (result.length !== 1) {
        throw new ConflictException('Only an existing draft definition can be published');
      }
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'workflow.definition.published',
        resourceType: 'workflow-definition',
        resourceId: id,
        details: { definitionKey: result[0]?.definition_key },
      });
      await this.evidence.outbox(manager, {
        eventType: 'WorkflowDefinitionPublished',
        aggregateType: 'workflow-definition',
        aggregateId: id,
        payload: { definitionId: id, definitionKey: result[0]?.definition_key },
      });
    });
  }

  async submit(input: SubmitWorkflowRequestDto, actor: Principal): Promise<{ id: string; taskId: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      const definitions = await manager.query<readonly WorkflowDefinitionRecord[]>(
        `SELECT id, definition_key, version, status, submit_permission, approval_permission,
                prohibit_requester_approval
         FROM workflow.definitions
         WHERE definition_key = $1 AND status = 'PUBLISHED'
           AND (effective_from IS NULL OR effective_from <= clock_timestamp())
           AND (effective_until IS NULL OR effective_until > clock_timestamp())`,
        [input.definitionKey],
      );
      const definition = definitions[0];
      if (definition === undefined) {
        throw new NotFoundException('No effective published workflow definition exists');
      }
      this.policy.assertAllowed(actor, { permission: definition.submit_permission });

      const id = randomUUID();
      const taskId = randomUUID();
      await manager.query(
        `INSERT INTO workflow.instances
          (id, definition_id, requester_subject_id, title, request_data, status, scope_type, scope_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6, $7)`,
        [id, definition.id, actor.subjectId, input.title, JSON.stringify(input.requestData),
          input.scopeType, input.scopeId],
      );
      await manager.query(
        `INSERT INTO workflow.tasks (id, instance_id, required_permission, status)
         VALUES ($1, $2, $3, 'OPEN')`,
        [taskId, id, definition.approval_permission],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: 'workflow.request.submitted',
        resourceType: 'workflow-instance',
        resourceId: id,
        details: { definitionKey: definition.definition_key,
          definitionVersion: definition.version, taskId, scopeType: input.scopeType,
          scopeId: input.scopeId },
      });
      await this.evidence.outbox(manager, {
        eventType: 'WorkflowRequestSubmitted',
        aggregateType: 'workflow-instance',
        aggregateId: id,
        payload: { instanceId: id, taskId, requiredPermission: definition.approval_permission },
      });
      return { id, taskId };
    });
  }

  async decide(taskId: string, input: DecideWorkflowTaskDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const tasks = await manager.query<readonly WorkflowTaskRecord[]>(
        `SELECT t.id, t.instance_id, t.required_permission, t.status AS task_status,
                i.requester_subject_id, i.version AS instance_version,
                d.prohibit_requester_approval, i.scope_type, i.scope_id
         FROM workflow.tasks t
         JOIN workflow.instances i ON i.id = t.instance_id
         JOIN workflow.definitions d ON d.id = i.definition_id
         WHERE t.id = $1
         FOR UPDATE OF t, i`,
        [taskId],
      );
      const task = tasks[0];
      if (task === undefined) throw new NotFoundException('Workflow task was not found');
      if (task.task_status !== 'OPEN') throw new ConflictException('Workflow task is already closed');
      this.policy.assertAllowed(actor, { permission: task.required_permission, stepUpLevel: 2 });
      this.policy.assertScope(actor, task.scope_type, task.scope_id);
      if (task.prohibit_requester_approval && task.requester_subject_id === actor.subjectId) {
        throw new ForbiddenException('Requester cannot approve this workflow');
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== task.instance_version) {
        throw new ConflictException('Workflow instance was changed by another actor');
      }

      await manager.query(
        `UPDATE workflow.tasks
         SET status = $2, completed_at = clock_timestamp(), completed_by = $3,
             decision_reason = $4, version = version + 1
         WHERE id = $1`,
        [taskId, input.decision, actor.subjectId, input.reason],
      );
      await manager.query(
        `UPDATE workflow.instances
         SET status = $2, decided_at = clock_timestamp(), decided_by = $3,
             decision_reason = $4, version = version + 1
         WHERE id = $1`,
        [task.instance_id, input.decision, actor.subjectId, input.reason],
      );
      await this.evidence.audit(manager, {
        actorSubjectId: actor.subjectId,
        action: `workflow.request.${input.decision.toLowerCase()}`,
        resourceType: 'workflow-instance',
        resourceId: task.instance_id,
        details: { taskId, reason: input.reason },
      });
      await this.evidence.outbox(manager, {
        eventType: `WorkflowRequest${titleCase(input.decision)}`,
        aggregateType: 'workflow-instance',
        aggregateId: task.instance_id,
        payload: { instanceId: task.instance_id, taskId },
      });
    });
  }

  async listTasks(actor: Principal, limit: number): Promise<{ items: WorkflowTaskListItem[] }> {
    const rows = await this.dataSource.query<readonly {
      id: string; instance_id: string; title: string; requester_subject_id: string;
      required_permission: string; scope_type: string; scope_id: string;
      created_at: Date; instance_version: number;
    }[]>(
      `SELECT t.id, t.instance_id, i.title, i.requester_subject_id, t.required_permission,
              i.scope_type, i.scope_id, t.created_at, i.version AS instance_version
       FROM workflow.tasks t
       JOIN workflow.instances i ON i.id = t.instance_id
       WHERE t.status = 'OPEN' AND t.required_permission = ANY($1::text[])
         AND (
           EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE($2::jsonb -> 'institution', '[]')) v
                   WHERE v = '*')
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE($2::jsonb -> i.scope_type, '[]')) v
                      WHERE v = '*' OR v = i.scope_id)
         )
       ORDER BY t.created_at ASC LIMIT $3`,
      [[...actor.permissions], JSON.stringify(actor.scopes), limit],
    );
    return { items: rows.map((row) => ({ id: row.id, instanceId: row.instance_id,
      title: row.title, requesterSubjectId: row.requester_subject_id,
      requiredPermission: row.required_permission, scopeType: row.scope_type,
      scopeId: row.scope_id, createdAt: row.created_at.toISOString(),
      instanceVersion: row.instance_version })) };
  }

  async listMyRequests(actor: Principal, limit: number): Promise<{ items: WorkflowRequestListItem[] }> {
    const rows = await this.dataSource.query<readonly {
      id: string; definition_key: string; title: string; status: WorkflowRequestListItem['status'];
      scope_type: string; scope_id: string; submitted_at: Date; decided_at: Date | null;
      decision_reason: string | null; version: number;
    }[]>(
      `SELECT i.id, d.definition_key, i.title, i.status, i.scope_type, i.scope_id,
              i.submitted_at, i.decided_at, i.decision_reason, i.version
       FROM workflow.instances i JOIN workflow.definitions d ON d.id = i.definition_id
       WHERE i.requester_subject_id = $1 ORDER BY i.submitted_at DESC LIMIT $2`,
      [actor.subjectId, limit],
    );
    return { items: rows.map((row) => ({ id: row.id, definitionKey: row.definition_key,
      title: row.title, status: row.status, scopeType: row.scope_type, scopeId: row.scope_id,
      submittedAt: row.submitted_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null,
      decisionReason: row.decision_reason, version: row.version })) };
  }

  async listAvailableDefinitions(actor: Principal): Promise<{ items: WorkflowDefinitionListItem[] }> {
    const rows = await this.dataSource.query<readonly {
      definition_key: string; version: number; title: string; description: string;
    }[]>(
      `SELECT definition_key, version, title, description FROM workflow.definitions
       WHERE status = 'PUBLISHED' AND submit_permission = ANY($1::text[])
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_until IS NULL OR effective_until > clock_timestamp())
       ORDER BY title`, [[...actor.permissions]]);
    return { items: rows.map((row) => ({ key: row.definition_key, version: row.version,
      title: row.title, description: row.description })) };
  }
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

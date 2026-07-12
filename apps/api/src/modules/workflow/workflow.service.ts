import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { RequestContextService } from '../../platform/request-context/request-context.service';
import type {
  CreateWorkflowDefinitionDto,
  DecideWorkflowTaskDto,
  SubmitWorkflowRequestDto,
} from './workflow.dto';
import type { WorkflowDefinitionRecord, WorkflowTaskRecord } from './workflow.types';

@Injectable()
export class WorkflowService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly requestContext: RequestContextService,
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
      await this.recordAudit(manager, actor, 'workflow.definition.created', 'workflow-definition', id, {
        definitionKey: input.definitionKey,
        version: input.version,
      });
    });
    return { id };
  }

  async publishDefinition(id: string, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.query<readonly { readonly definition_key: string }[]>(
        `UPDATE workflow.definitions
         SET status = 'PUBLISHED', published_by = $2, published_at = clock_timestamp()
         WHERE id = $1 AND status = 'DRAFT'
         RETURNING definition_key`,
        [id, actor.subjectId],
      );
      if (result.length !== 1) {
        throw new ConflictException('Only an existing draft definition can be published');
      }
      await this.recordAudit(manager, actor, 'workflow.definition.published', 'workflow-definition', id, {
        definitionKey: result[0]?.definition_key,
      });
      await this.recordOutbox(manager, 'WorkflowDefinitionPublished', 'workflow-definition', id, {
        definitionId: id,
        definitionKey: result[0]?.definition_key,
      });
    });
  }

  async submit(input: SubmitWorkflowRequestDto, actor: Principal): Promise<{ id: string; taskId: string }> {
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
          (id, definition_id, requester_subject_id, title, request_data, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING')`,
        [id, definition.id, actor.subjectId, input.title, JSON.stringify(input.requestData)],
      );
      await manager.query(
        `INSERT INTO workflow.tasks (id, instance_id, required_permission, status)
         VALUES ($1, $2, $3, 'OPEN')`,
        [taskId, id, definition.approval_permission],
      );
      await this.recordAudit(manager, actor, 'workflow.request.submitted', 'workflow-instance', id, {
        definitionKey: definition.definition_key,
        definitionVersion: definition.version,
        taskId,
      });
      await this.recordOutbox(manager, 'WorkflowRequestSubmitted', 'workflow-instance', id, {
        instanceId: id,
        taskId,
        requiredPermission: definition.approval_permission,
      });
      return { id, taskId };
    });
  }

  async decide(taskId: string, input: DecideWorkflowTaskDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const tasks = await manager.query<readonly WorkflowTaskRecord[]>(
        `SELECT t.id, t.instance_id, t.required_permission, t.status AS task_status,
                i.requester_subject_id, i.version AS instance_version,
                d.prohibit_requester_approval
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
      await this.recordAudit(manager, actor, `workflow.request.${input.decision.toLowerCase()}`,
        'workflow-instance', task.instance_id, { taskId, reason: input.reason });
      await this.recordOutbox(manager, `WorkflowRequest${titleCase(input.decision)}`,
        'workflow-instance', task.instance_id, { instanceId: task.instance_id, taskId });
    });
  }

  private async recordAudit(
    manager: EntityManager,
    actor: Principal,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO platform.audit_events
        (id, actor_subject_id, action, resource_type, resource_id, outcome, correlation_id, details)
       VALUES ($1, $2, $3, $4, $5, 'SUCCEEDED', $6, $7::jsonb)`,
      [randomUUID(), actor.subjectId, action, resourceType, resourceId,
        this.requestContext.getCorrelationId() ?? 'internal', JSON.stringify(details)],
    );
  }

  private async recordOutbox(
    manager: EntityManager,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO platform.outbox_events
        (id, event_type, event_version, aggregate_type, aggregate_id, correlation_id,
         classification, payload)
       VALUES ($1, $2, 1, $3, $4, $5, 'INTERNAL', $6::jsonb)`,
      [randomUUID(), eventType, aggregateType, aggregateId,
        this.requestContext.getCorrelationId() ?? 'internal', JSON.stringify(payload)],
    );
  }
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type {
  CreateNotificationDto,
  CreateNotificationTemplateDto,
  ListNotificationsQueryDto,
  UpdateNotificationPreferencesDto,
} from './notifications.dto';
import type { NotificationListItem, NotificationTemplateRecord } from './notifications.types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
  ) {}

  async createTemplate(input: CreateNotificationTemplateDto, actor: Principal): Promise<{ id: string }> {
    validateTemplateVariables(input.titleTemplate, input.bodyTemplate, input.requiredVariables);
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO notifications.templates
          (id, template_key, version, title_template, body_template, required_variables,
           allow_external_push, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8)`,
        [id, input.templateKey, input.version, input.titleTemplate, input.bodyTemplate,
          input.requiredVariables, input.allowExternalPush, actor.subjectId],
      );
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'notification.template.created', resourceType: 'notification-template',
        resourceId: id, details: { templateKey: input.templateKey, version: input.version,
          allowExternalPush: input.allowExternalPush } });
    });
    return { id };
  }

  async publishTemplate(id: string, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const drafts = await manager.query<readonly { template_key: string }[]>(
        "SELECT template_key FROM notifications.templates WHERE id = $1 AND status = 'DRAFT' FOR UPDATE", [id]);
      if (drafts[0] === undefined) throw new ConflictException('Only a draft template can be published');
      await manager.query(
        "UPDATE notifications.templates SET status = 'RETIRED' WHERE template_key = $1 AND status = 'ACTIVE'",
        [drafts[0].template_key]);
      await manager.query(
        `UPDATE notifications.templates SET status = 'ACTIVE', published_by = $2,
         published_at = clock_timestamp() WHERE id = $1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'notification.template.published', resourceType: 'notification-template',
        resourceId: id, details: { templateKey: drafts[0].template_key } });
    });
  }

  async create(input: CreateNotificationDto, actor: Principal): Promise<{ id: string; pushEventId: string | null }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const templates = await this.dataSource.query<readonly NotificationTemplateRecord[]>(
      `SELECT id, template_key, version, title_template, body_template, required_variables,
              allow_external_push
       FROM notifications.templates WHERE template_key = $1 AND status = 'ACTIVE'`, [input.templateKey]);
    const template = templates[0];
    if (template === undefined) throw new NotFoundException('Active notification template not found');
    const variables = validateVariables(input.variables, template.required_variables);
    const title = renderTextTemplate(template.title_template, variables);
    const body = renderTextTemplate(template.body_template, variables);
    const id = randomUUID();
    const preference = await this.dataSource.query<readonly { external_push_enabled: boolean }[]>(
      'SELECT external_push_enabled FROM notifications.preferences WHERE subject_id = $1',
      [input.recipientSubjectId]);
    const shouldPush = template.allow_external_push && preference[0]?.external_push_enabled === true;
    const pushEventId = shouldPush ? randomUUID() : null;

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO notifications.entries
          (id, template_id, recipient_subject_id, scope_type, scope_id, title, body,
           classification, action_path, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           CASE WHEN $10::integer IS NULL THEN NULL
                ELSE clock_timestamp() + ($10::text || ' days')::interval END)`,
        [id, template.id, input.recipientSubjectId, input.scopeType, input.scopeId, title, body,
          input.classification, input.actionPath ?? null, input.expiresInDays ?? null],
      );
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'notification.created', resourceType: 'notification', resourceId: id,
        details: { recipientSubjectId: input.recipientSubjectId, templateKey: template.template_key,
          templateVersion: template.version, classification: input.classification,
          externalPushRequested: shouldPush } });
      await this.evidence.outbox(manager, { eventType: 'NotificationCreated',
        aggregateType: 'notification', aggregateId: id, classification: input.classification,
        payload: { notificationId: id, recipientSubjectId: input.recipientSubjectId } });
      if (pushEventId !== null) {
        await manager.query(
          `INSERT INTO notifications.push_events
            (id, notification_id, recipient_subject_id, status)
           VALUES ($1, $2, $3, 'PENDING')`, [pushEventId, id, input.recipientSubjectId]);
        await this.evidence.outbox(manager, { eventType: 'OpaquePushRequested',
          aggregateType: 'push-event', aggregateId: pushEventId, classification: 'INTERNAL',
          payload: { eventId: pushEventId } });
      }
    });
    return { id, pushEventId };
  }

  async list(actor: Principal, query: ListNotificationsQueryDto): Promise<{ items: NotificationListItem[] }> {
    const before = decodeCursor(query.before);
    const rows = await this.dataSource.query<readonly {
      id: string; title: string; body: string; classification: NotificationListItem['classification'];
      action_path: string | null; created_at: Date; read_at: Date | null; expires_at: Date | null;
    }[]>(
      `SELECT id, title, body, classification, action_path, created_at, read_at, expires_at
       FROM notifications.entries
       WHERE recipient_subject_id = $1 AND archived_at IS NULL
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $3`, [actor.subjectId, before, query.limit]);
    return { items: rows.map((row) => ({ id: row.id, title: row.title, body: row.body,
      classification: row.classification, actionPath: row.action_path,
      createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null })) };
  }

  async markRead(id: string, actor: Principal): Promise<void> {
    const changed = await this.dataSource.query<readonly { id: string }[]>(
      `WITH updated AS (
         UPDATE notifications.entries SET read_at = COALESCE(read_at, clock_timestamp()),
           version = version + CASE WHEN read_at IS NULL THEN 1 ELSE 0 END
         WHERE id = $1 AND recipient_subject_id = $2 AND archived_at IS NULL RETURNING id
       ) SELECT id FROM updated`, [id, actor.subjectId]);
    if (changed.length !== 1) throw new NotFoundException('Notification not found');
  }

  async updatePreferences(input: UpdateNotificationPreferencesDto, actor: Principal): Promise<{ version: number }> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query<readonly { version: number }[]>(
        `WITH updated AS (
           INSERT INTO notifications.preferences(subject_id, external_push_enabled, version)
           SELECT $1, $2, 1 WHERE $3 = 0
           ON CONFLICT (subject_id) DO UPDATE SET external_push_enabled = EXCLUDED.external_push_enabled,
             updated_at = clock_timestamp(), version = notifications.preferences.version + 1
           WHERE notifications.preferences.version = $3
           RETURNING version
         ) SELECT version FROM updated`, [actor.subjectId, input.externalPushEnabled, input.expectedVersion]);
      if (result[0] === undefined) {
        throw new ConflictException('Notification preferences changed concurrently');
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'notification.preferences.updated', resourceType: 'notification-preferences',
        resourceId: actor.subjectId, details: { externalPushEnabled: input.externalPushEnabled,
          version: result[0].version } });
      return { version: result[0].version };
    });
  }

  async getPreferences(actor: Principal): Promise<{ externalPushEnabled: boolean; version: number }> {
    const rows = await this.dataSource.query<readonly {
      external_push_enabled: boolean; version: number;
    }[]>('SELECT external_push_enabled, version FROM notifications.preferences WHERE subject_id = $1',
      [actor.subjectId]);
    return rows[0] === undefined ? { externalPushEnabled: false, version: 0 }
      : { externalPushEnabled: rows[0].external_push_enabled, version: rows[0].version };
  }
}

export function renderTextTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{([a-z][a-zA-Z0-9]{0,49})\}\}/g,
    (_match: string, variable: string) => variables[variable] ?? '');
}

function validateTemplateVariables(title: string, body: string, required: readonly string[]): void {
  const found = new Set([...title.matchAll(/\{\{([a-z][a-zA-Z0-9]{0,49})\}\}/g),
    ...body.matchAll(/\{\{([a-z][a-zA-Z0-9]{0,49})\}\}/g)].map((match) => match[1]));
  if (found.size !== required.length || required.some((name) => !found.has(name))) {
    throw new ConflictException('Template placeholders must exactly match required variables');
  }
  const stripped = `${title}\n${body}`.replaceAll(/\{\{[a-z][a-zA-Z0-9]{0,49}\}\}/g, '');
  if (stripped.includes('{{') || stripped.includes('}}')) {
    throw new ConflictException('Notification template contains a malformed placeholder');
  }
}

function validateVariables(input: Record<string, unknown>, required: readonly string[]): Record<string, string> {
  const keys = Object.keys(input);
  if (keys.length !== required.length || required.some((name) => !keys.includes(name))) {
    throw new ConflictException('Notification variables do not match the active template');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-z][a-zA-Z0-9]{0,49}$/.test(key) || typeof value !== 'string'
      || value.length === 0 || value.length > 500) {
      throw new ConflictException('Notification variable is invalid');
    }
    result[key] = value;
  }
  return result;
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const date = new Date(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (Number.isNaN(date.valueOf())) throw new ConflictException('Notification cursor is invalid');
  return date.toISOString();
}

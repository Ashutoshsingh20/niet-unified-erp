import { DataSource } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { NotificationsService } from '../apps/api/dist/modules/notifications/notifications.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Notification verification refuses to modify a database without a _test suffix');
  }
  const service = new NotificationsService(dataSource, new PolicyService(),
    new TransactionalEvidenceService(new RequestContextService()));
  const sender = { subjectId: 'notification-sender', assuranceLevel: 2,
    permissions: new Set(['platform.notifications.configure', 'platform.notifications.send']),
    scopes: { institution: ['*'] } };
  const recipient = { subjectId: 'notification-recipient', assuranceLevel: 1,
    permissions: new Set(['platform.notifications.read', 'platform.notifications.preferences']),
    scopes: { institution: ['*'] } };
  const suffix = crypto.randomUUID().slice(0, 8);
  const templateKey = `verification.deadline-${suffix}`;
  const template = await service.createTemplate({ templateKey, version: 1,
    titleTemplate: '{{itemName}} is due',
    bodyTemplate: 'Submit {{itemName}} by {{deadline}}.',
    requiredVariables: ['itemName', 'deadline'], allowExternalPush: true }, sender);
  await service.publishTemplate(template.id, sender);
  const preference = await service.updatePreferences({ externalPushEnabled: true, expectedVersion: 0 }, recipient);
  if (preference.version !== 1) throw new Error('Initial notification preference version is invalid');
  let stalePreferenceRejected = false;
  try {
    await service.updatePreferences({ externalPushEnabled: false, expectedVersion: 0 }, recipient);
  } catch (error) {
    stalePreferenceRejected = error instanceof ConflictException;
  }
  if (!stalePreferenceRejected) throw new Error('Stale notification preference update was accepted');

  const created = await service.create({ templateKey,
    recipientSubjectId: recipient.subjectId, scopeType: 'institution', scopeId: '*',
    variables: { itemName: 'Registration', deadline: '15 July' },
    classification: 'CONFIDENTIAL', actionPath: '/student/tasks/registration', expiresInDays: 7 }, sender);
  if (created.pushEventId === null) throw new Error('Consented opaque push event was not created');
  const pushOutbox = await dataSource.query(
    "SELECT payload FROM platform.outbox_events WHERE event_type = 'OpaquePushRequested' AND aggregate_id = $1",
    [created.pushEventId]);
  const payload = pushOutbox[0]?.payload;
  if (pushOutbox.length !== 1 || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(['eventId'])
    || payload.eventId !== created.pushEventId) {
    throw new Error('External push outbox payload contains more than the opaque event ID');
  }
  const inbox = await service.list(recipient, { limit: 25 });
  if (inbox.items.length !== 1 || inbox.items[0]?.title !== 'Registration is due'
    || inbox.items[0]?.readAt !== null) {
    throw new Error('Recipient inbox did not return the rendered notification');
  }
  await service.markRead(created.id, recipient);
  const readInbox = await service.list(recipient, { limit: 25 });
  if (readInbox.items[0]?.readAt === null) throw new Error('Notification read state was not recorded');
  process.stdout.write('Notification template, preference, inbox, read state, and opaque push verified\n');
} finally {
  await dataSource.destroy();
}


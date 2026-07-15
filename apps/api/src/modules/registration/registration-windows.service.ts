import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateRegistrationWindowDto, PublishRegistrationWindowDto } from './registration-windows.dto';
interface WindowRow { id: string; window_key: string; version: number; period_id: string;
  window_type: 'SUBMISSION' | 'ADD_DROP'; title: string; opens_at: Date; closes_at: Date;
  scope_type: string; scope_id: string; idempotency_key: string; status: 'DRAFT' | 'PUBLISHED';
  record_version: number; policy_decision_reference: string | null; created_by: string;
  published_by: string | null }
export interface RegistrationWindowView { readonly id: string; readonly windowKey: string;
  readonly version: number; readonly periodId: string; readonly windowType: 'SUBMISSION' | 'ADD_DROP';
  readonly title: string; readonly opensAt: string; readonly closesAt: string;
  readonly status: 'DRAFT' | 'PUBLISHED'; readonly recordVersion: number }
@Injectable()
export class RegistrationWindowsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateRegistrationWindowDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Date(input.closesAt) <= new Date(input.opensAt)) {
      throw new ConflictException('Registration window close must be after open');
    }
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-window', input.idempotencyKey])]);
      const existing = await manager.query<readonly WindowRow[]>(
        'SELECT * FROM registration.windows WHERE idempotency_key=$1 FOR UPDATE', [input.idempotencyKey]);
      if (existing[0] !== undefined) return replayCreate(existing[0], input, actor);
      const periods = await manager.query<readonly { scope_type: string; scope_id: string }[]>(
        'SELECT scope_type,scope_id FROM registration.academic_periods WHERE id=$1', [input.periodId]);
      if (periods[0] === undefined) throw new NotFoundException('Academic period not found');
      if (periods[0].scope_type !== input.scopeType || periods[0].scope_id !== input.scopeId) {
        throw new ConflictException('Registration window scope must match its academic period');
      }
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO registration.windows
          (id,window_key,version,period_id,window_type,title,opens_at,closes_at,
           scope_type,scope_id,idempotency_key,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, input.windowKey,
          input.version, input.periodId, input.windowType, input.title, input.opensAt, input.closesAt,
          input.scopeType, input.scopeId, input.idempotencyKey, actor.subjectId]);
      } catch (error) { throwWindowConflict(error, 'Registration window version already exists'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.window.drafted', resourceType: 'registration-window', resourceId: id,
        details: { windowKey: input.windowKey, version: input.version, periodId: input.periodId,
          windowType: input.windowType, opensAt: input.opensAt, closesAt: input.closesAt,
          scopeType: input.scopeType, scopeId: input.scopeId } });
      return { id, replayed: false };
    });
  }
  async publish(id: string, input: PublishRegistrationWindowDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    if (!this.config.get('REGISTRATION_WINDOW_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Registration window publication is disabled pending NIET approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly WindowRow[]>(
        'SELECT * FROM registration.windows WHERE id=$1 FOR UPDATE', [id]);
      const window = rows[0];
      if (window === undefined) throw new NotFoundException('Registration window not found');
      this.policy.assertScope(actor, window.scope_type, window.scope_id);
      if (window.status === 'PUBLISHED') {
        if (window.policy_decision_reference === input.policyDecisionReference
          && window.published_by === actor.subjectId) return { replayed: true };
        throw new ConflictException('Registration window already has different publication evidence');
      }
      if (window.created_by === actor.subjectId) {
        throw new ForbiddenException('Registration window maker cannot publish it');
      }
      if (window.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Registration window is not the expected draft version');
      }
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-window-publication', window.period_id, window.window_type])]);
      try {
        await manager.query(`UPDATE registration.windows SET status='PUBLISHED',
          record_version=record_version+1,policy_decision_reference=$2,published_by=$3,
          published_at=clock_timestamp() WHERE id=$1`, [id, input.policyDecisionReference, actor.subjectId]);
      } catch (error) { throwWindowConflict(error, 'Registration window overlaps a published window'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.window.published', resourceType: 'registration-window', resourceId: id,
        details: { policyDecisionReference: input.policyDecisionReference,
          periodId: window.period_id, windowType: window.window_type } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationWindowPublished',
        aggregateType: 'registration-window', aggregateId: id, classification: 'INTERNAL',
        payload: { registrationWindowId: id, academicPeriodId: window.period_id,
          windowType: window.window_type } });
      return { replayed: false };
    });
  }
  async active(periodId: string, windowType: 'SUBMISSION' | 'ADD_DROP', actor: Principal):
  Promise<{ item: RegistrationWindowView | null }> {
    const periods = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      'SELECT scope_type,scope_id FROM registration.academic_periods WHERE id=$1', [periodId]);
    if (periods[0] === undefined) throw new NotFoundException('Academic period not found');
    this.policy.assertScope(actor, periods[0].scope_type, periods[0].scope_id);
    const rows = await this.dataSource.query<readonly WindowRow[]>(`SELECT * FROM registration.windows
      WHERE period_id=$1 AND window_type=$2 AND status='PUBLISHED'
        AND opens_at<=clock_timestamp() AND closes_at>clock_timestamp()`, [periodId, windowType]);
    const window = rows[0];
    if (window === undefined) return { item: null };
    return { item: toView(window) };
  }
}
function replayCreate(row: WindowRow, input: CreateRegistrationWindowDto,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.window_key !== input.windowKey || row.version !== input.version || row.period_id !== input.periodId
    || row.window_type !== input.windowType || row.title !== input.title
    || row.opens_at.toISOString() !== new Date(input.opensAt).toISOString()
    || row.closes_at.toISOString() !== new Date(input.closesAt).toISOString()
    || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
    || row.created_by !== actor.subjectId) throw new ConflictException('Registration window replay differs');
  return { id: row.id, replayed: true };
}
function toView(row: WindowRow): RegistrationWindowView {
  return { id: row.id, windowKey: row.window_key, version: row.version, periodId: row.period_id,
    windowType: row.window_type, title: row.title, opensAt: row.opens_at.toISOString(),
    closesAt: row.closes_at.toISOString(), status: row.status, recordVersion: row.record_version };
}
function throwWindowConflict(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error
    && ['23505','23P01'].includes(String(error.code))) throw new ConflictException(message);
  throw error;
}

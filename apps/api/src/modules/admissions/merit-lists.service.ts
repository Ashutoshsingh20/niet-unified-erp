import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateMeritListDto, MeritListEntryDto, PublishMeritListDto } from './merit-lists.dto';

interface MeritListRow { id: string; list_key: string; version: number; title: string;
  programme_key: string; cycle_key: string; scope_type: string; scope_id: string;
  idempotency_key: string; evaluation_engine: string; evaluation_version: string;
  policy_reference: string; source_evidence_reference: string; entry_count: number;
  status: 'DRAFT' | 'PUBLISHED'; record_version: number; publication_reference: string | null;
  created_by: string; published_by: string | null }
interface MeritEntryRow { id: string; application_id: string; merit_rank: number;
  allocation_order: number; category_key: string; score_display: string;
  evaluation_trace: Record<string, unknown>; reason: string }
export interface MeritListView { readonly id: string; readonly listKey: string; readonly version: number;
  readonly title: string; readonly programmeKey: string; readonly cycleKey: string;
  readonly status: 'DRAFT' | 'PUBLISHED'; readonly recordVersion: number;
  readonly entries: readonly { id: string; applicationId: string; meritRank: number;
    allocationOrder: number; categoryKey: string; scoreDisplay: string;
    evaluationTrace: Record<string, unknown>; reason: string }[] }

@Injectable()
export class MeritListsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async create(input: CreateMeritListDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['admission-merit-list', input.idempotencyKey])]);
      const existing = await manager.query<readonly MeritListRow[]>(
        'SELECT * FROM admissions.merit_lists WHERE idempotency_key=$1 FOR UPDATE', [input.idempotencyKey]);
      if (existing[0] !== undefined) {
        await this.assertReplay(existing[0], input, actor);
        return { id: existing[0].id, replayed: true };
      }
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO admissions.merit_lists
          (id,list_key,version,title,programme_key,cycle_key,scope_type,scope_id,idempotency_key,
           evaluation_engine,evaluation_version,policy_reference,source_evidence_reference,
           entry_count,entry_manifest_sha256,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,repeat('0',64),$15)`,
        [id, input.listKey, input.version, input.title, input.programmeKey, input.cycleKey,
          input.scopeType, input.scopeId, input.idempotencyKey, input.evaluationEngine,
          input.evaluationVersion, input.policyReference, input.sourceEvidenceReference,
          input.entries.length, actor.subjectId]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Merit list version already exists');
        throw error;
      }
      for (const entry of input.entries) {
        await manager.query(`INSERT INTO admissions.merit_list_entries
          (id,list_id,application_id,merit_rank,allocation_order,category_key,score_display,
           evaluation_trace,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [randomUUID(), id, entry.applicationId, entry.meritRank, entry.allocationOrder,
          entry.categoryKey, entry.scoreDisplay, JSON.stringify(entry.evaluationTrace), entry.reason]);
      }
      await manager.query(`UPDATE admissions.merit_lists SET entry_manifest_sha256=(SELECT encode(digest(
        COALESCE(string_agg(octet_length(application_id::text)::text || ':' || application_id::text
          || octet_length(merit_rank::text)::text || ':' || merit_rank::text
          || octet_length(allocation_order::text)::text || ':' || allocation_order::text
          || octet_length(category_key)::text || ':' || category_key
          || octet_length(score_display)::text || ':' || score_display
          || octet_length(evaluation_trace::text)::text || ':' || evaluation_trace::text
          || octet_length(reason)::text || ':' || reason,'' ORDER BY allocation_order),''),'sha256'),'hex')
        FROM admissions.merit_list_entries WHERE list_id=$1) WHERE id=$1`, [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.merit-list.drafted', resourceType: 'admission-merit-list', resourceId: id,
        details: { listKey: input.listKey, version: input.version, programmeKey: input.programmeKey,
          cycleKey: input.cycleKey, entryCount: input.entries.length, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion, policyReference: input.policyReference,
          sourceEvidenceReference: input.sourceEvidenceReference, scopeType: input.scopeType,
          scopeId: input.scopeId } });
      return { id, replayed: false };
    });
  }

  async publish(id: string, input: PublishMeritListDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    if (!this.config.get('ADMISSION_MERIT_LIST_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Merit list publication is disabled pending NIET approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly MeritListRow[]>(
        'SELECT * FROM admissions.merit_lists WHERE id=$1 FOR UPDATE', [id]);
      const list = rows[0];
      if (list === undefined) throw new NotFoundException('Merit list not found');
      this.policy.assertScope(actor, list.scope_type, list.scope_id);
      if (list.status === 'PUBLISHED') {
        if (list.publication_reference === input.publicationReference
          && list.published_by === actor.subjectId) return { replayed: true };
        throw new ConflictException('Merit list already has different publication evidence');
      }
      if (list.created_by === actor.subjectId) throw new ForbiddenException('Merit list maker cannot publish it');
      if (list.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Merit list is not the expected draft version');
      }
      await manager.query(`UPDATE admissions.merit_lists SET status='PUBLISHED',record_version=record_version+1,
        publication_reference=$2,published_by=$3,published_at=clock_timestamp() WHERE id=$1`,
      [id, input.publicationReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.merit-list.published', resourceType: 'admission-merit-list', resourceId: id,
        details: { listKey: list.list_key, version: list.version,
          publicationReference: input.publicationReference } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionMeritListPublished',
        aggregateType: 'admission-merit-list', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionMeritListId: id, listKey: list.list_key, version: list.version } });
      return { replayed: false };
    });
  }

  async get(id: string, actor: Principal): Promise<MeritListView> {
    const rows = await this.dataSource.query<readonly MeritListRow[]>(
      'SELECT * FROM admissions.merit_lists WHERE id=$1', [id]);
    const list = rows[0];
    if (list === undefined) throw new NotFoundException('Merit list not found');
    this.policy.assertScope(actor, list.scope_type, list.scope_id);
    const entries = await this.dataSource.query<readonly MeritEntryRow[]>(`SELECT id,application_id,
      merit_rank,allocation_order,category_key,score_display,evaluation_trace,reason
      FROM admissions.merit_list_entries WHERE list_id=$1 ORDER BY allocation_order`, [id]);
    return { id: list.id, listKey: list.list_key, version: list.version, title: list.title,
      programmeKey: list.programme_key, cycleKey: list.cycle_key, status: list.status,
      recordVersion: list.record_version, entries: entries.map((entry) => ({ id: entry.id,
        applicationId: entry.application_id, meritRank: entry.merit_rank,
        allocationOrder: entry.allocation_order, categoryKey: entry.category_key,
        scoreDisplay: entry.score_display, evaluationTrace: entry.evaluation_trace, reason: entry.reason })) };
  }

  private async assertReplay(row: MeritListRow, input: CreateMeritListDto, actor: Principal): Promise<void> {
    if (row.list_key !== input.listKey || row.version !== input.version || row.title !== input.title
      || row.programme_key !== input.programmeKey || row.cycle_key !== input.cycleKey
      || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
      || row.evaluation_engine !== input.evaluationEngine || row.evaluation_version !== input.evaluationVersion
      || row.policy_reference !== input.policyReference
      || row.source_evidence_reference !== input.sourceEvidenceReference
      || row.entry_count !== input.entries.length || row.created_by !== actor.subjectId) {
      throw new ConflictException('Merit list replay has different content');
    }
    const entries = await this.dataSource.query<readonly MeritEntryRow[]>(`SELECT application_id,merit_rank,
      allocation_order,category_key,score_display,evaluation_trace,reason
      FROM admissions.merit_list_entries WHERE list_id=$1 ORDER BY allocation_order`, [row.id]);
    const expected = [...input.entries].sort((a, b) => a.allocationOrder - b.allocationOrder);
    if (entries.length !== expected.length || entries.some((entry, index) => !sameEntry(entry, expected[index]!))) {
      throw new ConflictException('Merit list replay has different entries');
    }
  }
}

function sameEntry(row: MeritEntryRow, input: MeritListEntryDto): boolean {
  return row.application_id === input.applicationId && row.merit_rank === input.meritRank
    && row.allocation_order === input.allocationOrder && row.category_key === input.categoryKey
    && row.score_display === input.scoreDisplay
    && canonicalJson(row.evaluation_trace) === canonicalJson(input.evaluationTrace) && row.reason === input.reason;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

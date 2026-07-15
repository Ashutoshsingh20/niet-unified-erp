import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateFeeStructureDto, PublishFeeStructureDto, RaiseGovernedDemandDto } from './fee-structures.dto';

interface StructureRow { id: string; structure_key: string; version: number; title: string;
  currency: string; scope_type: string; scope_id: string; idempotency_key: string;
  line_count: number; line_manifest_sha256: string; status: 'DRAFT' | 'PUBLISHED'; record_version: number;
  policy_decision_reference: string | null; created_by: string; published_by: string | null }
interface LineRow { id: string; line_key: string; amount_minor: string; allocation_order: number }

@Injectable()
export class FeeStructuresService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async create(input: CreateFeeStructureDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    assertUniqueOrders(input);
    const manifest = lineManifest(input);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['finance-fee-structure', input.idempotencyKey])]);
      const existing = await manager.query<readonly StructureRow[]>(
        'SELECT * FROM finance.fee_structures WHERE idempotency_key=$1 FOR UPDATE', [input.idempotencyKey]);
      if (existing[0] !== undefined) return replayCreate(existing[0], input, manifest, actor);
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO finance.fee_structures
          (id,structure_key,version,title,currency,scope_type,scope_id,idempotency_key,
           line_count,line_manifest_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, input.structureKey, input.version, input.title, input.currency, input.scopeType,
          input.scopeId, input.idempotencyKey, input.lines.length, manifest, actor.subjectId]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Fee structure version already exists');
        throw error;
      }
      for (const line of input.lines) {
        await manager.query(`INSERT INTO finance.fee_structure_lines
          (id,structure_id,line_key,fee_head_key,title,installment_key,due_on,amount_minor,allocation_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), id, line.lineKey,
          line.feeHeadKey, line.title, line.installmentKey, line.dueOn,
          line.amountMinor, line.allocationOrder]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.fee-structure.drafted', resourceType: 'finance-fee-structure', resourceId: id,
        details: { structureKey: input.structureKey, version: input.version, currency: input.currency,
          scopeType: input.scopeType, scopeId: input.scopeId, lineManifestSha256: manifest } });
      return { id, replayed: false };
    });
  }

  async publish(id: string, input: PublishFeeStructureDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    this.assertEnabled('FINANCE_FEE_STRUCTURE_PUBLICATION_ENABLED',
      'Fee structure publication is disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly StructureRow[]>(
        'SELECT * FROM finance.fee_structures WHERE id=$1 FOR UPDATE', [id]);
      const structure = rows[0];
      if (structure === undefined) throw new NotFoundException('Fee structure not found');
      this.policy.assertScope(actor, structure.scope_type, structure.scope_id);
      if (structure.status === 'PUBLISHED') {
        if (structure.policy_decision_reference === input.policyDecisionReference
          && structure.published_by === actor.subjectId) return { replayed: true };
        throw new ConflictException('Fee structure already has different publication evidence');
      }
      if (structure.created_by === actor.subjectId) {
        throw new ForbiddenException('Fee structure maker cannot publish the same version');
      }
      if (structure.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Fee structure is not the expected draft version');
      }
      await manager.query(`UPDATE finance.fee_structures SET status='PUBLISHED',record_version=record_version+1,
        policy_decision_reference=$2,published_by=$3,published_at=clock_timestamp() WHERE id=$1`,
      [id, input.policyDecisionReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.fee-structure.published', resourceType: 'finance-fee-structure', resourceId: id,
        details: { structureKey: structure.structure_key, version: structure.version,
          policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'FinanceFeeStructurePublished',
        aggregateType: 'finance-fee-structure', aggregateId: id, classification: 'INTERNAL',
        payload: { financeFeeStructureId: id, structureKey: structure.structure_key,
          version: structure.version } });
      return { replayed: false };
    });
  }

  async raiseDemand(structureId: string, input: RaiseGovernedDemandDto,
    actor: Principal): Promise<{ id: string; amountMinor: string; replayed: boolean }> {
    this.assertEnabled('FINANCE_GOVERNED_DEMAND_ENABLED',
      'Governed fee demands are disabled pending NIET approval');
    this.assertEnabled('FINANCE_POSTING_ENABLED', 'Finance posting is disabled pending NIET policy approval');
    const selectedKeys = [...input.lineKeys].sort();
    const selectedManifest = createHash('sha256').update(JSON.stringify(selectedKeys)).digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const structures = await manager.query<readonly StructureRow[]>(
        'SELECT * FROM finance.fee_structures WHERE id=$1 FOR UPDATE', [structureId]);
      const structure = structures[0];
      if (structure === undefined) throw new NotFoundException('Fee structure not found');
      this.policy.assertScope(actor, structure.scope_type, structure.scope_id);
      const replay = await manager.query<readonly { id: string; account_id: string; structure_id: string;
        amount_minor: string; evidence_reference: string; selected_lines_manifest_sha256: string;
        requested_by: string }[]>(`SELECT p.id,p.account_id,gd.structure_id,p.amount_minor::text,
        p.evidence_reference,gd.selected_lines_manifest_sha256,p.requested_by
        FROM finance.postings p JOIN finance.governed_demands gd ON gd.posting_id=p.id
        WHERE p.idempotency_key=$1`, [input.idempotencyKey]);
      if (replay[0] !== undefined) {
        const row = replay[0];
        if (row.account_id === input.accountId && row.structure_id === structureId
          && row.evidence_reference === input.evidenceReference
          && row.selected_lines_manifest_sha256 === selectedManifest
          && row.requested_by === actor.subjectId) {
          return { id: row.id, amountMinor: row.amount_minor, replayed: true };
        }
        throw new ConflictException('Governed demand idempotency key has different content');
      }
      if (structure.status !== 'PUBLISHED'
        || structure.record_version !== input.expectedStructureRecordVersion) {
        throw new ConflictException('Fee structure is not the expected published version');
      }
      const accounts = await manager.query<readonly { id: string; currency: string;
        scope_type: string; scope_id: string }[]>('SELECT * FROM finance.accounts WHERE id=$1 FOR UPDATE',
      [input.accountId]);
      const account = accounts[0];
      if (account === undefined) throw new NotFoundException('Finance account not found');
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (account.scope_type !== structure.scope_type || account.scope_id !== structure.scope_id
        || account.currency !== structure.currency) {
        throw new ConflictException('Fee structure and finance account are not aligned');
      }
      const lines = await manager.query<readonly LineRow[]>(`SELECT id,line_key,amount_minor::text,allocation_order
        FROM finance.fee_structure_lines WHERE structure_id=$1 AND line_key=ANY($2::text[])
        ORDER BY allocation_order FOR UPDATE`, [structureId, selectedKeys]);
      if (lines.length !== selectedKeys.length) throw new ConflictException('Unknown fee structure line selected');
      const already = await manager.query<readonly { exists: boolean }[]>(`SELECT EXISTS (
        SELECT 1 FROM finance.demand_allocations WHERE account_id=$1
          AND fee_structure_line_id=ANY($2::uuid[])) exists`, [input.accountId, lines.map((line) => line.id)]);
      if (already[0]?.exists === true) throw new ConflictException('Fee structure line was already demanded');
      const amountMinor = lines.reduce((sum, line) => sum + BigInt(line.amount_minor), 0n).toString();
      const postingId = randomUUID();
      await manager.query(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,requested_by)
        VALUES ($1,$2,'DEMAND',$3,$4,$5,$6,$7)`, [postingId, input.accountId, amountMinor,
        structure.currency, input.idempotencyKey, input.evidenceReference, actor.subjectId]);
      for (const [ledgerAccount, direction] of [['RECEIVABLE', 'DEBIT'], ['REVENUE', 'CREDIT']]) {
        await manager.query(`INSERT INTO finance.ledger_entries
          (id,posting_id,ledger_account,direction,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), postingId, ledgerAccount, direction, amountMinor, structure.currency]);
      }
      await manager.query(`INSERT INTO finance.governed_demands
        (posting_id,structure_id,account_id,selected_lines_manifest_sha256,created_by)
        VALUES ($1,$2,$3,$4,$5)`, [postingId, structureId, input.accountId,
        selectedManifest, actor.subjectId]);
      for (const line of lines) {
        await manager.query(`INSERT INTO finance.demand_allocations
          (id,posting_id,account_id,fee_structure_line_id,amount_minor) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), postingId, input.accountId, line.id, line.amount_minor]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.governed-demand.raised', resourceType: 'finance-posting', resourceId: postingId,
        details: { financeFeeStructureId: structureId, accountId: input.accountId,
          amountMinor, selectedLinesManifestSha256: selectedManifest } });
      await this.evidence.outbox(manager, { eventType: 'GovernedFinanceDemandRaised',
        aggregateType: 'finance-posting', aggregateId: postingId, classification: 'CONFIDENTIAL',
        payload: { financePostingId: postingId, financeAccountId: input.accountId,
          financeFeeStructureId: structureId } });
      return { id: postingId, amountMinor, replayed: false };
    });
  }

  private assertEnabled(key: keyof Pick<Environment, 'FINANCE_FEE_STRUCTURE_PUBLICATION_ENABLED'
    | 'FINANCE_GOVERNED_DEMAND_ENABLED' | 'FINANCE_POSTING_ENABLED'>, message: string): void {
    if (!this.config.get(key, { infer: true })) throw new ForbiddenException(message);
  }
}

function assertUniqueOrders(input: CreateFeeStructureDto): void {
  if (new Set(input.lines.map((line) => line.allocationOrder)).size !== input.lines.length) {
    throw new ConflictException('Fee structure allocation order must be unique');
  }
}
function lineManifest(input: CreateFeeStructureDto): string {
  const lines = [...input.lines].sort((left, right) => left.allocationOrder - right.allocationOrder)
    .map((line) => [line.lineKey, line.feeHeadKey, line.title, line.installmentKey,
      line.dueOn, line.amountMinor, String(line.allocationOrder)]
      .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('')).join('');
  return createHash('sha256').update(lines).digest('hex');
}
function replayCreate(row: StructureRow, input: CreateFeeStructureDto, manifest: string,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.structure_key !== input.structureKey || row.version !== input.version || row.title !== input.title
    || row.currency !== input.currency || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
    || row.line_count !== input.lines.length || row.line_manifest_sha256 !== manifest
    || row.created_by !== actor.subjectId) {
    throw new ConflictException('Fee structure idempotency key already has different content');
  }
  return { id: row.id, replayed: true };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

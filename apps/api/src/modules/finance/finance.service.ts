import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateStudentAccountDto, PostFinanceTransactionDto, ReversePostingDto } from './finance.dto';

type PostingType = 'DEMAND' | 'PAYMENT';
interface AccountRow { id: string; student_id: string; currency: string; scope_type: string; scope_id: string }
interface PostingRow { id: string; account_id: string; posting_type: string; amount_minor: string;
  currency: string; requested_by: string; original_posting_id: string | null;
  idempotency_key: string; evidence_reference: string }

@Injectable()
export class FinanceService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async createAccount(input: CreateStudentAccountDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const students = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      'SELECT scope_type,scope_id FROM student.records WHERE id=$1', [input.studentId]);
    if (students[0]?.scope_type !== input.scopeType || students[0]?.scope_id !== input.scopeId) {
      throw new ConflictException('Student and account scope are not aligned');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO finance.student_accounts
          (id,student_id,currency,scope_type,scope_id,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, input.studentId, input.currency, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Student account already exists for this currency'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.account.created', resourceType: 'student-account', resourceId: id,
        details: { studentId: input.studentId, currency: input.currency,
          scopeType: input.scopeType, scopeId: input.scopeId } });
    });
    return { id };
  }

  async post(input: PostFinanceTransactionDto, postingType: PostingType,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertPostingEnabled();
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, input.accountId);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (account.currency !== input.currency) throw new ConflictException('Posting currency must match account currency');
      const id = randomUUID();
      const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, input.accountId, postingType, input.amountMinor, input.currency, input.idempotencyKey,
        input.evidenceReference, actor.subjectId]);
      if (inserted[0] === undefined) return this.resolveReplay(manager, input, postingType);
      const sides = postingType === 'DEMAND'
        ? [['RECEIVABLE', 'DEBIT'], ['REVENUE', 'CREDIT']]
        : [['PAYMENT_CLEARING', 'DEBIT'], ['RECEIVABLE', 'CREDIT']];
      await this.insertEntries(manager, id, sides, input.amountMinor, input.currency);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `finance.${postingType.toLowerCase()}.posted`, resourceType: 'finance-posting', resourceId: id,
        details: { accountId: input.accountId, amountMinor: input.amountMinor, currency: input.currency } });
      await this.evidence.outbox(manager, { eventType: postingType === 'DEMAND' ? 'DemandRaised' : 'PaymentPosted',
        aggregateType: 'finance-posting', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financePostingId: id, studentAccountId: input.accountId } });
      return { id, replayed: false };
    });
  }

  async reverse(originalId: string, input: ReversePostingDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    if (!this.config.get('FINANCE_REVERSAL_ENABLED', { infer: true })) {
      throw new ForbiddenException('Finance reversals are disabled pending NIET policy approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const originals = await manager.query<readonly PostingRow[]>(
        'SELECT * FROM finance.postings WHERE id=$1 FOR UPDATE', [originalId]);
      const original = originals[0];
      if (original === undefined) throw new NotFoundException('Finance posting not found');
      const account = await this.lockAccount(manager, original.account_id);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (original.posting_type === 'REVERSAL') throw new ConflictException('A reversal cannot be reversed');
      if (original.requested_by === actor.subjectId) throw new ForbiddenException('Posting maker cannot approve reversal');
      const existing = await manager.query<readonly PostingRow[]>(
        'SELECT * FROM finance.postings WHERE original_posting_id=$1', [originalId]);
      if (existing[0] !== undefined) {
        if (existing[0].idempotency_key === input.idempotencyKey
          && existing[0].evidence_reference === input.evidenceReference) {
          return { id: existing[0].id, replayed: true };
        }
        throw new ConflictException('Finance posting already has a different reversal');
      }
      const byKey = await manager.query<readonly PostingRow[]>(
        'SELECT * FROM finance.postings WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (byKey[0] !== undefined) throw new ConflictException('Reversal idempotency key has different content');
      const id = randomUUID();
      await manager.query(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,
         original_posting_id,requested_by,approved_by) VALUES ($1,$2,'REVERSAL',$3,$4,$5,$6,$7,$8,$9)`,
      [id, original.account_id, original.amount_minor, original.currency, input.idempotencyKey,
        input.evidenceReference, originalId, original.requested_by, actor.subjectId]);
      const entries = await manager.query<readonly { ledger_account: string; direction: string }[]>(
        'SELECT ledger_account,direction FROM finance.ledger_entries WHERE posting_id=$1 ORDER BY ledger_account',
      [originalId]);
      await this.insertEntries(manager, id, entries.map((row) => [row.ledger_account,
        row.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT']), original.amount_minor, original.currency);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.posting.reversed', resourceType: 'finance-posting', resourceId: id,
        details: { originalPostingId: originalId } });
      await this.evidence.outbox(manager, { eventType: 'FinancePostingReversed',
        aggregateType: 'finance-posting', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financePostingId: id, studentAccountId: original.account_id } });
      return { id, replayed: false };
    });
  }

  private assertPostingEnabled(): void {
    if (!this.config.get('FINANCE_POSTING_ENABLED', { infer: true })) {
      throw new ForbiddenException('Finance posting is disabled pending NIET policy approval');
    }
  }
  private async lockAccount(manager: { query: DataSource['query'] }, id: string): Promise<AccountRow> {
    const rows = await manager.query<readonly AccountRow[]>(
      'SELECT * FROM finance.student_accounts WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Student account not found');
    return rows[0];
  }
  private async resolveReplay(manager: { query: DataSource['query'] }, input: PostFinanceTransactionDto,
    type: PostingType): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly PostingRow[]>(
      'SELECT * FROM finance.postings WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    if (row?.account_id === input.accountId && row.posting_type === type
      && row.amount_minor === input.amountMinor && row.currency === input.currency) {
      if (row.evidence_reference !== input.evidenceReference) {
        throw new ConflictException('Finance idempotency key already has different content');
      }
      return { id: row.id, replayed: true };
    }
    throw new ConflictException('Finance idempotency key already has different content');
  }
  private async insertEntries(manager: { query: DataSource['query'] }, postingId: string,
    sides: readonly (readonly string[])[], amount: string, currency: string): Promise<void> {
    for (const [ledgerAccount, direction] of sides) {
      await manager.query(`INSERT INTO finance.ledger_entries
        (id,posting_id,ledger_account,direction,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), postingId, ledgerAccount, direction, amount, currency]);
    }
  }
}

function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

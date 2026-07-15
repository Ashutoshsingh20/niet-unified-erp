import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type {
  ApproveReconciliationDto,
  CreateApplicantAccountDto,
  CreateReconciliationDto,
  CreateStudentAccountDto,
  DecideRefundDto,
  IssueReceiptDto,
  PostFinanceTransactionDto,
  RecordProviderPaymentDto,
  RequestRefundDto,
  ReversePostingDto,
} from './finance.dto';

type PostingType = 'DEMAND' | 'PAYMENT';
interface AccountRow { id: string; student_id: string | null; application_id: string | null;
  currency: string; scope_type: string; scope_id: string }
interface PostingRow { id: string; account_id: string; posting_type: string; amount_minor: string;
  currency: string; requested_by: string; original_posting_id: string | null;
  idempotency_key: string; evidence_reference: string }
interface ProviderEventRow { id: string; posting_id: string; provider_key: string; provider_event_id: string;
  account_id: string; amount_minor: string; currency: string; payload_sha256: string;
  verification_engine: string; verification_version: string; verification_trace_reference: string;
  provider_occurred_at: Date }
interface ReceiptRow { id: string; document_manifest_sha256: string; evidence_reference: string }
interface ReconciliationRow { id: string; idempotency_key: string; provider_key: string; scope_type: string;
  scope_id: string; period_start: Date; period_end: Date; currency: string; expected_event_count: number;
  expected_amount_minor: string; actual_event_count: number; actual_amount_minor: string;
  event_set_sha256: string; evidence_reference: string; created_by: string }
interface RefundRequestRow { id: string; idempotency_key: string; original_payment_posting_id: string;
  amount_minor: string; currency: string; reason: string; evidence_reference: string; requested_by: string }
interface RefundDecisionRow { id: string; decision: 'APPROVED' | 'REJECTED'; evidence_reference: string;
  decided_by: string; refund_posting_id: string | null }

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
        await manager.query(`INSERT INTO finance.accounts
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

  async createApplicantAccount(input: CreateApplicantAccountDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled('ADMISSION_FINANCE_ACCOUNT_ENABLED',
      'Applicant finance accounts are disabled pending NIET admission-fee approval');
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly { id: string; status: string;
        scope_type: string; scope_id: string }[]>(`SELECT id,status,scope_type,scope_id
        FROM admissions.applications WHERE id=$1 FOR UPDATE`, [input.applicationId]);
      const application = rows[0];
      if (application === undefined) throw new NotFoundException('Admission application not found');
      if (application.scope_type !== input.scopeType || application.scope_id !== input.scopeId) {
        throw new ConflictException('Application and account scope are not aligned');
      }
      if (['REJECTED', 'WITHDRAWN', 'CONVERTED'].includes(application.status)) {
        throw new ConflictException('Terminal or converted application cannot receive a new applicant account');
      }
      const existing = await manager.query<readonly { id: string; policy_reference: string }[]>(
        'SELECT id,policy_reference FROM finance.accounts WHERE application_id=$1 AND currency=$2',
      [input.applicationId, input.currency]);
      if (existing[0] !== undefined) {
        if (existing[0].policy_reference !== input.policyReference) {
          throw new ConflictException('Applicant account already exists under a different policy reference');
        }
        return { id: existing[0].id, replayed: true };
      }
      const id = randomUUID();
      const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO finance.accounts
        (id,application_id,currency,scope_type,scope_id,policy_reference,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (application_id,currency) WHERE application_id IS NOT NULL DO NOTHING RETURNING id`,
      [id, input.applicationId, input.currency,
        input.scopeType, input.scopeId, input.policyReference, actor.subjectId]);
      if (inserted[0] === undefined) {
        const concurrent = await manager.query<readonly { id: string; policy_reference: string }[]>(
          'SELECT id,policy_reference FROM finance.accounts WHERE application_id=$1 AND currency=$2',
        [input.applicationId, input.currency]);
        if (concurrent[0]?.policy_reference !== input.policyReference) {
          throw new ConflictException('Applicant account already exists under a different policy reference');
        }
        if (concurrent[0] === undefined) throw new ConflictException('Applicant account creation conflicted');
        return { id: concurrent[0].id, replayed: true };
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.applicant-account.created', resourceType: 'finance-account', resourceId: id,
        details: { applicationId: input.applicationId, currency: input.currency,
          scopeType: input.scopeType, scopeId: input.scopeId, policyReference: input.policyReference } });
      await this.evidence.outbox(manager, { eventType: 'ApplicantFinanceAccountCreated',
        aggregateType: 'finance-account', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financeAccountId: id, admissionApplicationId: input.applicationId } });
      return { id, replayed: false };
    });
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
      await this.insertStandardEntries(manager, id, postingType, input.amountMinor, input.currency);
      await this.recordPostingEvidence(manager, id, input.accountId, postingType, input.amountMinor,
        input.currency, actor.subjectId);
      return { id, replayed: false };
    });
  }

  async recordProviderPayment(input: RecordProviderPaymentDto,
    actor: Principal): Promise<{ providerEventId: string; postingId: string; replayed: boolean }> {
    this.assertPostingEnabled();
    this.assertEnabled('FINANCE_PROVIDER_POSTING_ENABLED',
      'Provider payment posting is disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      await this.lockProviderStream(manager, input.providerKey);
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify([input.providerKey, input.providerEventId])]);
      const existing = await manager.query<readonly ProviderEventRow[]>(
        'SELECT * FROM finance.provider_events WHERE provider_key=$1 AND provider_event_id=$2',
      [input.providerKey, input.providerEventId]);
      if (existing[0] !== undefined) {
        const account = await this.lockAccount(manager, existing[0].account_id);
        this.policy.assertScope(actor, account.scope_type, account.scope_id);
        if (!providerEventMatches(existing[0], input)) {
          throw new ConflictException('Provider event identifier already has different verified content');
        }
        return { providerEventId: existing[0].id, postingId: existing[0].posting_id, replayed: true };
      }
      const account = await this.lockAccount(manager, input.accountId);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (account.currency !== input.currency) {
        throw new ConflictException('Provider payment currency must match account currency');
      }
      const postingId = randomUUID();
      const providerEventId = randomUUID();
      await manager.query(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,requested_by)
        VALUES ($1,$2,'PAYMENT',$3,$4,$5,$6,$7)`,
      [postingId, input.accountId, input.amountMinor, input.currency, randomUUID(),
        input.verificationTraceReference, actor.subjectId]);
      await this.insertStandardEntries(manager, postingId, 'PAYMENT', input.amountMinor, input.currency);
      await manager.query(`INSERT INTO finance.provider_events
        (id,provider_key,provider_event_id,event_type,account_id,amount_minor,currency,payload_sha256,
         verification_engine,verification_version,verification_trace_reference,provider_occurred_at,
         posting_id,recorded_by)
        VALUES ($1,$2,$3,'PAYMENT_CONFIRMED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [providerEventId, input.providerKey, input.providerEventId, input.accountId, input.amountMinor,
        input.currency, input.payloadSha256, input.verificationEngine, input.verificationVersion,
        input.verificationTraceReference, input.providerOccurredAt, postingId, actor.subjectId]);
      await this.recordPostingEvidence(manager, postingId, input.accountId, 'PAYMENT', input.amountMinor,
        input.currency, actor.subjectId, { providerEventId, providerKey: input.providerKey });
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.provider-event.recorded', resourceType: 'finance-provider-event',
        resourceId: providerEventId, details: { financePostingId: postingId,
          providerKey: input.providerKey, verificationEngine: input.verificationEngine,
          verificationVersion: input.verificationVersion } });
      return { providerEventId, postingId, replayed: false };
    });
  }

  async issueReceipt(postingId: string, input: IssueReceiptDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const posting = await this.lockPosting(manager, postingId);
      const account = await this.lockAccount(manager, posting.account_id);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (posting.posting_type !== 'PAYMENT') throw new ConflictException('Receipts can only be issued for payments');
      const existing = await manager.query<readonly ReceiptRow[]>(
        'SELECT * FROM finance.receipts WHERE payment_posting_id=$1', [postingId]);
      if (existing[0] !== undefined) {
        if (existing[0].document_manifest_sha256 !== input.documentManifestSha256
          || existing[0].evidence_reference !== input.evidenceReference) {
          throw new ConflictException('Payment already has a different immutable receipt');
        }
        return { id: existing[0].id, replayed: true };
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO finance.receipts
        (id,payment_posting_id,document_manifest_sha256,evidence_reference,issued_by)
        VALUES ($1,$2,$3,$4,$5)`,
      [id, postingId, input.documentManifestSha256, input.evidenceReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.receipt.issued', resourceType: 'finance-receipt', resourceId: id,
        details: { financePostingId: postingId, documentManifestSha256: input.documentManifestSha256 } });
      await this.evidence.outbox(manager, { eventType: 'FinanceReceiptIssued',
        aggregateType: 'finance-receipt', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financeReceiptId: id, financePostingId: postingId } });
      return { id, replayed: false };
    });
  }

  async createReconciliation(input: CreateReconciliationDto,
    actor: Principal): Promise<{ id: string; actualEventCount: number; actualAmountMinor: string;
      eventSetSha256: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Date(input.periodStart).getTime() >= new Date(input.periodEnd).getTime()) {
      throw new ConflictException('Reconciliation period start must precede its end');
    }
    return this.dataSource.transaction(async (manager) => {
      await this.lockProviderStream(manager, input.providerKey);
      const byKey = await manager.query<readonly ReconciliationRow[]>(
        'SELECT * FROM finance.reconciliation_batches WHERE idempotency_key=$1 FOR UPDATE',
      [input.idempotencyKey]);
      if (byKey[0] !== undefined) return this.resolveReconciliationReplay(byKey[0], input);
      const cutoffRows = await manager.query<readonly { snapshot_cutoff: Date }[]>(
        'SELECT clock_timestamp() snapshot_cutoff');
      const snapshotCutoff = cutoffRows[0]?.snapshot_cutoff;
      if (snapshotCutoff === undefined) throw new ConflictException('Could not establish reconciliation cutoff');
      const events = await manager.query<readonly { provider_event_id: string; payload_sha256: string;
        amount_minor: string }[]>(`SELECT pe.provider_event_id,pe.payload_sha256,pe.amount_minor::text
        FROM finance.provider_events pe JOIN finance.accounts a ON a.id=pe.account_id
        WHERE pe.provider_key=$1 AND a.scope_type=$2 AND a.scope_id=$3 AND pe.currency=$4
          AND pe.provider_occurred_at >= $5 AND pe.provider_occurred_at < $6
          AND pe.recorded_at <= $7
        ORDER BY pe.provider_event_id,pe.id`,
      [input.providerKey, input.scopeType, input.scopeId, input.currency, input.periodStart, input.periodEnd,
        snapshotCutoff]);
      const actualAmount = events.reduce((total, event) => total + BigInt(event.amount_minor), 0n).toString();
      const eventSetSha256 = createHash('sha256').update(events.map((event) =>
        `${event.provider_event_id}\u0000${event.payload_sha256}\u0000${event.amount_minor}\n`).join('')).digest('hex');
      const id = randomUUID();
      await manager.query(`INSERT INTO finance.reconciliation_batches
        (id,idempotency_key,provider_key,scope_type,scope_id,period_start,period_end,currency,
         expected_event_count,expected_amount_minor,actual_event_count,actual_amount_minor,
         event_set_sha256,snapshot_cutoff,evidence_reference,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, input.idempotencyKey, input.providerKey, input.scopeType, input.scopeId,
        input.periodStart, input.periodEnd, input.currency, input.expectedEventCount,
        input.expectedAmountMinor, events.length, actualAmount, eventSetSha256, snapshotCutoff,
        input.evidenceReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.reconciliation.created', resourceType: 'finance-reconciliation', resourceId: id,
        details: { providerKey: input.providerKey, scopeType: input.scopeType, scopeId: input.scopeId,
          currency: input.currency, expectedEventCount: input.expectedEventCount,
          actualEventCount: events.length, totalsMatch: input.expectedAmountMinor === actualAmount
            && input.expectedEventCount === events.length } });
      return { id, actualEventCount: events.length, actualAmountMinor: actualAmount,
        eventSetSha256, replayed: false };
    });
  }

  async approveReconciliation(id: string, input: ApproveReconciliationDto,
    actor: Principal): Promise<{ approvalId: string; replayed: boolean }> {
    this.assertEnabled('FINANCE_RECONCILIATION_APPROVAL_ENABLED',
      'Reconciliation approval is disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly ReconciliationRow[]>(
        'SELECT * FROM finance.reconciliation_batches WHERE id=$1 FOR UPDATE', [id]);
      const batch = rows[0];
      if (batch === undefined) throw new NotFoundException('Reconciliation batch not found');
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (batch.created_by === actor.subjectId) {
        throw new ForbiddenException('Reconciliation maker cannot approve the batch');
      }
      if (batch.expected_event_count !== batch.actual_event_count
        || batch.expected_amount_minor !== batch.actual_amount_minor) {
        throw new ConflictException('Reconciliation control totals do not match');
      }
      const existing = await manager.query<readonly { id: string; evidence_reference: string;
        approved_by: string }[]>('SELECT * FROM finance.reconciliation_approvals WHERE batch_id=$1', [id]);
      if (existing[0] !== undefined) {
        if (existing[0].evidence_reference !== input.evidenceReference
          || existing[0].approved_by !== actor.subjectId) {
          throw new ConflictException('Reconciliation batch already has a different approval');
        }
        return { approvalId: existing[0].id, replayed: true };
      }
      const approvalId = randomUUID();
      await manager.query(`INSERT INTO finance.reconciliation_approvals
        (id,batch_id,evidence_reference,approved_by) VALUES ($1,$2,$3,$4)`,
      [approvalId, id, input.evidenceReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.reconciliation.approved', resourceType: 'finance-reconciliation', resourceId: id,
        details: { approvalId, eventSetSha256: batch.event_set_sha256 } });
      await this.evidence.outbox(manager, { eventType: 'FinanceReconciliationApproved',
        aggregateType: 'finance-reconciliation', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financeReconciliationId: id, reconciliationApprovalId: approvalId } });
      return { approvalId, replayed: false };
    });
  }

  async requestRefund(originalPaymentId: string, input: RequestRefundDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled('FINANCE_REFUND_ENABLED', 'Refund workflows are disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      const original = await this.lockPosting(manager, originalPaymentId);
      const account = await this.lockAccount(manager, original.account_id);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (original.posting_type !== 'PAYMENT') throw new ConflictException('Refunds require an original payment');
      if (original.currency !== input.currency) throw new ConflictException('Refund currency must match payment currency');
      const byKey = await manager.query<readonly RefundRequestRow[]>(
        'SELECT * FROM finance.refund_requests WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (byKey[0] !== undefined) return this.resolveRefundRequestReplay(byKey[0], originalPaymentId, input);
      await this.assertPaymentNotReversed(manager, originalPaymentId);
      const reserved = await manager.query<readonly { amount_minor: string }[]>(`SELECT COALESCE(sum(rr.amount_minor),0)::text amount_minor
        FROM finance.refund_requests rr LEFT JOIN finance.refund_decisions rd ON rd.request_id=rr.id
        WHERE rr.original_payment_posting_id=$1 AND COALESCE(rd.decision,'APPROVED') <> 'REJECTED'`,
      [originalPaymentId]);
      if (BigInt(reserved[0]?.amount_minor ?? '0') + BigInt(input.amountMinor) > BigInt(original.amount_minor)) {
        throw new ConflictException('Refund requests exceed the remaining payment amount');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO finance.refund_requests
        (id,idempotency_key,original_payment_posting_id,amount_minor,currency,reason,evidence_reference,requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, input.idempotencyKey, originalPaymentId, input.amountMinor, input.currency,
        input.reason, input.evidenceReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'finance.refund.requested', resourceType: 'finance-refund-request', resourceId: id,
        details: { originalPaymentPostingId: originalPaymentId, amountMinor: input.amountMinor,
          currency: input.currency } });
      await this.evidence.outbox(manager, { eventType: 'FinanceRefundRequested',
        aggregateType: 'finance-refund-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { financeRefundRequestId: id, originalPaymentPostingId: originalPaymentId } });
      return { id, replayed: false };
    });
  }

  async decideRefund(id: string, input: DecideRefundDto,
    actor: Principal): Promise<{ decisionId: string; postingId: string | null; replayed: boolean }> {
    this.assertEnabled('FINANCE_REFUND_ENABLED', 'Refund workflows are disabled pending NIET approval');
    if (input.decision === 'APPROVED') this.assertPostingEnabled();
    return this.dataSource.transaction(async (manager) => {
      const requests = await manager.query<readonly RefundRequestRow[]>(
        'SELECT * FROM finance.refund_requests WHERE id=$1 FOR UPDATE', [id]);
      const request = requests[0];
      if (request === undefined) throw new NotFoundException('Refund request not found');
      const original = await this.lockPosting(manager, request.original_payment_posting_id);
      const account = await this.lockAccount(manager, original.account_id);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (request.requested_by === actor.subjectId) throw new ForbiddenException('Refund maker cannot decide request');
      const existing = await manager.query<readonly RefundDecisionRow[]>(`SELECT rd.*,
        r.refund_posting_id FROM finance.refund_decisions rd LEFT JOIN finance.refunds r ON r.request_id=rd.request_id
        WHERE rd.request_id=$1`, [id]);
      if (existing[0] !== undefined) return this.resolveRefundDecisionReplay(existing[0], input, actor);
      const decisionId = randomUUID();
      if (input.decision === 'REJECTED') {
        await manager.query(`INSERT INTO finance.refund_decisions
          (id,request_id,decision,evidence_reference,decided_by) VALUES ($1,$2,'REJECTED',$3,$4)`,
        [decisionId, id, input.evidenceReference, actor.subjectId]);
        await this.recordRefundDecisionEvidence(manager, request, decisionId, null, input.decision, actor.subjectId);
        return { decisionId, postingId: null, replayed: false };
      }
      if (input.postingIdempotencyKey === undefined) {
        throw new ConflictException('Approved refund requires a posting idempotency key');
      }
      await this.assertPaymentNotReversed(manager, original.id);
      const posted = await manager.query<readonly { amount_minor: string }[]>(`SELECT COALESCE(sum(p.amount_minor),0)::text amount_minor
        FROM finance.postings p WHERE p.original_posting_id=$1 AND p.posting_type='REFUND'`, [original.id]);
      if (BigInt(posted[0]?.amount_minor ?? '0') + BigInt(request.amount_minor) > BigInt(original.amount_minor)) {
        throw new ConflictException('Approved refunds exceed the original payment amount');
      }
      const postingId = randomUUID();
      try {
        await manager.query(`INSERT INTO finance.postings
          (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,
           original_posting_id,requested_by,approved_by)
          VALUES ($1,$2,'REFUND',$3,$4,$5,$6,$7,$8,$9)`,
        [postingId, original.account_id, request.amount_minor, request.currency,
          input.postingIdempotencyKey, input.evidenceReference, original.id, request.requested_by, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Refund posting idempotency key already exists'); }
      await this.insertEntries(manager, postingId,
        [['RECEIVABLE', 'DEBIT'], ['PAYMENT_CLEARING', 'CREDIT']], request.amount_minor, request.currency);
      await manager.query(`INSERT INTO finance.refund_decisions
        (id,request_id,decision,evidence_reference,decided_by) VALUES ($1,$2,'APPROVED',$3,$4)`,
      [decisionId, id, input.evidenceReference, actor.subjectId]);
      await manager.query('INSERT INTO finance.refunds(id,request_id,refund_posting_id) VALUES ($1,$2,$3)',
        [randomUUID(), id, postingId]);
      await this.recordRefundDecisionEvidence(manager, request, decisionId, postingId, input.decision, actor.subjectId);
      return { decisionId, postingId, replayed: false };
    });
  }

  async reverse(originalId: string, input: ReversePostingDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled('FINANCE_REVERSAL_ENABLED',
      'Finance reversals are disabled pending NIET policy approval');
    return this.dataSource.transaction(async (manager) => {
      const original = await this.lockPosting(manager, originalId);
      const account = await this.lockAccount(manager, original.account_id);
      this.policy.assertScope(actor, account.scope_type, account.scope_id);
      if (!['DEMAND', 'PAYMENT'].includes(original.posting_type)) {
        throw new ConflictException('Only original demand or payment postings can be reversed');
      }
      if (original.requested_by === actor.subjectId) throw new ForbiddenException('Posting maker cannot approve reversal');
      if (original.posting_type === 'PAYMENT') {
        const refunds = await manager.query<readonly { exists: boolean }[]>(`SELECT EXISTS (
          SELECT 1 FROM finance.refund_requests rr LEFT JOIN finance.refund_decisions rd ON rd.request_id=rr.id
          WHERE rr.original_payment_posting_id=$1 AND COALESCE(rd.decision,'APPROVED') <> 'REJECTED') exists`,
        [originalId]);
        if (refunds[0]?.exists === true) throw new ConflictException('Payment with an active refund request cannot be reversed');
      }
      const existing = await manager.query<readonly PostingRow[]>(
        "SELECT * FROM finance.postings WHERE original_posting_id=$1 AND posting_type='REVERSAL'", [originalId]);
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
    this.assertEnabled('FINANCE_POSTING_ENABLED',
      'Finance posting is disabled pending NIET policy approval');
  }

  private assertEnabled(key: keyof Pick<Environment, 'FINANCE_POSTING_ENABLED' | 'FINANCE_REVERSAL_ENABLED'
    | 'FINANCE_PROVIDER_POSTING_ENABLED' | 'FINANCE_RECONCILIATION_APPROVAL_ENABLED'
    | 'FINANCE_REFUND_ENABLED' | 'ADMISSION_FINANCE_ACCOUNT_ENABLED'>, message: string): void {
    if (!this.config.get(key, { infer: true })) throw new ForbiddenException(message);
  }

  private async lockAccount(manager: EntityManager, id: string): Promise<AccountRow> {
    const rows = await manager.query<readonly AccountRow[]>(
      'SELECT * FROM finance.accounts WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Finance account not found');
    return rows[0];
  }

  private async lockPosting(manager: EntityManager, id: string): Promise<PostingRow> {
    const rows = await manager.query<readonly PostingRow[]>(
      'SELECT * FROM finance.postings WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Finance posting not found');
    return rows[0];
  }

  private async assertPaymentNotReversed(manager: EntityManager, id: string): Promise<void> {
    const rows = await manager.query<readonly { exists: boolean }[]>(`SELECT EXISTS (
      SELECT 1 FROM finance.postings WHERE original_posting_id=$1 AND posting_type='REVERSAL') exists`, [id]);
    if (rows[0]?.exists === true) throw new ConflictException('Reversed payment cannot be refunded');
  }

  private async lockProviderStream(manager: EntityManager, providerKey: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['finance-provider-stream', providerKey])]);
  }

  private async resolveReplay(manager: EntityManager, input: PostFinanceTransactionDto,
    type: PostingType): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly PostingRow[]>(
      'SELECT * FROM finance.postings WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    if (row?.account_id === input.accountId && row.posting_type === type
      && row.amount_minor === input.amountMinor && row.currency === input.currency
      && row.evidence_reference === input.evidenceReference) return { id: row.id, replayed: true };
    throw new ConflictException('Finance idempotency key already has different content');
  }

  private resolveReconciliationReplay(row: ReconciliationRow,
    input: CreateReconciliationDto): { id: string; actualEventCount: number;
      actualAmountMinor: string; eventSetSha256: string; replayed: boolean } {
    if (row.provider_key !== input.providerKey || row.scope_type !== input.scopeType
      || row.scope_id !== input.scopeId || row.currency !== input.currency
      || row.period_start.getTime() !== new Date(input.periodStart).getTime()
      || row.period_end.getTime() !== new Date(input.periodEnd).getTime()
      || row.expected_event_count !== input.expectedEventCount
      || row.expected_amount_minor !== input.expectedAmountMinor
      || row.evidence_reference !== input.evidenceReference) {
      throw new ConflictException('Reconciliation idempotency key already has different content');
    }
    return { id: row.id, actualEventCount: row.actual_event_count,
      actualAmountMinor: row.actual_amount_minor, eventSetSha256: row.event_set_sha256, replayed: true };
  }

  private resolveRefundRequestReplay(row: RefundRequestRow, originalPaymentId: string,
    input: RequestRefundDto): { id: string; replayed: boolean } {
    if (row.original_payment_posting_id !== originalPaymentId || row.amount_minor !== input.amountMinor
      || row.currency !== input.currency || row.reason !== input.reason
      || row.evidence_reference !== input.evidenceReference) {
      throw new ConflictException('Refund idempotency key already has different content');
    }
    return { id: row.id, replayed: true };
  }

  private resolveRefundDecisionReplay(row: RefundDecisionRow, input: DecideRefundDto,
    actor: Principal): { decisionId: string; postingId: string | null; replayed: boolean } {
    if (row.decision !== input.decision || row.evidence_reference !== input.evidenceReference
      || row.decided_by !== actor.subjectId) {
      throw new ConflictException('Refund request already has a different decision');
    }
    return { decisionId: row.id, postingId: row.refund_posting_id, replayed: true };
  }

  private async insertStandardEntries(manager: EntityManager, postingId: string, type: PostingType,
    amount: string, currency: string): Promise<void> {
    const sides = type === 'DEMAND'
      ? [['RECEIVABLE', 'DEBIT'], ['REVENUE', 'CREDIT']]
      : [['PAYMENT_CLEARING', 'DEBIT'], ['RECEIVABLE', 'CREDIT']];
    await this.insertEntries(manager, postingId, sides, amount, currency);
  }

  private async insertEntries(manager: EntityManager, postingId: string,
    sides: readonly (readonly string[])[], amount: string, currency: string): Promise<void> {
    for (const [ledgerAccount, direction] of sides) {
      await manager.query(`INSERT INTO finance.ledger_entries
        (id,posting_id,ledger_account,direction,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), postingId, ledgerAccount, direction, amount, currency]);
    }
  }

  private async recordPostingEvidence(manager: EntityManager, id: string, accountId: string,
    type: PostingType, amountMinor: string, currency: string, actorSubjectId: string,
    extra: Record<string, unknown> = {}): Promise<void> {
    await this.evidence.audit(manager, { actorSubjectId,
      action: `finance.${type.toLowerCase()}.posted`, resourceType: 'finance-posting', resourceId: id,
      details: { accountId, amountMinor, currency, ...extra } });
    await this.evidence.outbox(manager, { eventType: type === 'DEMAND' ? 'DemandRaised' : 'PaymentPosted',
      aggregateType: 'finance-posting', aggregateId: id, classification: 'CONFIDENTIAL',
      payload: { financePostingId: id, studentAccountId: accountId } });
  }

  private async recordRefundDecisionEvidence(manager: EntityManager, request: RefundRequestRow,
    decisionId: string, postingId: string | null, decision: 'APPROVED' | 'REJECTED',
    actorSubjectId: string): Promise<void> {
    await this.evidence.audit(manager, { actorSubjectId,
      action: `finance.refund.${decision.toLowerCase()}`, resourceType: 'finance-refund-request',
      resourceId: request.id, details: { decisionId, refundPostingId: postingId } });
    await this.evidence.outbox(manager, { eventType: decision === 'APPROVED'
      ? 'FinanceRefundApproved' : 'FinanceRefundRejected', aggregateType: 'finance-refund-request',
      aggregateId: request.id, classification: 'CONFIDENTIAL',
      payload: { financeRefundRequestId: request.id, refundDecisionId: decisionId,
        ...(postingId === null ? {} : { financePostingId: postingId }) } });
  }
}

function providerEventMatches(row: ProviderEventRow, input: RecordProviderPaymentDto): boolean {
  return row.account_id === input.accountId && row.amount_minor === input.amountMinor
    && row.currency === input.currency && row.payload_sha256 === input.payloadSha256
    && row.verification_engine === input.verificationEngine
    && row.verification_version === input.verificationVersion
    && row.verification_trace_reference === input.verificationTraceReference
    && row.provider_occurred_at.getTime() === new Date(input.providerOccurredAt).getTime();
}

function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

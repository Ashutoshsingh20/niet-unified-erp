import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinanceService } from '../apps/api/dist/modules/finance/finance.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Finance verification requires _test');
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = new FinanceService(dataSource, policy, evidence, { get: () => true });
  const disabled = new FinanceService(dataSource, policy, evidence, { get: () => false });
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `finance-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `finance-checker-${suffix}` };
  const secondChecker = { ...maker, subjectId: `finance-checker-2-${suffix}` };
  const outsider = { ...maker, subjectId: `finance-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const student = await students.create({ idempotencyKey: randomUUID(),
    subjectId: `finance-student-${suffix}`, displayName: 'Synthetic Finance Student',
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-admissions',
    sourceKey: `finance-application-${suffix}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: '9'.repeat(64) }, maker);
  const account = await enabled.createAccount({ studentId: student.id, currency: 'INR',
    scopeType: 'organization', scopeId }, maker);

  let scopeDenied = false;
  try { await enabled.post({ accountId: account.id, amountMinor: '10000', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: 'SYNTHETIC-DEMAND' }, 'DEMAND', outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Finance posting ignored tenant scope');
  const demandInput = { accountId: account.id, amountMinor: '10000', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-DEMAND-${suffix}` };
  let postingDisabled = false;
  try { await disabled.post(demandInput, 'DEMAND', maker); }
  catch (error) { postingDisabled = error instanceof ForbiddenException; }
  if (!postingDisabled) throw new Error('Finance posting bypassed its disabled gate');
  const demand = await enabled.post(demandInput, 'DEMAND', maker);
  const replay = await enabled.post(demandInput, 'DEMAND', maker);
  if (!replay.replayed || replay.id !== demand.id) throw new Error('Finance retry was not idempotent');
  let changedReplayRejected = false;
  try { await enabled.post({ ...demandInput, amountMinor: '10001' }, 'DEMAND', maker); }
  catch (error) { changedReplayRejected = error instanceof ConflictException; }
  if (!changedReplayRejected) throw new Error('Changed finance replay was accepted');
  const payment = await enabled.post({ accountId: account.id, amountMinor: '2500', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-PAYMENT-${suffix}` }, 'PAYMENT', maker);
  const reversalInput = { idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-REVERSAL-${suffix}` };
  let reversalDisabled = false;
  try { await disabled.reverse(payment.id, reversalInput, checker); }
  catch (error) { reversalDisabled = error instanceof ForbiddenException; }
  if (!reversalDisabled) throw new Error('Finance reversal bypassed its disabled gate');
  let makerCheckerEnforced = false;
  try { await enabled.reverse(payment.id, reversalInput, maker); }
  catch (error) { makerCheckerEnforced = error instanceof ForbiddenException; }
  if (!makerCheckerEnforced) throw new Error('Finance posting maker approved reversal');
  const reversal = await enabled.reverse(payment.id, reversalInput, checker);
  const reversalReplay = await enabled.reverse(payment.id, reversalInput, checker);
  if (!reversalReplay.replayed || reversalReplay.id !== reversal.id) throw new Error('Reversal retry was not idempotent');

  const occurredAt = new Date();
  const providerInput = { providerKey: `synthetic.${suffix}`, providerEventId: `payment-${suffix}`,
    accountId: account.id, amountMinor: '4000', currency: 'INR', payloadSha256: 'a'.repeat(64),
    verificationEngine: 'synthetic-signature-verifier', verificationVersion: '1.0.0',
    verificationTraceReference: `SYNTHETIC-TRACE-${suffix}`,
    providerOccurredAt: occurredAt.toISOString() };
  let providerDisabled = false;
  try { await disabled.recordProviderPayment(providerInput, maker); }
  catch (error) { providerDisabled = error instanceof ForbiddenException; }
  if (!providerDisabled) throw new Error('Provider posting bypassed its disabled gate');
  const providerResults = await Promise.all([
    enabled.recordProviderPayment(providerInput, maker), enabled.recordProviderPayment(providerInput, maker),
  ]);
  const providerPayment = providerResults[0];
  if (providerResults.some((result) => result.postingId !== providerPayment.postingId)
    || providerResults.filter((result) => result.replayed).length !== 1) {
    throw new Error('Concurrent provider delivery created duplicate postings');
  }
  let changedProviderRejected = false;
  try { await enabled.recordProviderPayment({ ...providerInput, amountMinor: '4001' }, maker); }
  catch (error) { changedProviderRejected = error instanceof ConflictException; }
  if (!changedProviderRejected) throw new Error('Changed provider-event replay was accepted');

  const receiptInput = { documentManifestSha256: 'b'.repeat(64),
    evidenceReference: `SYNTHETIC-RECEIPT-${suffix}` };
  const receipt = await enabled.issueReceipt(providerPayment.postingId, receiptInput, maker);
  const receiptReplay = await enabled.issueReceipt(providerPayment.postingId, receiptInput, maker);
  if (!receiptReplay.replayed || receiptReplay.id !== receipt.id) throw new Error('Receipt retry was not idempotent');
  let changedReceiptRejected = false;
  try { await enabled.issueReceipt(providerPayment.postingId,
    { ...receiptInput, documentManifestSha256: 'c'.repeat(64) }, maker); }
  catch (error) { changedReceiptRejected = error instanceof ConflictException; }
  if (!changedReceiptRejected) throw new Error('A payment acquired conflicting receipt evidence');

  const periodStart = new Date(occurredAt.getTime() - 60_000).toISOString();
  const periodEnd = new Date(occurredAt.getTime() + 60_000).toISOString();
  const reconciliationInput = { idempotencyKey: randomUUID(), providerKey: providerInput.providerKey,
    scopeType: 'organization', scopeId, periodStart, periodEnd, currency: 'INR',
    expectedEventCount: 1, expectedAmountMinor: '4000',
    evidenceReference: `SYNTHETIC-RECONCILIATION-${suffix}` };
  let reconciliationScopeDenied = false;
  try { await enabled.createReconciliation({ ...reconciliationInput, idempotencyKey: randomUUID() }, outsider); }
  catch (error) { reconciliationScopeDenied = error instanceof ForbiddenException; }
  if (!reconciliationScopeDenied) throw new Error('Reconciliation ignored tenant scope');
  const reconciliation = await enabled.createReconciliation(reconciliationInput, maker);
  const reconciliationReplay = await enabled.createReconciliation(reconciliationInput, maker);
  if (!reconciliationReplay.replayed || reconciliationReplay.id !== reconciliation.id
    || reconciliation.actualEventCount !== 1 || reconciliation.actualAmountMinor !== '4000') {
    throw new Error('Reconciliation snapshot or retry was incorrect');
  }
  let reconciliationDisabled = false;
  try { await disabled.approveReconciliation(reconciliation.id,
    { evidenceReference: `SYNTHETIC-RECON-APPROVAL-${suffix}` }, checker); }
  catch (error) { reconciliationDisabled = error instanceof ForbiddenException; }
  if (!reconciliationDisabled) throw new Error('Reconciliation approval bypassed its disabled gate');
  let reconciliationMakerDenied = false;
  try { await enabled.approveReconciliation(reconciliation.id,
    { evidenceReference: `SYNTHETIC-RECON-APPROVAL-${suffix}` }, maker); }
  catch (error) { reconciliationMakerDenied = error instanceof ForbiddenException; }
  if (!reconciliationMakerDenied) throw new Error('Reconciliation maker approved the batch');
  const mismatch = await enabled.createReconciliation({ ...reconciliationInput,
    idempotencyKey: randomUUID(), expectedAmountMinor: '4001',
    evidenceReference: `SYNTHETIC-RECON-MISMATCH-${suffix}` }, maker);
  let mismatchRejected = false;
  try { await enabled.approveReconciliation(mismatch.id,
    { evidenceReference: `SYNTHETIC-RECON-MISMATCH-APPROVAL-${suffix}` }, checker); }
  catch (error) { mismatchRejected = error instanceof ConflictException; }
  if (!mismatchRejected) throw new Error('Mismatched reconciliation was approved');
  const reconciliationApprovalInput = { evidenceReference: `SYNTHETIC-RECON-APPROVAL-${suffix}` };
  const reconciliationApproval = await enabled.approveReconciliation(
    reconciliation.id, reconciliationApprovalInput, checker);
  const reconciliationApprovalReplay = await enabled.approveReconciliation(
    reconciliation.id, reconciliationApprovalInput, checker);
  if (!reconciliationApprovalReplay.replayed
    || reconciliationApprovalReplay.approvalId !== reconciliationApproval.approvalId) {
    throw new Error('Reconciliation approval retry was not idempotent');
  }

  const refundInput = { idempotencyKey: randomUUID(), amountMinor: '1500', currency: 'INR',
    reason: 'Synthetic duplicate settlement', evidenceReference: `SYNTHETIC-REFUND-${suffix}` };
  let refundDisabled = false;
  try { await disabled.requestRefund(providerPayment.postingId, refundInput, maker); }
  catch (error) { refundDisabled = error instanceof ForbiddenException; }
  if (!refundDisabled) throw new Error('Refund request bypassed its disabled gate');
  const refundRequest = await enabled.requestRefund(providerPayment.postingId, refundInput, maker);
  const refundRequestReplay = await enabled.requestRefund(providerPayment.postingId, refundInput, maker);
  if (!refundRequestReplay.replayed || refundRequestReplay.id !== refundRequest.id) {
    throw new Error('Refund request retry was not idempotent');
  }
  let refundMakerDenied = false;
  try { await enabled.decideRefund(refundRequest.id, { decision: 'APPROVED',
    postingIdempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-REFUND-APPROVAL-${suffix}` }, maker); }
  catch (error) { refundMakerDenied = error instanceof ForbiddenException; }
  if (!refundMakerDenied) throw new Error('Refund maker approved the request');
  const rejectedRequest = await enabled.requestRefund(providerPayment.postingId,
    { idempotencyKey: randomUUID(), amountMinor: '100', currency: 'INR', reason: 'Synthetic rejected refund',
      evidenceReference: `SYNTHETIC-REFUND-REJECT-${suffix}` }, maker);
  const rejectedDecisionInput = { decision: 'REJECTED',
    evidenceReference: `SYNTHETIC-REFUND-REJECT-DECISION-${suffix}` };
  const rejectedDecision = await enabled.decideRefund(rejectedRequest.id, rejectedDecisionInput, checker);
  const rejectedReplay = await enabled.decideRefund(rejectedRequest.id, rejectedDecisionInput, checker);
  if (!rejectedReplay.replayed || rejectedReplay.decisionId !== rejectedDecision.decisionId
    || rejectedReplay.postingId !== null) throw new Error('Refund rejection retry was not idempotent');
  let overRefundRejected = false;
  try { await enabled.requestRefund(providerPayment.postingId,
    { idempotencyKey: randomUUID(), amountMinor: '2600', currency: 'INR', reason: 'Synthetic excessive refund',
      evidenceReference: `SYNTHETIC-OVER-REFUND-${suffix}` }, maker); }
  catch (error) { overRefundRejected = error instanceof ConflictException; }
  if (!overRefundRejected) throw new Error('Refund reservations exceeded the original payment');
  const secondRefundRequest = await enabled.requestRefund(providerPayment.postingId,
    { idempotencyKey: randomUUID(), amountMinor: '2500', currency: 'INR', reason: 'Synthetic remainder refund',
      evidenceReference: `SYNTHETIC-REFUND-2-${suffix}` }, maker);
  const refundDecisionInput = { decision: 'APPROVED', postingIdempotencyKey: randomUUID(),
    evidenceReference: `SYNTHETIC-REFUND-APPROVAL-${suffix}` };
  const refundDecision = await enabled.decideRefund(refundRequest.id, refundDecisionInput, checker);
  const refundDecisionReplay = await enabled.decideRefund(refundRequest.id, refundDecisionInput, checker);
  if (!refundDecisionReplay.replayed || refundDecisionReplay.postingId !== refundDecision.postingId) {
    throw new Error('Refund approval retry was not idempotent');
  }
  const secondRefundDecision = await enabled.decideRefund(secondRefundRequest.id,
    { decision: 'APPROVED', postingIdempotencyKey: randomUUID(),
      evidenceReference: `SYNTHETIC-REFUND-APPROVAL-2-${suffix}` }, secondChecker);
  if (secondRefundDecision.postingId === null) throw new Error('Second partial refund did not post');
  let refundedPaymentReversalRejected = false;
  try { await enabled.reverse(providerPayment.postingId,
    { idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-REFUNDED-REVERSAL-${suffix}` }, checker); }
  catch (error) { refundedPaymentReversalRejected = error instanceof ConflictException; }
  if (!refundedPaymentReversalRejected) throw new Error('Payment with refunds was reversed');

  let inconsistentProviderRejected = false;
  try { await dataSource.query(`INSERT INTO finance.provider_events
    (id,provider_key,provider_event_id,event_type,account_id,amount_minor,currency,payload_sha256,
     verification_engine,verification_version,verification_trace_reference,provider_occurred_at,
     posting_id,recorded_by)
    VALUES ($1,$2,$3,'PAYMENT_CONFIRMED',$4,1,'INR',$5,'synthetic','1','WRONG-TRACE',clock_timestamp(),$6,$7)`,
  [randomUUID(), `synthetic-db.${suffix}`, `wrong-${suffix}`, account.id, 'd'.repeat(64), payment.id,
    maker.subjectId]); } catch { inconsistentProviderRejected = true; }
  if (!inconsistentProviderRejected) throw new Error('Database accepted provider evidence inconsistent with posting');
  let directMismatchApprovalRejected = false;
  try { await dataSource.query(`INSERT INTO finance.reconciliation_approvals
    (id,batch_id,evidence_reference,approved_by) VALUES ($1,$2,$3,$4)`,
  [randomUUID(), mismatch.id, `SYNTHETIC-DIRECT-MISMATCH-${suffix}`, checker.subjectId]); }
  catch { directMismatchApprovalRejected = true; }
  if (!directMismatchApprovalRejected) throw new Error('Database accepted mismatched reconciliation approval');

  let mutationRejected = false;
  try { await dataSource.query('UPDATE finance.receipts SET evidence_reference=$1 WHERE id=$2',
    ['MUTATED', receipt.id]); } catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Finance receipt evidence was mutable');
  let imbalanceRejected = false;
  try {
    await dataSource.transaction(async (manager) => {
      const postingId = randomUUID();
      await manager.query(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,requested_by)
        VALUES ($1,$2,'DEMAND',1,'INR',$3,'SYNTHETIC-IMBALANCE',$4)`,
      [postingId, account.id, randomUUID(), maker.subjectId]);
      await manager.query(`INSERT INTO finance.ledger_entries
        (id,posting_id,ledger_account,direction,amount_minor,currency)
        VALUES ($1,$2,'RECEIVABLE','DEBIT',1,'INR')`, [randomUUID(), postingId]);
    });
  } catch { imbalanceRejected = true; }
  if (!imbalanceRejected) throw new Error('Unbalanced finance journal was committed');

  const postingIds = [demand.id, payment.id, reversal.id, providerPayment.postingId,
    refundDecision.postingId, secondRefundDecision.postingId];
  const proofRows = await dataSource.query(`SELECT
    (SELECT COALESCE(sum(CASE WHEN e.ledger_account='RECEIVABLE' AND e.direction='DEBIT'
      THEN e.amount_minor WHEN e.ledger_account='RECEIVABLE' AND e.direction='CREDIT'
      THEN -e.amount_minor ELSE 0 END),0)::text FROM finance.ledger_entries e
      JOIN finance.postings p ON p.id=e.posting_id WHERE p.account_id=$1) receivable_balance,
    (SELECT count(*)::int FROM finance.postings WHERE account_id=$1) posting_count,
    (SELECT count(*)::int FROM finance.ledger_entries e JOIN finance.postings p ON p.id=e.posting_id
      WHERE p.account_id=$1) entry_count,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='finance-posting'
      AND resource_id=ANY($2::text[])) posting_audits,
    (SELECT count(*)::int FROM finance.provider_events WHERE posting_id=$3) provider_events,
    (SELECT count(*)::int FROM finance.receipts WHERE payment_posting_id=$3) receipts,
    (SELECT count(*)::int FROM finance.refunds r JOIN finance.refund_requests rr ON rr.id=r.request_id
      WHERE rr.original_payment_posting_id=$3) refunds,
    (SELECT count(*)::int FROM finance.reconciliation_approvals WHERE batch_id=$4) approvals,
    (SELECT bool_and(payload - ARRAY['financePostingId','studentAccountId'] = '{}'::jsonb)
      FROM platform.outbox_events WHERE aggregate_type='finance-posting' AND aggregate_id=ANY($2::text[])) minimum_payload`,
  [account.id, postingIds, providerPayment.postingId, reconciliation.id]);
  const proof = proofRows[0];
  if (proof?.receivable_balance !== '10000' || proof?.posting_count !== 6 || proof?.entry_count !== 12
    || proof?.posting_audits !== 4 || proof?.provider_events !== 1 || proof?.receipts !== 1
    || proof?.refunds !== 2 || proof?.approvals !== 1 || proof?.minimum_payload !== true) {
    throw new Error(`Finance evidence is incomplete: ${JSON.stringify(proof)}`);
  }
  process.stdout.write('Finance scope, gates, provider idempotency, receipts, reconciliation controls, partial refunds, integer money, balanced immutable journals, maker-checker, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

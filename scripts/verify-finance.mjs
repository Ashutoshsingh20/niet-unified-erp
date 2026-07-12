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
  let mutationRejected = false;
  try { await dataSource.query("UPDATE finance.ledger_entries SET amount_minor=1 WHERE posting_id=$1", [demand.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Finance ledger evidence was mutable');
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
  const proofRows = await dataSource.query(`SELECT
    (SELECT COALESCE(sum(CASE WHEN e.ledger_account='RECEIVABLE' AND e.direction='DEBIT'
      THEN e.amount_minor WHEN e.ledger_account='RECEIVABLE' AND e.direction='CREDIT'
      THEN -e.amount_minor ELSE 0 END),0)::text FROM finance.ledger_entries e
      JOIN finance.postings p ON p.id=e.posting_id WHERE p.account_id=$1) receivable_balance,
    (SELECT count(*)::int FROM finance.postings WHERE account_id=$1) posting_count,
    (SELECT count(*)::int FROM finance.ledger_entries e JOIN finance.postings p ON p.id=e.posting_id
      WHERE p.account_id=$1) entry_count,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='finance-posting'
      AND resource_id IN ($2::text,$3::text,$4::text)) audits,
    (SELECT bool_and(payload ? 'financePostingId' AND payload ? 'studentAccountId'
      AND payload - ARRAY['financePostingId','studentAccountId'] = '{}'::jsonb) FROM platform.outbox_events
      WHERE aggregate_type='finance-posting' AND aggregate_id IN ($2::text,$3::text,$4::text)) minimum_payload`,
  [account.id, demand.id, payment.id, reversal.id]);
  const proof = proofRows[0];
  if (proof?.receivable_balance !== '10000' || proof?.posting_count !== 3 || proof?.entry_count !== 6
    || proof?.audits !== 3 || proof?.minimum_payload !== true) {
    throw new Error('Finance balance, journal, audit, or minimum-data evidence is incomplete');
  }
  process.stdout.write('Finance scope, gates, integer money, idempotency, balance, immutable journals, maker-checker reversal, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

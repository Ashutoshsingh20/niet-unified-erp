import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FeeStructuresService } from '../apps/api/dist/modules/finance/fee-structures.service.js';
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
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Fee structure verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = new FeeStructuresService(dataSource, policy, evidence, { get: () => true });
  const disabled = new FeeStructuresService(dataSource, policy, evidence, { get: () => false });
  const finance = new FinanceService(dataSource, policy, evidence, { get: () => true });
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `fee-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `fee-checker-${suffix}` };
  const outsider = { ...maker, subjectId: `fee-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const student = await students.create({ idempotencyKey: randomUUID(),
    subjectId: `fee-student-${suffix}`, displayName: 'Synthetic Fee Student',
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-admissions',
    sourceKey: `fee-application-${suffix}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: '8'.repeat(64) }, maker);
  const account = await finance.createAccount({ studentId: student.id, currency: 'INR',
    scopeType: 'organization', scopeId }, maker);
  const structureInput = { structureKey: `synthetic.fees.${suffix}`, version: 1,
    title: 'Synthetic governed fee structure', currency: 'INR', scopeType: 'organization', scopeId,
    idempotencyKey: randomUUID(), lines: [
      { lineKey: 'tuition-1', feeHeadKey: 'tuition', title: 'Synthetic tuition installment one',
        installmentKey: 'installment-1', dueOn: '2030-07-01', amountMinor: '100000', allocationOrder: 1 },
      { lineKey: 'exam-1', feeHeadKey: 'examination', title: 'Synthetic examination installment one',
        installmentKey: 'installment-1', dueOn: '2030-07-01', amountMinor: '5000', allocationOrder: 2 },
      { lineKey: 'tuition-2', feeHeadKey: 'tuition', title: 'Synthetic tuition installment two',
        installmentKey: 'installment-2', dueOn: '2030-12-01', amountMinor: '100000', allocationOrder: 3 },
    ] };
  const creationResults = await Promise.all([
    enabled.create(structureInput, maker), enabled.create(structureInput, maker),
  ]);
  const structure = creationResults.find((result) => !result.replayed);
  if (structure === undefined || creationResults.filter((result) => result.replayed).length !== 1
    || creationResults.some((result) => result.id !== structure.id)) throw new Error('Concurrent fee structure replay failed');
  let changedReplayRejected = false;
  try { await enabled.create({ ...structureInput, title: 'Changed fee structure title' }, maker); }
  catch (error) { changedReplayRejected = error instanceof ConflictException; }
  if (!changedReplayRejected) throw new Error('Changed fee structure replay was accepted');
  const publication = { expectedRecordVersion: 1, policyDecisionReference: 'SYNTHETIC-NIET-FEE-APPROVAL' };
  let publicationDisabled = false;
  try { await disabled.publish(structure.id, publication, checker); }
  catch (error) { publicationDisabled = error instanceof ForbiddenException; }
  if (!publicationDisabled) throw new Error('Fee publication bypassed disabled gate');
  let makerDenied = false;
  try { await enabled.publish(structure.id, publication, maker); }
  catch (error) { makerDenied = error instanceof ForbiddenException; }
  if (!makerDenied) throw new Error('Fee structure maker published its version');
  let scopeDenied = false;
  try { await enabled.publish(structure.id, publication, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Fee publication ignored scope');
  const published = await enabled.publish(structure.id, publication, checker);
  const publicationReplay = await enabled.publish(structure.id, publication, checker);
  if (published.replayed || !publicationReplay.replayed) throw new Error('Fee publication replay failed');
  let postPublicationLineRejected = false;
  try { await dataSource.query(`INSERT INTO finance.fee_structure_lines
    (id,structure_id,line_key,fee_head_key,title,installment_key,due_on,amount_minor,allocation_order)
    VALUES ($1,$2,'late-line','tuition','Late synthetic line','installment-3','2031-01-01',1,4)`,
  [randomUUID(), structure.id]); }
  catch { postPublicationLineRejected = true; }
  if (!postPublicationLineRejected) throw new Error('Published fee structure accepted another line');
  const demandInput = { accountId: account.id, idempotencyKey: randomUUID(),
    expectedStructureRecordVersion: 2, lineKeys: ['exam-1', 'tuition-1'],
    evidenceReference: 'SYNTHETIC-GOVERNED-DEMAND' };
  let demandDisabled = false;
  try { await disabled.raiseDemand(structure.id, demandInput, maker); }
  catch (error) { demandDisabled = error instanceof ForbiddenException; }
  if (!demandDisabled) throw new Error('Governed demand bypassed disabled gate');
  const demand = await enabled.raiseDemand(structure.id, demandInput, maker);
  const demandReplay = await enabled.raiseDemand(structure.id, demandInput, maker);
  if (demand.replayed || !demandReplay.replayed || demandReplay.id !== demand.id
    || demand.amountMinor !== '105000') throw new Error('Governed demand allocation or replay failed');
  let changedDemandRejected = false;
  try { await enabled.raiseDemand(structure.id, { ...demandInput, lineKeys: ['tuition-2'] }, maker); }
  catch (error) { changedDemandRejected = error instanceof ConflictException; }
  if (!changedDemandRejected) throw new Error('Changed governed demand replay was accepted');
  let duplicateLineRejected = false;
  try { await enabled.raiseDemand(structure.id, { ...demandInput, idempotencyKey: randomUUID(),
    lineKeys: ['tuition-1'] }, maker); }
  catch (error) { duplicateLineRejected = error instanceof ConflictException; }
  if (!duplicateLineRejected) throw new Error('Fee line was demanded twice');
  let allocationBypassRejected = false;
  try {
    await dataSource.transaction(async (manager) => {
      const postingId = randomUUID();
      await manager.query(`INSERT INTO finance.postings
        (id,account_id,posting_type,amount_minor,currency,idempotency_key,evidence_reference,requested_by)
        VALUES ($1,$2,'DEMAND',1,'INR',$3,'SYNTHETIC-BYPASS',$4)`,
      [postingId, account.id, randomUUID(), maker.subjectId]);
      for (const [ledgerAccount, direction] of [['RECEIVABLE', 'DEBIT'], ['REVENUE', 'CREDIT']]) {
        await manager.query(`INSERT INTO finance.ledger_entries
          (id,posting_id,ledger_account,direction,amount_minor,currency) VALUES ($1,$2,$3,$4,1,'INR')`,
        [randomUUID(), postingId, ledgerAccount, direction]);
      }
      await manager.query(`INSERT INTO finance.governed_demands
        (posting_id,structure_id,account_id,selected_lines_manifest_sha256,created_by)
        VALUES ($1,$2,$3,$4,$5)`, [postingId, structure.id, account.id, '0'.repeat(64), maker.subjectId]);
    });
  } catch { allocationBypassRejected = true; }
  if (!allocationBypassRejected) throw new Error('Governed demand bypassed allocation consistency');
  let publishedMutationRejected = false;
  try { await dataSource.query("UPDATE finance.fee_structures SET title='tampered' WHERE id=$1", [structure.id]); }
  catch { publishedMutationRejected = true; }
  if (!publishedMutationRejected) throw new Error('Published fee structure was mutable');
  let allocationMutationRejected = false;
  try { await dataSource.query('DELETE FROM finance.demand_allocations WHERE posting_id=$1', [demand.id]); }
  catch { allocationMutationRejected = true; }
  if (!allocationMutationRejected) throw new Error('Demand allocation was mutable');
  const proofRows = await dataSource.query(`SELECT
    (SELECT status FROM finance.fee_structures WHERE id=$1) structure_status,
    (SELECT count(*)::int FROM finance.fee_structure_lines WHERE structure_id=$1) lines,
    (SELECT count(*)::int FROM finance.demand_allocations WHERE posting_id=$2) allocations,
    (SELECT COALESCE(sum(amount_minor),0)::text FROM finance.demand_allocations WHERE posting_id=$2) allocated,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='finance-fee-structure'
      AND resource_id=$1::text) structure_audits,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='finance-posting'
      AND resource_id=$2::text) demand_audits,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type IN ('finance-fee-structure','finance-posting')
        AND aggregate_id IN ($1::text,$2::text)) events`, [structure.id, demand.id]);
  const proof = proofRows[0];
  if (proof?.structure_status !== 'PUBLISHED' || proof?.lines !== 3 || proof?.allocations !== 2
    || proof?.allocated !== '105000' || proof?.structure_audits !== 2
    || proof?.demand_audits !== 1 || proof?.events !== 2) {
    throw new Error('Fee structure, allocation, audit, or outbox evidence is incomplete');
  }
  process.stdout.write('Versioned fee structures, maker-checker publication, policy gates, exact replay, scoped governed demands, installment line allocation, duplicate prevention, balanced ledger evidence, immutability, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

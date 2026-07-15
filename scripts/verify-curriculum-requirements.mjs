import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumRequirementsService } from '../apps/api/dist/modules/curriculum/curriculum-requirements.service.js';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { ProgrammesService } from '../apps/api/dist/modules/programmes/programmes.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Curriculum requirement verification requires _test');
  }
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: () => true }; const disabledConfig = { get: () => false };
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabledConfig);
  const programmes = new ProgrammesService(dataSource, policy, evidence, enabledConfig);
  const requirements = new CurriculumRequirementsService(dataSource, policy, evidence, enabledConfig);
  const disabled = new CurriculumRequirementsService(dataSource, policy, evidence, disabledConfig);
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `requirements-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `requirements-checker-${suffix}` };
  const evaluator = { ...maker, subjectId: `requirements-evaluator-${suffix}` };
  const outsider = { ...evaluator, scopes: { organization: [randomUUID()] } };
  const studentActor = { ...maker, subjectId: `requirements-student-${suffix}` };
  const student = await students.create({ idempotencyKey: randomUUID(), subjectId: studentActor.subjectId,
    displayName: 'Synthetic curriculum requirement student', scopeType: 'organization', scopeId,
    sourceSystem: 'synthetic-curriculum', sourceKey: `requirements-${suffix}`,
    sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
    sourceRowSha256: '3'.repeat(64) }, maker);
  const regulation = await curriculum.create({ regulationKey: `requirements-${suffix}`, version: 1,
    title: 'Synthetic requirement regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_EXTERNAL_RULES' },
    impactSummary: 'Synthetic rules verify governed curriculum evidence without NIET policy.' }, maker);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-CURRICULUM-POLICY' }, maker);
  const programme = await programmes.create({ programmeKey: `REQUIREMENTS-${suffix}`, version: 1,
    title: 'Synthetic requirements programme', regulationId: regulation.id,
    structureManifestSha256: '4'.repeat(64), scopeType: 'organization', scopeId }, maker);
  await programmes.publish(programme.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-CURRICULUM-POLICY' }, maker);

  const catalogueInput = { catalogueKey: `catalogue-${suffix}`, version: 1,
    title: 'Synthetic course catalogue', regulationId: regulation.id, idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId, entries: [
      { courseKey: `COURSE-A-${suffix}`, title: 'Synthetic foundation course', creditUnits: '4.00',
        attributes: { source: 'SYNTHETIC', level: 'foundation' } },
      { courseKey: `COURSE-B-${suffix}`, title: 'Synthetic advanced course', creditUnits: '3.00',
        attributes: { source: 'SYNTHETIC', level: 'advanced' } },
    ] };
  const catalogueResults = await Promise.all([
    requirements.createCatalogue(catalogueInput, maker), requirements.createCatalogue(catalogueInput, maker),
  ]);
  if (catalogueResults[0].id !== catalogueResults[1].id
    || catalogueResults.filter((item) => item.replayed).length !== 1) {
    throw new Error('Concurrent course catalogue replay failed');
  }
  const catalogue = catalogueResults[0];
  const publication = { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-CURRICULUM-POLICY' };
  await expectForbidden(() => disabled.publishCatalogue(catalogue.id, publication, checker),
    'Catalogue bypassed disabled publication gate');
  await expectForbidden(() => requirements.publishCatalogue(catalogue.id, publication, maker),
    'Catalogue creator published the same configuration');
  await requirements.publishCatalogue(catalogue.id, publication, checker);
  const catalogueRead = await requirements.getCatalogue(catalogue.id, checker);
  if (catalogueRead.status !== 'PUBLISHED' || catalogueRead.entries.length !== 2
    || catalogueRead.entryManifestSha256 === '0'.repeat(64)) {
    throw new Error('Published course catalogue read model is incomplete');
  }

  const courseRequirementInput = { requirementKey: `course-eligibility-${suffix}`, version: 1,
    title: 'Synthetic course eligibility requirements', requirementType: 'COURSE_ELIGIBILITY',
    programmeVersionId: programme.id, catalogueId: catalogue.id,
    targetCourseKey: `COURSE-B-${suffix}`, evaluationContractVersion: 'synthetic-contract-v1',
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId, clauses: [
      { clauseKey: 'foundation-completion', sequence: 1, clauseType: 'COURSE_COMPLETION',
        title: 'Complete supplied foundation course',
        ruleDocument: { courseKey: `COURSE-A-${suffix}`, source: 'SYNTHETIC_EXTERNAL_POLICY' } },
      { clauseKey: 'grade-evidence', sequence: 2, clauseType: 'MINIMUM_GRADE',
        title: 'Meet externally supplied grade condition',
        ruleDocument: { gradePolicyReference: 'SYNTHETIC-NO-GRADE-ORDER-EMBEDDED' } },
    ] };
  const courseRequirement = await requirements.createRequirementSet(courseRequirementInput, maker);
  const requirementReplay = await requirements.createRequirementSet(courseRequirementInput, maker);
  if (!requirementReplay.replayed || requirementReplay.id !== courseRequirement.id) {
    throw new Error('Requirement set exact replay failed');
  }
  await expectForbidden(() => disabled.publishRequirementSet(courseRequirement.id, publication, checker),
    'Requirement set bypassed disabled publication gate');
  await expectForbidden(() => requirements.publishRequirementSet(courseRequirement.id, publication, maker),
    'Requirement set creator published it');
  await requirements.publishRequirementSet(courseRequirement.id, publication, checker);
  const requirementRead = await requirements.getRequirementSet(courseRequirement.id, checker);
  if (requirementRead.status !== 'PUBLISHED' || requirementRead.clauses.length !== 2
    || requirementRead.targetCourseKey !== `COURSE-B-${suffix}`) {
    throw new Error('Published requirement-set read model is incomplete');
  }

  const evaluationInput = { requirementSetId: courseRequirement.id, studentId: student.id,
    evaluationMode: 'REGISTRATION', candidateManifestSha256: '5'.repeat(64),
    sourceEvidenceManifestSha256: '6'.repeat(64), result: 'ELIGIBLE',
    evaluatorEngine: 'synthetic-requirement-evaluator', evaluatorVersion: 'v1',
    policyReference: 'SYNTHETIC-CURRICULUM-POLICY',
    evaluationTrace: { contract: 'synthetic-contract-v1', decision: 'SYNTHETIC' },
    explanationSummary: 'Synthetic external evaluator satisfied every supplied clause.',
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId, clauseResults: [
      { clauseKey: 'foundation-completion', outcome: 'SATISFIED',
        evidenceReference: 'SYNTHETIC-TRANSCRIPT-EVIDENCE',
        explanation: 'Synthetic completion evidence matched the supplied course clause.',
        evidenceTrace: { sourceRecord: 'SYNTHETIC-COURSE-A' } },
      { clauseKey: 'grade-evidence', outcome: 'SATISFIED',
        evidenceReference: 'SYNTHETIC-GRADE-EVIDENCE',
        explanation: 'External evaluator reported the supplied grade policy satisfied.',
        evidenceTrace: { policyOwnedComparison: true } },
    ] };
  await expectForbidden(() => disabled.evaluate(evaluationInput, evaluator),
    'Evaluation bypassed disabled gate');
  await expectConflict(() => requirements.evaluate({ ...evaluationInput, idempotencyKey: randomUUID(),
    clauseResults: evaluationInput.clauseResults.slice(0, 1) }, evaluator),
  'Incomplete clause evaluation was accepted');
  const evaluationResults = await Promise.all([
    requirements.evaluate(evaluationInput, evaluator), requirements.evaluate(evaluationInput, evaluator),
  ]);
  if (evaluationResults[0].id !== evaluationResults[1].id
    || evaluationResults.filter((item) => item.replayed).length !== 1) {
    throw new Error('Concurrent requirement evaluation replay failed');
  }
  const evaluation = await requirements.getEvaluation(evaluationResults[0].id, evaluator);
  if (evaluation.result !== 'ELIGIBLE' || evaluation.clauseResults.length !== 2
    || evaluation.resultManifestSha256 === '0'.repeat(64)) {
    throw new Error('Explainable requirement evaluation read model is incomplete');
  }
  await expectForbidden(() => requirements.getEvaluation(evaluation.id, outsider),
    'Requirement evaluation was readable outside scope');

  const degreeRequirement = await requirements.createRequirementSet({
    requirementKey: `degree-audit-${suffix}`, version: 1, title: 'Synthetic degree audit requirements',
    requirementType: 'DEGREE_AUDIT', programmeVersionId: programme.id, catalogueId: catalogue.id,
    evaluationContractVersion: 'synthetic-degree-v1', idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId, clauses: [{ clauseKey: 'credit-total', sequence: 1,
      clauseType: 'MINIMUM_CREDITS', title: 'Meet externally supplied credit total',
      ruleDocument: { creditPolicyReference: 'SYNTHETIC-NO-CREDIT-LIMIT-EMBEDDED' } }] }, maker);
  await requirements.publishRequirementSet(degreeRequirement.id, publication, checker);
  const whatIf = await requirements.evaluate({ requirementSetId: degreeRequirement.id, studentId: student.id,
    evaluationMode: 'WHAT_IF', candidateManifestSha256: '7'.repeat(64),
    sourceEvidenceManifestSha256: '8'.repeat(64), result: 'INCOMPLETE',
    evaluatorEngine: 'synthetic-degree-evaluator', evaluatorVersion: 'v1',
    policyReference: 'SYNTHETIC-CURRICULUM-POLICY', evaluationTrace: { hypothetical: true },
    explanationSummary: 'Synthetic what-if evidence remains incomplete.', idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId, clauseResults: [{ clauseKey: 'credit-total', outcome: 'UNKNOWN',
      evidenceReference: 'SYNTHETIC-WHAT-IF-EVIDENCE',
      explanation: 'Hypothetical credit evidence is incomplete.', evidenceTrace: { hypothetical: true } }] },
  evaluator);
  if ((await requirements.getEvaluation(whatIf.id, evaluator)).evaluationMode !== 'WHAT_IF') {
    throw new Error('What-if degree evaluation mode was not retained');
  }

  let mutationRejected = false;
  try { await dataSource.query(`UPDATE curriculum.requirement_evaluation_results
    SET outcome='UNSATISFIED' WHERE evaluation_id=$1`, [evaluation.id]); } catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Requirement evaluation evidence was mutable');
  let catalogueMutationRejected = false;
  try { await dataSource.query(`UPDATE curriculum.course_catalogue_entries SET credit_units=99
    WHERE catalogue_id=$1`, [catalogue.id]); } catch { catalogueMutationRejected = true; }
  if (!catalogueMutationRejected) throw new Error('Published course catalogue entry was mutable');
  let catalogueAppendRejected = false;
  try { await dataSource.query(`INSERT INTO curriculum.course_catalogue_entries
    (catalogue_id,course_key,title,credit_units,attributes)
    VALUES ($1,$2,'Synthetic late course',1,'{}')`, [catalogue.id, `LATE-${suffix}`]); }
  catch { catalogueAppendRejected = true; }
  if (!catalogueAppendRejected) throw new Error('Published course catalogue accepted a late entry');
  let clauseAppendRejected = false;
  try { await dataSource.query(`INSERT INTO curriculum.requirement_clauses
    (requirement_set_id,clause_key,sequence,clause_type,title,rule_document)
    VALUES ($1,'late-clause',99,'CUSTOM','Synthetic late clause','{}')`, [courseRequirement.id]); }
  catch { clauseAppendRejected = true; }
  if (!clauseAppendRejected) throw new Error('Published requirement set accepted a late clause');
  let resultAppendRejected = false;
  try { await dataSource.query(`INSERT INTO curriculum.requirement_evaluation_results
    (evaluation_id,clause_key,outcome,evidence_reference,explanation,evidence_trace)
    VALUES ($1,'late-result','UNKNOWN','SYNTHETIC-LATE','Synthetic late result','{}')`, [evaluation.id]); }
  catch { resultAppendRejected = true; }
  if (!resultAppendRejected) throw new Error('Sealed evaluation accepted a late result');
  let incompleteRejected = false;
  try {
    await dataSource.query('BEGIN');
    await dataSource.query(`INSERT INTO curriculum.requirement_evaluations
      (id,requirement_set_id,student_id,evaluation_mode,candidate_manifest_sha256,
       source_evidence_manifest_sha256,result,result_manifest_sha256,evaluator_engine,evaluator_version,
       policy_reference,evaluation_trace,explanation_summary,input_sha256,idempotency_key,
       scope_type,scope_id,evaluated_by) VALUES ($1,$2,$3,'REGISTRATION',$4,$5,'INCOMPLETE',$6,
       'synthetic-direct','v1','SYNTHETIC-CURRICULUM-POLICY','{}','Synthetic incomplete direct record',
       $7,$8,'organization',$9,$10)`, [randomUUID(), courseRequirement.id, student.id,
      '9'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), randomUUID(), scopeId,
      evaluator.subjectId]);
    await dataSource.query('COMMIT');
  } catch {
    incompleteRejected = true;
    await dataSource.query('ROLLBACK');
  }
  if (!incompleteRejected) throw new Error('Incomplete direct requirement evaluation committed');
  const proof = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type IN
      ('course-catalogue','curriculum-requirement-set','curriculum-requirement-evaluation')
      AND aggregate_id IN ($1::text,$2::text,$3::text,$4::text,$5::text)) events,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type IN
      ('course-catalogue','curriculum-requirement-set','curriculum-requirement-evaluation')
      AND resource_id IN ($1::text,$2::text,$3::text,$4::text,$5::text)) audits`,
  [catalogue.id, courseRequirement.id, evaluation.id, degreeRequirement.id, whatIf.id]);
  if (proof[0]?.events !== 5 || proof[0]?.audits !== 8) {
    throw new Error('Curriculum requirement audit or outbox evidence is incomplete');
  }
  process.stdout.write('Versioned course catalogue and requirement manifests, concurrent exact replay, maker-checker publication, disabled gates, complete clause evidence, course eligibility, degree what-if, evaluator provenance, scope denial, immutable reads, direct incomplete-record rejection, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

async function expectConflict(action, message) {
  try { await action(); } catch (error) { if (error instanceof ConflictException) return; throw error; }
  throw new Error(message);
}
async function expectForbidden(action, message) {
  try { await action(); } catch (error) { if (error instanceof ForbiddenException) return; throw error; }
  throw new Error(message);
}

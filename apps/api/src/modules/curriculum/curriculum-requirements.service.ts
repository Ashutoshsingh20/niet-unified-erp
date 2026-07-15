import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateCourseCatalogueDto, CreateRequirementEvaluationDto, CreateRequirementSetDto,
  PublishCurriculumConfigurationDto } from './curriculum-requirements.dto';

interface ConfigurationRow { id: string; status: string; record_version: number; scope_type: string;
  scope_id: string; created_by: string; input_sha256: string }
interface RequirementRow extends ConfigurationRow { requirement_type: 'COURSE_ELIGIBILITY' | 'DEGREE_AUDIT';
  programme_version_id: string; catalogue_id: string; target_course_key: string | null;
  evaluation_contract_version: string; clause_manifest_sha256: string }
interface EvaluationRow { id: string; requirement_set_id: string; student_id: string;
  evaluation_mode: 'REGISTRATION' | 'DEGREE_AUDIT' | 'WHAT_IF'; candidate_manifest_sha256: string;
  source_evidence_manifest_sha256: string; result: 'ELIGIBLE' | 'INELIGIBLE' | 'INCOMPLETE';
  result_manifest_sha256: string; evaluator_engine: string; evaluator_version: string;
  policy_reference: string; evaluation_trace: Record<string, unknown>; explanation_summary: string;
  input_sha256: string; scope_type: string; scope_id: string; evaluated_by: string; evaluated_at: Date }
interface CatalogueRow { id: string; catalogue_key: string; version: number; title: string;
  regulation_id: string; entry_manifest_sha256: string; status: string; record_version: number;
  scope_type: string; scope_id: string; policy_decision_reference: string | null; published_at: Date | null }
interface RequirementSetRow extends RequirementRow { requirement_key: string; version: number; title: string;
  policy_decision_reference: string | null; published_at: Date | null }

export interface CourseCatalogue {
  readonly id: string; readonly catalogueKey: string; readonly version: number; readonly title: string;
  readonly regulationId: string; readonly entryManifestSha256: string; readonly status: string;
  readonly recordVersion: number; readonly policyDecisionReference: string | null;
  readonly publishedAt: string | null; readonly entries: readonly { courseKey: string; title: string;
    creditUnits: string; attributes: Readonly<Record<string, unknown>> }[];
}

export interface CurriculumRequirementSet {
  readonly id: string; readonly requirementKey: string; readonly version: number; readonly title: string;
  readonly requirementType: RequirementRow['requirement_type']; readonly programmeVersionId: string;
  readonly catalogueId: string; readonly targetCourseKey: string | null;
  readonly evaluationContractVersion: string; readonly clauseManifestSha256: string;
  readonly status: string; readonly recordVersion: number; readonly policyDecisionReference: string | null;
  readonly publishedAt: string | null; readonly clauses: readonly { clauseKey: string; sequence: number;
    clauseType: string; title: string; ruleDocument: Readonly<Record<string, unknown>> }[];
}

export interface RequirementEvaluation {
  readonly id: string;
  readonly requirementSetId: string;
  readonly studentId: string;
  readonly evaluationMode: EvaluationRow['evaluation_mode'];
  readonly candidateManifestSha256: string;
  readonly sourceEvidenceManifestSha256: string;
  readonly result: EvaluationRow['result'];
  readonly resultManifestSha256: string;
  readonly evaluatorEngine: string;
  readonly evaluatorVersion: string;
  readonly policyReference: string;
  readonly evaluationTrace: Readonly<Record<string, unknown>>;
  readonly explanationSummary: string;
  readonly evaluatedBy: string;
  readonly evaluatedAt: string;
  readonly clauseResults: readonly { clauseKey: string; outcome: string; evidenceReference: string;
    explanation: string; evidenceTrace: Readonly<Record<string, unknown>> }[];
}

@Injectable()
export class CurriculumRequirementsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async createCatalogue(input: CreateCourseCatalogueDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const entries = [...input.entries].sort((left, right) => left.courseKey.localeCompare(right.courseKey));
    const inputHash = hash({ ...input, entries });
    return this.dataSource.transaction(async (manager) => {
      const replay = await this.findReplay(manager, 'curriculum.course_catalogues',
        input.idempotencyKey, inputHash);
      if (replay !== null) return replay;
      const regulations = await manager.query<readonly { scope_type: string; scope_id: string }[]>(
        `SELECT scope_type,scope_id FROM curriculum.regulation_versions
         WHERE id=$1 AND status='PUBLISHED'`, [input.regulationId]);
      if (regulations[0]?.scope_type !== input.scopeType || regulations[0]?.scope_id !== input.scopeId) {
        throw new ConflictException('A published regulation in the catalogue scope is required');
      }
      const id = randomUUID();
      try {
        const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO curriculum.course_catalogues
          (id,catalogue_key,version,title,regulation_id,input_sha256,entry_manifest_sha256,
           idempotency_key,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [id, input.catalogueKey, input.version,
          input.title, input.regulationId, inputHash, '0'.repeat(64), input.idempotencyKey,
          input.scopeType, input.scopeId, actor.subjectId]);
        if (inserted[0] === undefined) return this.resolveConcurrentReplay(manager,
          'curriculum.course_catalogues', input.idempotencyKey, inputHash,
          'Course catalogue idempotency key already exists');
      } catch (error) {
        if (isUnique(error)) throw new ConflictException('Course catalogue version already exists');
        throw error;
      }
      for (const entry of entries) {
        await manager.query(`INSERT INTO curriculum.course_catalogue_entries
          (catalogue_id,course_key,title,credit_units,attributes) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [id, entry.courseKey, entry.title, entry.creditUnits, JSON.stringify(entry.attributes)]);
      }
      await manager.query(`UPDATE curriculum.course_catalogues c SET entry_manifest_sha256=x.manifest
        FROM (SELECT encode(digest(string_agg(jsonb_build_object('courseKey',course_key,'title',title,
          'creditUnits',credit_units::text,'attributes',attributes)::text,',' ORDER BY course_key),
          'sha256'),'hex') manifest FROM curriculum.course_catalogue_entries WHERE catalogue_id=$1) x
        WHERE c.id=$1`, [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.catalogue.drafted', resourceType: 'course-catalogue', resourceId: id,
        details: { catalogueKey: input.catalogueKey, version: input.version,
          regulationId: input.regulationId, entryCount: entries.length } });
      return { id, replayed: false };
    });
  }

  async publishCatalogue(id: string, input: PublishCurriculumConfigurationDto,
    actor: Principal): Promise<void> {
    this.assertGate('CURRICULUM_CATALOGUE_PUBLICATION_ENABLED',
      'Course catalogue publication is disabled pending NIET academic approval');
    await this.dataSource.transaction(async (manager) => {
      const catalogue = await this.lockConfiguration(manager, 'curriculum.course_catalogues', id,
        'Course catalogue not found');
      this.policy.assertScope(actor, catalogue.scope_type, catalogue.scope_id);
      this.assertPublicationState(catalogue, input.expectedRecordVersion, actor);
      await manager.query(`UPDATE curriculum.course_catalogues SET status='PUBLISHED',
        record_version=record_version+1,policy_decision_reference=$2,published_by=$3,
        published_at=clock_timestamp() WHERE id=$1`,
      [id, input.policyDecisionReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.catalogue.published', resourceType: 'course-catalogue', resourceId: id,
        details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'CourseCataloguePublished',
        aggregateType: 'course-catalogue', aggregateId: id, classification: 'INTERNAL',
        payload: { courseCatalogueId: id } });
    });
  }

  async getCatalogue(id: string, actor: Principal): Promise<CourseCatalogue> {
    const rows = await this.dataSource.query<readonly CatalogueRow[]>(
      'SELECT * FROM curriculum.course_catalogues WHERE id=$1', [id]);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException('Course catalogue not found');
    this.policy.assertScope(actor, row.scope_type, row.scope_id);
    const entries = await this.dataSource.query<readonly { course_key: string; title: string;
      credit_units: string; attributes: Record<string, unknown> }[]>(`SELECT course_key,title,
      credit_units,attributes FROM curriculum.course_catalogue_entries
      WHERE catalogue_id=$1 ORDER BY course_key`, [id]);
    return { id: row.id, catalogueKey: row.catalogue_key, version: row.version, title: row.title,
      regulationId: row.regulation_id, entryManifestSha256: row.entry_manifest_sha256,
      status: row.status, recordVersion: row.record_version,
      policyDecisionReference: row.policy_decision_reference,
      publishedAt: row.published_at?.toISOString() ?? null,
      entries: entries.map((entry) => ({ courseKey: entry.course_key, title: entry.title,
        creditUnits: entry.credit_units, attributes: entry.attributes })) };
  }

  async createRequirementSet(input: CreateRequirementSetDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const clauses = [...input.clauses].sort((left, right) => left.sequence - right.sequence);
    if (new Set(clauses.map((item) => item.sequence)).size !== clauses.length) {
      throw new ConflictException('Requirement clause sequence values must be unique');
    }
    if ((input.requirementType === 'COURSE_ELIGIBILITY' && input.targetCourseKey === undefined)
      || (input.requirementType === 'DEGREE_AUDIT' && input.targetCourseKey !== undefined)) {
      throw new ConflictException('Requirement type and target course are not aligned');
    }
    const inputHash = hash({ ...input, clauses });
    return this.dataSource.transaction(async (manager) => {
      const replay = await this.findReplay(manager, 'curriculum.requirement_sets',
        input.idempotencyKey, inputHash);
      if (replay !== null) return replay;
      const aligned = await manager.query<readonly { programme_scope_type: string;
        programme_scope_id: string; catalogue_scope_type: string; catalogue_scope_id: string;
        target_exists: boolean }[]>(`SELECT p.scope_type programme_scope_type,p.scope_id programme_scope_id,
          c.scope_type catalogue_scope_type,c.scope_id catalogue_scope_id,
          ($3::text IS NULL OR EXISTS (SELECT 1 FROM curriculum.course_catalogue_entries e
            WHERE e.catalogue_id=c.id AND e.course_key=$3)) target_exists
        FROM curriculum.programme_versions p CROSS JOIN curriculum.course_catalogues c
        WHERE p.id=$1 AND p.status='PUBLISHED' AND c.id=$2 AND c.status='PUBLISHED'`,
      [input.programmeVersionId, input.catalogueId, input.targetCourseKey ?? null]);
      const row = aligned[0];
      if (row?.programme_scope_type !== input.scopeType || row.programme_scope_id !== input.scopeId
        || row.catalogue_scope_type !== input.scopeType || row.catalogue_scope_id !== input.scopeId
        || !row.target_exists) {
        throw new ConflictException('Published programme, catalogue, target course, and scope must align');
      }
      const id = randomUUID();
      try {
        const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO curriculum.requirement_sets
          (id,requirement_key,version,title,requirement_type,programme_version_id,catalogue_id,
           target_course_key,evaluation_contract_version,input_sha256,clause_manifest_sha256,
           idempotency_key,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [id,
          input.requirementKey, input.version, input.title, input.requirementType,
          input.programmeVersionId, input.catalogueId, input.targetCourseKey ?? null,
          input.evaluationContractVersion, inputHash, '0'.repeat(64), input.idempotencyKey,
          input.scopeType, input.scopeId, actor.subjectId]);
        if (inserted[0] === undefined) return this.resolveConcurrentReplay(manager,
          'curriculum.requirement_sets', input.idempotencyKey, inputHash,
          'Requirement set idempotency key already exists');
      } catch (error) {
        if (isUnique(error)) throw new ConflictException('Requirement set version already exists');
        throw error;
      }
      for (const clause of clauses) {
        await manager.query(`INSERT INTO curriculum.requirement_clauses
          (requirement_set_id,clause_key,sequence,clause_type,title,rule_document)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [id, clause.clauseKey, clause.sequence,
          clause.clauseType, clause.title, JSON.stringify(clause.ruleDocument)]);
      }
      await manager.query(`UPDATE curriculum.requirement_sets r SET clause_manifest_sha256=x.manifest
        FROM (SELECT encode(digest(string_agg(jsonb_build_object('clauseKey',clause_key,
          'sequence',sequence,'clauseType',clause_type,'title',title,'ruleDocument',rule_document)::text,
          ',' ORDER BY sequence),'sha256'),'hex') manifest FROM curriculum.requirement_clauses
          WHERE requirement_set_id=$1) x WHERE r.id=$1`, [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.requirements.drafted', resourceType: 'curriculum-requirement-set',
        resourceId: id, details: { requirementKey: input.requirementKey, version: input.version,
          requirementType: input.requirementType, programmeVersionId: input.programmeVersionId,
          catalogueId: input.catalogueId, targetCourseKey: input.targetCourseKey ?? null,
          clauseCount: clauses.length, evaluationContractVersion: input.evaluationContractVersion } });
      return { id, replayed: false };
    });
  }

  async publishRequirementSet(id: string, input: PublishCurriculumConfigurationDto,
    actor: Principal): Promise<void> {
    this.assertGate('CURRICULUM_REQUIREMENT_PUBLICATION_ENABLED',
      'Curriculum requirement publication is disabled pending NIET academic approval');
    await this.dataSource.transaction(async (manager) => {
      const requirement = await this.lockConfiguration(manager, 'curriculum.requirement_sets', id,
        'Curriculum requirement set not found');
      this.policy.assertScope(actor, requirement.scope_type, requirement.scope_id);
      this.assertPublicationState(requirement, input.expectedRecordVersion, actor);
      await manager.query(`UPDATE curriculum.requirement_sets SET status='PUBLISHED',
        record_version=record_version+1,policy_decision_reference=$2,published_by=$3,
        published_at=clock_timestamp() WHERE id=$1`,
      [id, input.policyDecisionReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.requirements.published', resourceType: 'curriculum-requirement-set',
        resourceId: id, details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'CurriculumRequirementSetPublished',
        aggregateType: 'curriculum-requirement-set', aggregateId: id, classification: 'INTERNAL',
        payload: { requirementSetId: id } });
    });
  }

  async getRequirementSet(id: string, actor: Principal): Promise<CurriculumRequirementSet> {
    const rows = await this.dataSource.query<readonly RequirementSetRow[]>(
      'SELECT * FROM curriculum.requirement_sets WHERE id=$1', [id]);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException('Curriculum requirement set not found');
    this.policy.assertScope(actor, row.scope_type, row.scope_id);
    const clauses = await this.dataSource.query<readonly { clause_key: string; sequence: number;
      clause_type: string; title: string; rule_document: Record<string, unknown> }[]>(`SELECT
      clause_key,sequence,clause_type,title,rule_document FROM curriculum.requirement_clauses
      WHERE requirement_set_id=$1 ORDER BY sequence`, [id]);
    return { id: row.id, requirementKey: row.requirement_key, version: row.version, title: row.title,
      requirementType: row.requirement_type, programmeVersionId: row.programme_version_id,
      catalogueId: row.catalogue_id, targetCourseKey: row.target_course_key,
      evaluationContractVersion: row.evaluation_contract_version,
      clauseManifestSha256: row.clause_manifest_sha256, status: row.status,
      recordVersion: row.record_version, policyDecisionReference: row.policy_decision_reference,
      publishedAt: row.published_at?.toISOString() ?? null,
      clauses: clauses.map((clause) => ({ clauseKey: clause.clause_key, sequence: clause.sequence,
        clauseType: clause.clause_type, title: clause.title, ruleDocument: clause.rule_document })) };
  }

  async evaluate(input: CreateRequirementEvaluationDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const clauseResults = [...input.clauseResults]
      .sort((left, right) => left.clauseKey.localeCompare(right.clauseKey));
    const inputHash = hash({ ...input, clauseResults });
    return this.dataSource.transaction(async (manager) => {
      const replay = await this.findReplay(manager, 'curriculum.requirement_evaluations',
        input.idempotencyKey, inputHash);
      if (replay !== null) return replay;
      this.assertGate('CURRICULUM_REQUIREMENT_EVALUATION_ENABLED',
        'Curriculum requirement evaluation is disabled pending NIET academic approval');
      const aligned = await manager.query<readonly { requirement_type: string; scope_type: string;
        scope_id: string; student_scope_type: string; student_scope_id: string }[]>(`SELECT
        r.requirement_type,r.scope_type,r.scope_id,s.scope_type student_scope_type,
        s.scope_id student_scope_id FROM curriculum.requirement_sets r CROSS JOIN student.records s
        WHERE r.id=$1 AND r.status='PUBLISHED' AND s.id=$2`, [input.requirementSetId, input.studentId]);
      const row = aligned[0];
      if (row?.scope_type !== input.scopeType || row.scope_id !== input.scopeId
        || row.student_scope_type !== input.scopeType || row.student_scope_id !== input.scopeId) {
        throw new ConflictException('Published requirement set and student must share the evaluation scope');
      }
      if ((row.requirement_type === 'COURSE_ELIGIBILITY' && input.evaluationMode !== 'REGISTRATION')
        || (row.requirement_type === 'DEGREE_AUDIT' && input.evaluationMode === 'REGISTRATION')) {
        throw new ConflictException('Requirement type and evaluation mode are not aligned');
      }
      const clauses = await manager.query<readonly { clause_key: string }[]>(`SELECT clause_key
        FROM curriculum.requirement_clauses WHERE requirement_set_id=$1 ORDER BY clause_key`,
      [input.requirementSetId]);
      if (JSON.stringify(clauses.map((item) => item.clause_key))
        !== JSON.stringify(clauseResults.map((item) => item.clauseKey))) {
        throw new ConflictException('Evaluation must contain exactly one result for every published clause');
      }
      const id = randomUUID();
      try {
        const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO curriculum.requirement_evaluations
          (id,requirement_set_id,student_id,evaluation_mode,candidate_manifest_sha256,
           source_evidence_manifest_sha256,result,result_manifest_sha256,evaluator_engine,
           evaluator_version,policy_reference,evaluation_trace,explanation_summary,input_sha256,
           idempotency_key,scope_type,scope_id,evaluated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [id, input.requirementSetId, input.studentId, input.evaluationMode,
          input.candidateManifestSha256, input.sourceEvidenceManifestSha256, input.result,
          '0'.repeat(64), input.evaluatorEngine, input.evaluatorVersion, input.policyReference,
          JSON.stringify(input.evaluationTrace), input.explanationSummary, inputHash,
          input.idempotencyKey, input.scopeType, input.scopeId, actor.subjectId]);
        if (inserted[0] === undefined) return this.resolveConcurrentReplay(manager,
          'curriculum.requirement_evaluations', input.idempotencyKey, inputHash,
          'Requirement evaluation idempotency key already exists');
      } catch (error) {
        if (isUnique(error)) throw new ConflictException('Requirement evaluation already exists');
        throw error;
      }
      for (const result of clauseResults) {
        await manager.query(`INSERT INTO curriculum.requirement_evaluation_results
          (evaluation_id,clause_key,outcome,evidence_reference,explanation,evidence_trace)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [id, result.clauseKey, result.outcome,
          result.evidenceReference, result.explanation, JSON.stringify(result.evidenceTrace)]);
      }
      await manager.query(`UPDATE curriculum.requirement_evaluations e SET result_manifest_sha256=x.manifest
        FROM (SELECT encode(digest(string_agg(jsonb_build_object('clauseKey',r.clause_key,
          'outcome',r.outcome,'evidenceReference',r.evidence_reference,'explanation',r.explanation,
          'evidenceTrace',r.evidence_trace)::text,',' ORDER BY c.sequence),'sha256'),'hex') manifest
          FROM curriculum.requirement_evaluation_results r JOIN curriculum.requirement_clauses c
            ON c.requirement_set_id=$2 AND c.clause_key=r.clause_key WHERE r.evaluation_id=$1) x
        WHERE e.id=$1`, [id, input.requirementSetId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.requirements.evaluated', resourceType: 'curriculum-requirement-evaluation',
        resourceId: id, details: { requirementSetId: input.requirementSetId,
          studentId: input.studentId, evaluationMode: input.evaluationMode, result: input.result,
          evaluatorEngine: input.evaluatorEngine, evaluatorVersion: input.evaluatorVersion,
          policyReference: input.policyReference, clauseCount: clauseResults.length } });
      await this.evidence.outbox(manager, { eventType: 'CurriculumRequirementEvaluated',
        aggregateType: 'curriculum-requirement-evaluation', aggregateId: id,
        classification: 'CONFIDENTIAL', payload: { requirementEvaluationId: id,
          requirementSetId: input.requirementSetId, studentId: input.studentId, result: input.result } });
      return { id, replayed: false };
    });
  }

  async getEvaluation(id: string, actor: Principal): Promise<RequirementEvaluation> {
    const rows = await this.dataSource.query<readonly EvaluationRow[]>(
      'SELECT * FROM curriculum.requirement_evaluations WHERE id=$1', [id]);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException('Curriculum requirement evaluation not found');
    this.policy.assertScope(actor, row.scope_type, row.scope_id);
    const results = await this.dataSource.query<readonly { clause_key: string; outcome: string;
      evidence_reference: string; explanation: string; evidence_trace: Record<string, unknown> }[]>(`SELECT
      r.* FROM curriculum.requirement_evaluation_results r JOIN curriculum.requirement_clauses c
        ON c.requirement_set_id=$2 AND c.clause_key=r.clause_key
      WHERE r.evaluation_id=$1 ORDER BY c.sequence`, [id, row.requirement_set_id]);
    return { id: row.id, requirementSetId: row.requirement_set_id, studentId: row.student_id,
      evaluationMode: row.evaluation_mode, candidateManifestSha256: row.candidate_manifest_sha256,
      sourceEvidenceManifestSha256: row.source_evidence_manifest_sha256, result: row.result,
      resultManifestSha256: row.result_manifest_sha256, evaluatorEngine: row.evaluator_engine,
      evaluatorVersion: row.evaluator_version, policyReference: row.policy_reference,
      evaluationTrace: row.evaluation_trace, explanationSummary: row.explanation_summary,
      evaluatedBy: row.evaluated_by, evaluatedAt: row.evaluated_at.toISOString(),
      clauseResults: results.map((item) => ({ clauseKey: item.clause_key, outcome: item.outcome,
        evidenceReference: item.evidence_reference, explanation: item.explanation,
        evidenceTrace: item.evidence_trace })) };
  }

  private async findReplay(manager: EntityManager, table: string, idempotencyKey: string,
    inputHash: string): Promise<{ id: string; replayed: boolean } | null> {
    const rows = await manager.query<readonly { id: string; input_sha256: string }[]>(
      `SELECT id,input_sha256 FROM ${table} WHERE idempotency_key=$1`, [idempotencyKey]);
    if (rows[0] === undefined) return null;
    if (rows[0].input_sha256 !== inputHash) {
      throw new ConflictException('Curriculum idempotency key already has different content');
    }
    return { id: rows[0].id, replayed: true };
  }

  private async resolveConcurrentReplay(manager: EntityManager, table: string, idempotencyKey: string,
    inputHash: string, conflictMessage: string): Promise<{ id: string; replayed: boolean }> {
    const replay = await this.findReplay(manager, table, idempotencyKey, inputHash);
    if (replay !== null) return replay;
    throw new ConflictException(conflictMessage);
  }

  private async lockConfiguration(manager: EntityManager, table: string, id: string,
    notFoundMessage: string): Promise<ConfigurationRow> {
    const rows = await manager.query<readonly ConfigurationRow[]>(
      `SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    if (rows[0] === undefined) throw new NotFoundException(notFoundMessage);
    return rows[0];
  }

  private assertPublicationState(row: ConfigurationRow, expectedVersion: number, actor: Principal): void {
    if (row.created_by === actor.subjectId) throw new ForbiddenException('Configuration creator cannot publish it');
    if (row.status !== 'DRAFT' || row.record_version !== expectedVersion) {
      throw new ConflictException('Curriculum configuration is not the expected draft version');
    }
  }

  private assertGate(key: 'CURRICULUM_CATALOGUE_PUBLICATION_ENABLED'
    | 'CURRICULUM_REQUIREMENT_PUBLICATION_ENABLED' | 'CURRICULUM_REQUIREMENT_EVALUATION_ENABLED',
  message: string): void {
    if (!this.config.get(key, { infer: true })) throw new ForbiddenException(message);
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { ActivateProgrammeEnrolmentDto, AssignProgrammeDto, CreateProgrammeVersionDto,
  PublishProgrammeVersionDto } from './programmes.dto';
interface ProgrammeRow { id: string; regulation_id: string; status: string; record_version: number;
  scope_type: string; scope_id: string }
interface EnrolmentRow { id: string; student_id: string; programme_version_id: string; status: string;
  version: number; scope_type: string; scope_id: string; assigned_by: string }
@Injectable()
export class ProgrammesService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateProgrammeVersionDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const regulations = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      "SELECT scope_type,scope_id FROM curriculum.regulation_versions WHERE id=$1 AND status='PUBLISHED'",
    [input.regulationId]);
    if (regulations[0]?.scope_type !== input.scopeType || regulations[0]?.scope_id !== input.scopeId) {
      throw new ConflictException('A published regulation in the same scope is required');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO curriculum.programme_versions
          (id,programme_key,version,title,regulation_id,structure_manifest_sha256,
           scope_type,scope_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, input.programmeKey, input.version, input.title, input.regulationId,
          input.structureManifestSha256, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwConflict(error, 'Programme version already exists'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'programme.version.drafted', resourceType: 'programme-version', resourceId: id,
        details: { programmeKey: input.programmeKey, version: input.version,
          regulationId: input.regulationId, structureManifestSha256: input.structureManifestSha256 } });
    });
    return { id };
  }
  async publish(id: string, input: PublishProgrammeVersionDto, actor: Principal): Promise<void> {
    if (!this.config.get('ACADEMIC_POLICY_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Programme publication is disabled pending NIET academic approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const programme = await this.lockProgramme(manager, id);
      this.policy.assertScope(actor, programme.scope_type, programme.scope_id);
      if (programme.status !== 'DRAFT' || programme.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Programme is not the expected draft version');
      }
      await manager.query(`UPDATE curriculum.programme_versions SET status='PUBLISHED',
        record_version=record_version+1,published_by=$2,published_at=clock_timestamp(),
        policy_decision_reference=$3 WHERE id=$1`, [id, actor.subjectId, input.policyDecisionReference]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'programme.version.published', resourceType: 'programme-version', resourceId: id,
        details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'ProgrammePublished',
        aggregateType: 'programme-version', aggregateId: id, classification: 'INTERNAL',
        payload: { programmeVersionId: id, regulationId: programme.regulation_id } });
    });
  }
  async assign(input: AssignProgrammeDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (input.endsOn !== undefined && input.endsOn < input.startsOn) {
      throw new ConflictException('Programme enrolment end cannot precede start');
    }
    const aligned = await this.dataSource.query<readonly { student_scope_type: string;
      student_scope_id: string; programme_scope_type: string; programme_scope_id: string }[]>(`SELECT
      s.scope_type student_scope_type,s.scope_id student_scope_id,p.scope_type programme_scope_type,
      p.scope_id programme_scope_id FROM student.records s CROSS JOIN curriculum.programme_versions p
      WHERE s.id=$1 AND p.id=$2 AND p.status='PUBLISHED'`, [input.studentId, input.programmeVersionId]);
    const row = aligned[0];
    if (row?.student_scope_type !== input.scopeType || row.student_scope_id !== input.scopeId
      || row.programme_scope_type !== input.scopeType || row.programme_scope_id !== input.scopeId) {
      throw new ConflictException('Student and published programme must share the requested scope');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO student.programme_enrolments
          (id,student_id,programme_version_id,starts_on,ends_on,assignment_engine,
           assignment_version,assignment_trace,scope_type,scope_id,assigned_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, [id, input.studentId,
          input.programmeVersionId, input.startsOn, input.endsOn ?? null, input.assignmentEngine,
          input.assignmentVersion, JSON.stringify(input.assignmentTrace), input.scopeType,
          input.scopeId, actor.subjectId]);
      } catch (error) { throwConflict(error, 'Programme enrolment overlaps existing student history'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'programme.enrolment.assigned', resourceType: 'programme-enrolment', resourceId: id,
        details: { studentId: input.studentId, programmeVersionId: input.programmeVersionId,
          assignmentEngine: input.assignmentEngine, assignmentVersion: input.assignmentVersion } });
    });
    return { id };
  }
  async activate(id: string, input: ActivateProgrammeEnrolmentDto, actor: Principal): Promise<void> {
    if (!this.config.get('PROGRAMME_ENROLMENT_ACTIVATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Programme enrolment activation is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly EnrolmentRow[]>(
        'SELECT * FROM student.programme_enrolments WHERE id=$1 FOR UPDATE', [id]);
      const enrolment = rows[0];
      if (enrolment === undefined) throw new NotFoundException('Programme enrolment not found');
      this.policy.assertScope(actor, enrolment.scope_type, enrolment.scope_id);
      if (enrolment.assigned_by === actor.subjectId) {
        throw new ForbiddenException('Programme enrolment assigner cannot activate it');
      }
      if (enrolment.status !== 'PROVISIONAL' || enrolment.version !== input.expectedVersion) {
        throw new ConflictException('Programme enrolment is not the expected provisional version');
      }
      await manager.query(`UPDATE student.programme_enrolments SET status='ACTIVE',version=version+1,
        activated_by=$2,activated_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'programme.enrolment.activated', resourceType: 'programme-enrolment', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'ProgrammeEnrolmentActivated',
        aggregateType: 'programme-enrolment', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { programmeEnrolmentId: id, studentId: enrolment.student_id,
          programmeVersionId: enrolment.programme_version_id } });
    });
  }
  private async lockProgramme(manager: { query: DataSource['query'] }, id: string): Promise<ProgrammeRow> {
    const rows = await manager.query<readonly ProgrammeRow[]>(
      'SELECT * FROM curriculum.programme_versions WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Programme version not found');
    return rows[0];
  }
}
function throwConflict(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === '23505' || error.code === '23P01')) throw new ConflictException(message);
  throw error;
}

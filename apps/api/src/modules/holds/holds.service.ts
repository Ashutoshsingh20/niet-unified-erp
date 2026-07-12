import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { ActivateStudentHoldDto, ProposeStudentHoldDto, ReleaseStudentHoldDto } from './holds.dto';
interface HoldRow { id: string; student_id: string; effect: string; status: string; version: number;
  scope_type: string; scope_id: string; raised_by: string }
@Injectable()
export class HoldsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async propose(input: ProposeStudentHoldDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const students = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      'SELECT scope_type,scope_id FROM student.records WHERE id=$1', [input.studentId]);
    if (students[0]?.scope_type !== input.scopeType || students[0]?.scope_id !== input.scopeId) {
      throw new ConflictException('Student and hold scope are not aligned');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO student.holds
          (id,student_id,hold_key,effect,policy_reference,reason,evidence_reference,
           scope_type,scope_id,raised_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, input.studentId, input.holdKey, input.effect, input.policyReference, input.reason,
          input.evidenceReference, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'An unreleased hold already exists for this key and effect'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'student.hold.proposed', resourceType: 'student-hold', resourceId: id,
        details: { studentId: input.studentId, holdKey: input.holdKey, effect: input.effect,
          policyReference: input.policyReference } });
    });
    return { id };
  }
  async activate(id: string, input: ActivateStudentHoldDto, actor: Principal): Promise<void> {
    this.assertEnabled();
    await this.dataSource.transaction(async (manager) => {
      const hold = await this.lock(manager, id);
      this.policy.assertScope(actor, hold.scope_type, hold.scope_id);
      if (hold.raised_by === actor.subjectId) throw new ForbiddenException('Hold proposer cannot activate it');
      if (hold.status !== 'PROPOSED' || hold.version !== input.expectedVersion) {
        throw new ConflictException('Student hold is not the expected proposed version');
      }
      await manager.query(`UPDATE student.holds SET status='ACTIVE',version=version+1,
        activated_by=$2,activated_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'student.hold.activated', resourceType: 'student-hold', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'StudentHoldActivated',
        aggregateType: 'student-hold', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { studentHoldId: id, studentId: hold.student_id } });
    });
  }
  async release(id: string, input: ReleaseStudentHoldDto, actor: Principal): Promise<void> {
    this.assertEnabled();
    await this.dataSource.transaction(async (manager) => {
      const hold = await this.lock(manager, id);
      this.policy.assertScope(actor, hold.scope_type, hold.scope_id);
      if (hold.raised_by === actor.subjectId) throw new ForbiddenException('Hold proposer cannot release it');
      if (hold.status !== 'ACTIVE' || hold.version !== input.expectedVersion) {
        throw new ConflictException('Student hold is not the expected active version');
      }
      await manager.query(`INSERT INTO student.hold_releases
        (id,hold_id,reason,evidence_reference,released_by) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), id, input.reason, input.evidenceReference, actor.subjectId]);
      await manager.query(`UPDATE student.holds SET status='RELEASED',version=version+1,
        released_at=clock_timestamp() WHERE id=$1`, [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'student.hold.released', resourceType: 'student-hold', resourceId: id,
        details: { releaseEvidenceReference: input.evidenceReference } });
      await this.evidence.outbox(manager, { eventType: 'StudentHoldReleased',
        aggregateType: 'student-hold', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { studentHoldId: id, studentId: hold.student_id } });
    });
  }
  private assertEnabled(): void {
    if (!this.config.get('STUDENT_HOLD_ENFORCEMENT_ENABLED', { infer: true })) {
      throw new ForbiddenException('Student hold activation and enforcement are disabled pending NIET policy approval');
    }
  }
  private async lock(manager: { query: DataSource['query'] }, id: string): Promise<HoldRow> {
    const rows = await manager.query<readonly HoldRow[]>('SELECT * FROM student.holds WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Student hold not found');
    return rows[0];
  }
}
function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

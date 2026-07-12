import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { ApproveAttendanceCorrectionDto, CreateTeachingSessionDto, FinalizeAttendanceDto,
  RecordAttendanceObservationDto, RequestAttendanceCorrectionDto,
  VersionedSessionCommandDto } from './attendance.dto';

type PresenceState = RecordAttendanceObservationDto['presenceState'];
interface SessionRow { id: string; offering_id: string; scope_type: string; scope_id: string;
  status: string; version: number }
interface CorrectionRequestRow { id: string; session_id: string; student_id: string;
  proposed_state: PresenceState; reason: string; evidence_reference: string; status: string;
  version: number; requested_by: string }

@Injectable()
export class AttendanceService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async createSession(input: CreateTeachingSessionDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new ConflictException('Teaching session end must be after its start');
    }
    const offerings = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      "SELECT scope_type,scope_id FROM registration.offerings WHERE id=$1 AND status='PUBLISHED'",
      [input.offeringId]);
    const offering = offerings[0];
    if (offering === undefined || offering.scope_type !== input.scopeType || offering.scope_id !== input.scopeId) {
      throw new ConflictException('A published offering in the same scope is required');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO teaching.sessions
          (id,offering_id,session_key,starts_at,ends_at,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, input.offeringId, input.sessionKey,
          input.startsAt, input.endsAt, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Teaching session key already exists for this offering'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.session.planned', resourceType: 'teaching-session', resourceId: id,
        details: { offeringId: input.offeringId, scopeType: input.scopeType, scopeId: input.scopeId } });
    });
    return { id };
  }

  async openSession(id: string, input: VersionedSessionCommandDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const session = await this.lockSession(manager, id);
      this.policy.assertScope(actor, session.scope_type, session.scope_id);
      if (session.status !== 'PLANNED' || session.version !== input.expectedVersion) {
        throw new ConflictException('Teaching session is not the expected planned version');
      }
      await manager.query(`UPDATE teaching.sessions SET status='OPEN',version=version+1,
        opened_by=$2,opened_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.session.opened', resourceType: 'teaching-session', resourceId: id });
    });
  }

  async recordObservation(sessionId: string, input: RecordAttendanceObservationDto,
    actor: Principal): Promise<{ id: string }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.lockSession(manager, sessionId);
      this.policy.assertScope(actor, session.scope_type, session.scope_id);
      if (session.status !== 'OPEN') throw new ConflictException('Attendance can be recorded only in an open session');
      const roster = await manager.query<readonly { allowed: boolean }[]>(`SELECT EXISTS(
        SELECT 1 FROM registration.requests r JOIN registration.request_items i ON i.request_id=r.id
        WHERE r.student_id=$1 AND i.offering_id=$2 AND r.status='CONFIRMED') allowed`,
      [input.studentId, session.offering_id]);
      if (roster[0]?.allowed !== true) throw new ConflictException('Student is not confirmed in this offering');
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO teaching.attendance_observations
          (id,session_id,student_id,presence_state,source_kind,source_reference,
           observed_at,evidence,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [id, sessionId, input.studentId, input.presenceState, input.sourceKind,
          input.sourceReference ?? null, input.observedAt, JSON.stringify(input.evidence), actor.subjectId]);
      } catch (error) { throwUnique(error, 'Attendance observation already exists for this student and session'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.observation.recorded', resourceType: 'attendance-observation', resourceId: id,
        details: { sessionId, studentId: input.studentId, presenceState: input.presenceState,
          sourceKind: input.sourceKind } });
      return { id };
    });
  }

  async finalize(id: string, input: FinalizeAttendanceDto, actor: Principal): Promise<void> {
    if (!this.config.get('ATTENDANCE_FINALIZATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Attendance finalization is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const session = await this.lockSession(manager, id);
      this.policy.assertScope(actor, session.scope_type, session.scope_id);
      if (session.status !== 'OPEN' || session.version !== input.expectedVersion) {
        throw new ConflictException('Teaching session is not the expected open version');
      }
      const roster = await manager.query<readonly { student_id: string }[]>(`SELECT DISTINCT r.student_id
        FROM registration.requests r JOIN registration.request_items i ON i.request_id=r.id
        WHERE i.offering_id=$1 AND r.status='CONFIRMED' ORDER BY r.student_id`, [session.offering_id]);
      if (roster.length === 0) throw new ConflictException('A teaching session cannot finalize an empty roster');
      const observations = await manager.query<readonly { student_id: string; presence_state: PresenceState;
        observed_at: Date }[]>(`SELECT student_id,presence_state,observed_at
        FROM teaching.attendance_observations WHERE session_id=$1 ORDER BY student_id`, [id]);
      if (JSON.stringify(roster.map((row) => row.student_id))
        !== JSON.stringify(observations.map((row) => row.student_id))) {
        throw new ConflictException('Every confirmed student requires exactly one observation');
      }
      const hash = createHash('sha256').update(observations.map((row) =>
        `${row.student_id}:${row.presence_state}:${row.observed_at.toISOString()}`).join('\n')).digest('hex');
      await manager.query(`UPDATE teaching.sessions SET status='FINALIZED',version=version+1,
        finalized_by=$2,finalized_at=clock_timestamp(),finalization_reason=$3,
        observation_set_sha256=$4 WHERE id=$1`, [id, actor.subjectId, input.reason, hash]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.session.finalized', resourceType: 'teaching-session', resourceId: id,
        details: { observationCount: observations.length, observationSetSha256: hash } });
      await this.evidence.outbox(manager, { eventType: 'AttendanceFinalized',
        aggregateType: 'teaching-session', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { teachingSessionId: id } });
    });
  }

  async requestCorrection(sessionId: string, input: RequestAttendanceCorrectionDto,
    actor: Principal): Promise<{ id: string }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.lockSession(manager, sessionId);
      this.policy.assertScope(actor, session.scope_type, session.scope_id);
      if (session.status !== 'FINALIZED') throw new ConflictException('Only finalized attendance can be corrected');
      const current = await effectiveState(manager, sessionId, input.studentId);
      if (current === undefined) throw new NotFoundException('Attendance observation not found');
      if (current === input.proposedState) throw new ConflictException('Correction must change the effective state');
      const pending = await manager.query<readonly { exists: boolean }[]>(`SELECT EXISTS(
        SELECT 1 FROM teaching.attendance_correction_requests
        WHERE session_id=$1 AND student_id=$2 AND status='PENDING') exists`, [sessionId, input.studentId]);
      if (pending[0]?.exists === true) throw new ConflictException('A correction is already pending for this student');
      const id = randomUUID();
      await manager.query(`INSERT INTO teaching.attendance_correction_requests
        (id,session_id,student_id,proposed_state,reason,evidence_reference,requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, sessionId, input.studentId, input.proposedState,
        input.reason, input.evidenceReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.correction.requested', resourceType: 'attendance-correction-request',
        resourceId: id, details: { sessionId, studentId: input.studentId } });
      return { id };
    });
  }

  async approveCorrection(id: string, input: ApproveAttendanceCorrectionDto,
    actor: Principal): Promise<void> {
    if (!this.config.get('ATTENDANCE_CORRECTION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Attendance correction is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const requests = await manager.query<readonly CorrectionRequestRow[]>(
        'SELECT * FROM teaching.attendance_correction_requests WHERE id=$1 FOR UPDATE', [id]);
      const request = requests[0];
      if (request === undefined) throw new NotFoundException('Attendance correction request not found');
      const session = await this.lockSession(manager, request.session_id);
      this.policy.assertScope(actor, session.scope_type, session.scope_id);
      if (request.requested_by === actor.subjectId) throw new ForbiddenException('Requester cannot approve correction');
      if (request.status !== 'PENDING' || request.version !== input.expectedRequestVersion
        || session.status !== 'FINALIZED' || session.version !== input.expectedSessionVersion) {
        throw new ConflictException('Correction request or session changed concurrently');
      }
      const previous = await effectiveState(manager, request.session_id, request.student_id);
      if (previous === undefined || previous === request.proposed_state) {
        throw new ConflictException('Correction no longer changes the effective attendance state');
      }
      const sequences = await manager.query<readonly { sequence: number }[]>(
        `SELECT COALESCE(max(correction_sequence),0)::int+1 sequence
         FROM teaching.attendance_corrections WHERE session_id=$1 AND student_id=$2`,
      [request.session_id, request.student_id]);
      await manager.query(`INSERT INTO teaching.attendance_corrections
        (id,correction_request_id,session_id,student_id,previous_state,corrected_state,
         correction_sequence,reason,evidence_reference,requested_by,approved_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), id, request.session_id,
        request.student_id, previous, request.proposed_state, sequences[0]?.sequence ?? 1,
        request.reason, request.evidence_reference, request.requested_by, actor.subjectId]);
      await manager.query(`UPDATE teaching.attendance_correction_requests SET status='APPROVED',
        version=version+1,decided_by=$2,decided_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await manager.query('UPDATE teaching.sessions SET version=version+1 WHERE id=$1', [request.session_id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'attendance.correction.approved', resourceType: 'attendance-correction-request',
        resourceId: id, details: { sessionId: request.session_id, studentId: request.student_id } });
      await this.evidence.outbox(manager, { eventType: 'AttendanceCorrected',
        aggregateType: 'teaching-session', aggregateId: request.session_id, classification: 'CONFIDENTIAL',
        payload: { teachingSessionId: request.session_id } });
    });
  }

  private async lockSession(manager: { query: DataSource['query'] }, id: string): Promise<SessionRow> {
    const rows = await manager.query<readonly SessionRow[]>(
      'SELECT * FROM teaching.sessions WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Teaching session not found');
    return rows[0];
  }
}

async function effectiveState(manager: { query: DataSource['query'] }, sessionId: string,
  studentId: string): Promise<PresenceState | undefined> {
  const rows = await manager.query<readonly { state: PresenceState }[]>(`SELECT state FROM (
    SELECT corrected_state state,correction_sequence ordering FROM teaching.attendance_corrections
      WHERE session_id=$1 AND student_id=$2
    UNION ALL
    SELECT presence_state state,0 ordering FROM teaching.attendance_observations
      WHERE session_id=$1 AND student_id=$2
  ) states ORDER BY ordering DESC LIMIT 1`, [sessionId, studentId]);
  return rows[0]?.state;
}

function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

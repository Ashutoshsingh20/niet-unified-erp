import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateAcademicPeriodDto, CreateOfferingDto, DecideRegistrationDto,
  PromoteWaitlistDto, PublishAcademicPeriodDto, PublishOfferingDto, SubmitRegistrationDto,
  WithdrawRegistrationDto } from './registration.dto';

interface PeriodRow { id: string; status: string; record_version: number; scope_type: string; scope_id: string }
interface OfferingRow { id: string; period_id: string; status: string; record_version: number;
  scope_type: string; scope_id: string; capacity: number }
interface RequestRow { id: string; student_id: string; period_id: string; scope_type: string;
  scope_id: string; status: string; version: number; submitted_by: string; decided_by: string | null }
interface EligibilityRow { requested_credit_units: string; maximum_credit_units: string;
  adviser_required: boolean; adviser_approval_id: string | null; evaluation_engine: string;
  evaluation_version: string; policy_reference: string; evaluation_trace: Record<string, unknown> }

@Injectable()
export class RegistrationService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async createPeriod(input: CreateAcademicPeriodDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new ConflictException('Academic period end must be after its start');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO registration.academic_periods
          (id, period_key, version, title, starts_at, ends_at, scope_type, scope_id, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, input.periodKey, input.version, input.title,
          input.startsAt, input.endsAt, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Academic period version already exists'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.period.drafted', resourceType: 'academic-period', resourceId: id,
        details: { periodKey: input.periodKey, version: input.version,
          scopeType: input.scopeType, scopeId: input.scopeId } });
    });
    return { id };
  }

  async publishPeriod(id: string, input: PublishAcademicPeriodDto, actor: Principal): Promise<void> {
    this.assertAcademicPublicationEnabled();
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly PeriodRow[]>(
        'SELECT * FROM registration.academic_periods WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0];
      if (row === undefined) throw new NotFoundException('Academic period not found');
      this.policy.assertScope(actor, row.scope_type, row.scope_id);
      if (row.status !== 'DRAFT' || row.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Academic period is not the expected draft version');
      }
      await manager.query(`UPDATE registration.academic_periods SET status='PUBLISHED',
        record_version=record_version+1, policy_decision_reference=$2, published_by=$3,
        published_at=clock_timestamp() WHERE id=$1`, [id, input.policyDecisionReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.period.published', resourceType: 'academic-period', resourceId: id,
        details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'AcademicPeriodPublished',
        aggregateType: 'academic-period', aggregateId: id, classification: 'INTERNAL',
        payload: { academicPeriodId: id } });
    });
  }

  async createOffering(input: CreateOfferingDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const periods = await this.dataSource.query<readonly PeriodRow[]>(
      'SELECT * FROM registration.academic_periods WHERE id=$1', [input.periodId]);
    const period = periods[0];
    if (period === undefined) throw new NotFoundException('Academic period not found');
    if (period.scope_type !== input.scopeType || period.scope_id !== input.scopeId) {
      throw new ConflictException('Offering scope must match its academic period');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO registration.offerings
          (id,period_id,offering_key,course_key,title,capacity,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, input.periodId, input.offeringKey,
          input.courseKey, input.title, input.capacity, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Offering key already exists in the academic period'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.offering.drafted', resourceType: 'course-offering', resourceId: id,
        details: { periodId: input.periodId, offeringKey: input.offeringKey,
          courseKey: input.courseKey, capacity: input.capacity } });
    });
    return { id };
  }

  async publishOffering(id: string, input: PublishOfferingDto, actor: Principal): Promise<void> {
    this.assertAcademicPublicationEnabled();
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly OfferingRow[]>(
        `SELECT o.* FROM registration.offerings o JOIN registration.academic_periods p ON p.id=o.period_id
         WHERE o.id=$1 AND p.status='PUBLISHED' FOR UPDATE OF o`, [id]);
      const row = rows[0];
      if (row === undefined) throw new ConflictException('Offering or published period not found');
      this.policy.assertScope(actor, row.scope_type, row.scope_id);
      if (row.status !== 'DRAFT' || row.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Offering is not the expected draft version');
      }
      await manager.query(`UPDATE registration.offerings SET status='PUBLISHED',
        record_version=record_version+1,published_by=$2,published_at=clock_timestamp() WHERE id=$1`,
      [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.offering.published', resourceType: 'course-offering', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'CourseOfferingPublished',
        aggregateType: 'course-offering', aggregateId: id, classification: 'INTERNAL',
        payload: { courseOfferingId: id, academicPeriodId: row.period_id } });
    });
  }

  async submit(input: SubmitRegistrationDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const offeringIds = [...input.offeringIds].sort();
    return this.dataSource.transaction(async (manager) => {
      const prior = await manager.query<readonly { id: string }[]>(
        'SELECT id FROM registration.requests WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (prior[0] !== undefined) return this.resolveReplay(manager, input, offeringIds);
      const studentPeriod = await manager.query<readonly { student_scope_type: string;
        student_scope_id: string; period_scope_type: string; period_scope_id: string; status: string }[]>(
        `SELECT s.scope_type student_scope_type,s.scope_id student_scope_id,
                p.scope_type period_scope_type,p.scope_id period_scope_id,p.status
         FROM student.records s CROSS JOIN registration.academic_periods p
         WHERE s.id=$1 AND p.id=$2`, [input.studentId, input.periodId]);
      const ownership = studentPeriod[0];
      if (ownership === undefined) throw new NotFoundException('Student or academic period not found');
      if (ownership.status !== 'PUBLISHED' || ownership.student_scope_type !== input.scopeType
        || ownership.student_scope_id !== input.scopeId || ownership.period_scope_type !== input.scopeType
        || ownership.period_scope_id !== input.scopeId) {
        throw new ConflictException('Registration student, period, and scope are not aligned');
      }
      const submissionWindowId = this.config.get('REGISTRATION_WINDOW_ENFORCEMENT_ENABLED', { infer: true })
        ? await this.assertOpenWindow(manager, input.periodId, 'SUBMISSION', input.scopeType, input.scopeId)
        : null;
      if (this.config.get('STUDENT_HOLD_ENFORCEMENT_ENABLED', { infer: true })) {
        const holds = await manager.query<readonly { blocked: boolean }[]>(`SELECT EXISTS(
          SELECT 1 FROM student.holds WHERE student_id=$1 AND status='ACTIVE'
            AND effect='REGISTRATION_SUBMISSION') blocked`, [input.studentId]);
        if (holds[0]?.blocked === true) {
          throw new ConflictException('Registration submission is blocked by an active approved student hold');
        }
      }
      const offerings = await manager.query<readonly { id: string }[]>(
        `SELECT id FROM registration.offerings WHERE id=ANY($1::uuid[]) AND period_id=$2
         AND status='PUBLISHED' AND scope_type=$3 AND scope_id=$4 ORDER BY id`,
      [offeringIds, input.periodId, input.scopeType, input.scopeId]);
      if (offerings.length !== offeringIds.length) {
        throw new ConflictException('Every requested offering must be published in the selected period and scope');
      }
      const eligibilityRequired = this.config.get('REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED',
        { infer: true });
      if (eligibilityRequired && input.eligibilitySnapshot === undefined) {
        throw new ConflictException('A governed registration eligibility snapshot is required');
      }
      if (input.eligibilitySnapshot !== undefined) {
        this.assertEligibilityInput(input.eligibilitySnapshot);
        const conflicts = await this.countTimetableConflicts(manager, input.studentId, offeringIds);
        if (conflicts !== 0) {
          throw new ConflictException('Requested offerings conflict with the published student timetable');
        }
      }
      const id = randomUUID();
      const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO registration.requests
        (id,student_id,period_id,scope_type,scope_id,idempotency_key,submitted_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, input.studentId, input.periodId, input.scopeType, input.scopeId, input.idempotencyKey, actor.subjectId]);
      if (inserted[0] === undefined) return this.resolveReplay(manager, input, offeringIds);
      for (const offeringId of offeringIds) {
        await manager.query('INSERT INTO registration.request_items(request_id,offering_id) VALUES ($1,$2)',
          [id, offeringId]);
      }
      const snapshot = input.eligibilitySnapshot;
      if (snapshot !== undefined) {
        try {
          await manager.query(`INSERT INTO registration.request_eligibility_snapshots
            (request_id,requested_credit_units,maximum_credit_units,adviser_required,
             adviser_approval_id,timetable_conflict_count,evaluation_engine,evaluation_version,
             policy_reference,evaluation_trace,created_by)
            VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9::jsonb,$10)`, [id,
            snapshot.requestedCreditUnits, snapshot.maximumCreditUnits, snapshot.adviserRequired,
            snapshot.adviserApprovalId ?? null, snapshot.evaluationEngine, snapshot.evaluationVersion,
            snapshot.policyReference, JSON.stringify(snapshot.evaluationTrace), actor.subjectId]);
        } catch (error) {
          if (isDatabaseConstraint(error)) {
            throw new ConflictException('Registration eligibility evidence is not valid for this request');
          }
          throw error;
        }
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.request.submitted', resourceType: 'registration-request', resourceId: id,
        details: { studentId: input.studentId, periodId: input.periodId,
          offeringCount: offeringIds.length, registrationWindowId: submissionWindowId,
          eligibility: snapshot === undefined ? null : { requestedCreditUnits: snapshot.requestedCreditUnits,
            maximumCreditUnits: snapshot.maximumCreditUnits, adviserRequired: snapshot.adviserRequired,
            adviserApprovalId: snapshot.adviserApprovalId ?? null, timetableConflictCount: 0,
            evaluationEngine: snapshot.evaluationEngine, evaluationVersion: snapshot.evaluationVersion,
            policyReference: snapshot.policyReference } } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationRequested',
        aggregateType: 'registration-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationRequestId: id, studentId: input.studentId } });
      return { id, replayed: false };
    });
  }

  async decide(id: string, input: DecideRegistrationDto, actor: Principal): Promise<void> {
    if (!this.config.get('REGISTRATION_DECISION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Registration decisions are disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const requests = await manager.query<readonly RequestRow[]>(
        'SELECT * FROM registration.requests WHERE id=$1 FOR UPDATE', [id]);
      const request = requests[0];
      if (request === undefined) throw new NotFoundException('Registration request not found');
      this.policy.assertScope(actor, request.scope_type, request.scope_id);
      if (request.status !== 'PENDING' || request.version !== input.expectedVersion) {
        throw new ConflictException('Registration request is not the expected pending version');
      }
      const regulations = await manager.query<readonly { scope_type: string; scope_id: string }[]>(
        `SELECT scope_type,scope_id FROM curriculum.regulation_versions
         WHERE id=$1 AND status='PUBLISHED'`, [input.regulationId]);
      const regulation = regulations[0];
      if (regulation === undefined || regulation.scope_type !== request.scope_type
        || regulation.scope_id !== request.scope_id) {
        throw new ConflictException('A published regulation in the request scope is required');
      }
      if (input.outcome === 'CONFIRMED') await this.assertCapacity(manager, id);
      await manager.query(`UPDATE registration.requests SET status=$2,version=version+1,
        decided_by=$3,decided_at=clock_timestamp(),decision_reason=$4 WHERE id=$1`,
      [id, input.outcome, actor.subjectId, input.reason]);
      await manager.query(`INSERT INTO registration.decisions
        (id,request_id,outcome,regulation_id,evaluation_engine,evaluation_version,
         evaluation_trace,reason,decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [randomUUID(), id, input.outcome, input.regulationId, input.evaluationEngine,
        input.evaluationVersion, JSON.stringify(input.evaluationTrace), input.reason, actor.subjectId]);
      if (input.outcome === 'WAITLISTED') {
        await manager.query(`INSERT INTO registration.waitlist_entries
          (id,request_id,offering_id,student_id)
          SELECT gen_random_uuid(),i.request_id,i.offering_id,$2 FROM registration.request_items i
          WHERE i.request_id=$1`, [id, request.student_id]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.request.decided', resourceType: 'registration-request', resourceId: id,
        details: { outcome: input.outcome, regulationId: input.regulationId,
          evaluationEngine: input.evaluationEngine, evaluationVersion: input.evaluationVersion } });
      await this.evidence.outbox(manager, { eventType: `Registration${titleCase(input.outcome)}`,
        aggregateType: 'registration-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationRequestId: id, studentId: request.student_id } });
    });
  }

  async promote(id: string, input: PromoteWaitlistDto, actor: Principal): Promise<void> {
    if (!this.config.get('WAITLIST_PROMOTION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Waitlist promotion is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const requests = await manager.query<readonly RequestRow[]>(
        'SELECT * FROM registration.requests WHERE id=$1 FOR UPDATE', [id]);
      const request = requests[0];
      if (request === undefined) throw new NotFoundException('Registration request not found');
      this.policy.assertScope(actor, request.scope_type, request.scope_id);
      if (request.decided_by === actor.subjectId) {
        throw new ForbiddenException('Original waitlist decision maker cannot promote the request');
      }
      if (request.status !== 'WAITLISTED' || request.version !== input.expectedVersion) {
        throw new ConflictException('Registration request is not the expected waitlisted version');
      }
      await this.assertCapacity(manager, id);
      const target = await manager.query<readonly { id: string; offering_id: string }[]>(
        `SELECT id,offering_id FROM registration.waitlist_entries
         WHERE request_id=$1 AND status='WAITING' ORDER BY offering_id FOR UPDATE`, [id]);
      const all = await manager.query<readonly { id: string; offering_id: string }[]>(
        `SELECT id,offering_id FROM registration.waitlist_entries
         WHERE offering_id=ANY($1::uuid[]) AND status='WAITING'
         ORDER BY offering_id,created_at,id FOR UPDATE`, [target.map((row) => row.offering_id)]);
      const heads = new Map<string, string>();
      for (const row of all) if (!heads.has(row.offering_id)) heads.set(row.offering_id, row.id);
      if (target.length === 0 || target.some((row) => heads.get(row.offering_id) !== row.id)) {
        throw new ConflictException('Registration request is not first in every offering waitlist');
      }
      await manager.query(`INSERT INTO registration.waitlist_promotions
        (id,request_id,evaluation_engine,evaluation_version,evaluation_trace,reason,promoted_by)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [randomUUID(), id, input.evaluationEngine,
        input.evaluationVersion, JSON.stringify(input.evaluationTrace), input.reason, actor.subjectId]);
      await manager.query(`UPDATE registration.waitlist_entries SET status='PROMOTED',
        promoted_by=$2,promoted_at=clock_timestamp() WHERE request_id=$1 AND status='WAITING'`,
      [id, actor.subjectId]);
      await manager.query(`UPDATE registration.requests SET status='CONFIRMED',version=version+1,
        decision_reason=$2 WHERE id=$1`, [id, input.reason]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.waitlist.promoted', resourceType: 'registration-request', resourceId: id,
        details: { evaluationEngine: input.evaluationEngine, evaluationVersion: input.evaluationVersion } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationWaitlistPromoted',
        aggregateType: 'registration-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationRequestId: id, studentId: request.student_id } });
    });
  }

  async withdraw(id: string, input: WithdrawRegistrationDto, actor: Principal): Promise<void> {
    if (!this.config.get('REGISTRATION_WITHDRAWAL_ENABLED', { infer: true })) {
      throw new ForbiddenException('Registration withdrawal is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const requests = await manager.query<readonly RequestRow[]>(
        'SELECT * FROM registration.requests WHERE id=$1 FOR UPDATE', [id]);
      const request = requests[0];
      if (request === undefined) throw new NotFoundException('Registration request not found');
      this.policy.assertScope(actor, request.scope_type, request.scope_id);
      if (request.submitted_by !== actor.subjectId) {
        throw new ForbiddenException('Only the original requester can withdraw this registration');
      }
      if (!['CONFIRMED', 'WAITLISTED'].includes(request.status) || request.version !== input.expectedVersion) {
        throw new ConflictException('Registration request is not an expected withdrawable version');
      }
      const addDropWindowId = request.status === 'CONFIRMED'
        && this.config.get('REGISTRATION_WINDOW_ENFORCEMENT_ENABLED', { infer: true })
        ? await this.assertOpenWindow(manager, request.period_id, 'ADD_DROP',
          request.scope_type, request.scope_id) : null;
      await manager.query(`INSERT INTO registration.withdrawals
        (id,request_id,from_status,reason,withdrawn_by) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), id, request.status, input.reason, actor.subjectId]);
      if (request.status === 'WAITLISTED') {
        await manager.query(`UPDATE registration.waitlist_entries SET status='REMOVED'
          WHERE request_id=$1 AND status='WAITING'`, [id]);
      }
      await manager.query(`UPDATE registration.requests SET status='CANCELLED',version=version+1,
        decision_reason=$2 WHERE id=$1`, [id, input.reason]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.request.withdrawn', resourceType: 'registration-request', resourceId: id,
        details: { registrationWindowId: addDropWindowId, fromStatus: request.status } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationWithdrawn',
        aggregateType: 'registration-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationRequestId: id, studentId: request.student_id } });
    });
  }

  private assertAcademicPublicationEnabled(): void {
    if (!this.config.get('ACADEMIC_POLICY_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Academic configuration publication is disabled pending NIET approval');
    }
  }

  private async resolveReplay(manager: { query: DataSource['query'] }, input: SubmitRegistrationDto,
    offeringIds: readonly string[]): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly RequestRow[]>(
      'SELECT * FROM registration.requests WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    const items = row === undefined ? [] : await manager.query<readonly { offering_id: string }[]>(
      'SELECT offering_id FROM registration.request_items WHERE request_id=$1 ORDER BY offering_id', [row.id]);
    const eligibility = row === undefined ? [] : await manager.query<readonly EligibilityRow[]>(
      `SELECT requested_credit_units,maximum_credit_units,adviser_required,adviser_approval_id,
        evaluation_engine,evaluation_version,policy_reference,evaluation_trace
       FROM registration.request_eligibility_snapshots WHERE request_id=$1`, [row.id]);
    if (row !== undefined && row.student_id === input.studentId && row.period_id === input.periodId
      && row.scope_type === input.scopeType && row.scope_id === input.scopeId
      && JSON.stringify(items.map((item) => item.offering_id)) === JSON.stringify(offeringIds)
      && eligibilityMatches(eligibility[0], input.eligibilitySnapshot)) {
      return { id: row.id, replayed: true };
    }
    throw new ConflictException('Registration idempotency key already has different content');
  }

  private async assertCapacity(manager: { query: DataSource['query'] }, requestId: string): Promise<void> {
    const offerings = await manager.query<readonly { id: string; capacity: number }[]>(
      `SELECT o.id,o.capacity FROM registration.offerings o
       JOIN registration.request_items target ON target.offering_id=o.id AND target.request_id=$1
       ORDER BY o.id FOR UPDATE OF o`, [requestId]);
    const counts = await manager.query<readonly { id: string; confirmed: number }[]>(
      `SELECT o.id,count(r.id)::int confirmed FROM registration.offerings o
       JOIN registration.request_items target ON target.offering_id=o.id AND target.request_id=$1
       LEFT JOIN registration.request_items i ON i.offering_id=o.id
       LEFT JOIN registration.requests r ON r.id=i.request_id AND r.status='CONFIRMED'
       GROUP BY o.id ORDER BY o.id`, [requestId]);
    const confirmedById = new Map(counts.map((row) => [row.id, row.confirmed]));
    if (offerings.some((row) => (confirmedById.get(row.id) ?? 0) >= row.capacity)) {
      throw new ConflictException('One or more offerings have no remaining confirmed capacity');
    }
  }

  private assertEligibilityInput(snapshot: NonNullable<SubmitRegistrationDto['eligibilitySnapshot']>): void {
    if (Number(snapshot.requestedCreditUnits) > Number(snapshot.maximumCreditUnits)) {
      throw new ConflictException('Requested credit units exceed the governed maximum');
    }
    if (snapshot.adviserRequired !== (snapshot.adviserApprovalId !== undefined)) {
      throw new ConflictException('Adviser approval evidence does not match the governed requirement');
    }
  }

  private async countTimetableConflicts(manager: { query: DataSource['query'] }, studentId: string,
    offeringIds: readonly string[]): Promise<number> {
    const rows = await manager.query<readonly { conflict_count: number }[]>(`WITH requested AS (
        SELECT * FROM registration.timetable_meetings
        WHERE status='PUBLISHED' AND offering_id=ANY($2::uuid[])
      ), enrolled AS (
        SELECT m.* FROM registration.timetable_meetings m
        JOIN registration.request_items i ON i.offering_id=m.offering_id
        JOIN registration.requests r ON r.id=i.request_id
        WHERE r.student_id=$1 AND r.status='CONFIRMED' AND m.status='PUBLISHED'
      ), conflicts AS (
        SELECT a.id first_id,b.id second_id FROM requested a JOIN requested b
          ON a.id<b.id AND a.offering_id<>b.offering_id AND a.weekday=b.weekday
          AND int4range(a.start_minute,a.end_minute,'[)') && int4range(b.start_minute,b.end_minute,'[)')
        UNION
        SELECT a.id,b.id FROM requested a JOIN enrolled b
          ON a.offering_id<>b.offering_id AND a.weekday=b.weekday
          AND int4range(a.start_minute,a.end_minute,'[)') && int4range(b.start_minute,b.end_minute,'[)')
      ) SELECT count(*)::int conflict_count FROM conflicts`, [studentId, offeringIds]);
    return rows[0]?.conflict_count ?? 0;
  }

  private async assertOpenWindow(manager: { query: DataSource['query'] }, periodId: string,
    windowType: 'SUBMISSION' | 'ADD_DROP', scopeType: string, scopeId: string): Promise<string> {
    const rows = await manager.query<readonly { id: string }[]>(`SELECT id FROM registration.windows
      WHERE period_id=$1 AND window_type=$2 AND scope_type=$3 AND scope_id=$4 AND status='PUBLISHED'
        AND opens_at<=clock_timestamp() AND closes_at>clock_timestamp()`,
    [periodId, windowType, scopeType, scopeId]);
    if (rows[0] === undefined) {
      throw new ConflictException(`No approved ${windowType.toLowerCase().replace('_', '/')} window is open`);
    }
    return rows[0].id;
  }
}

function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function eligibilityMatches(row: EligibilityRow | undefined,
  input: SubmitRegistrationDto['eligibilitySnapshot']): boolean {
  if (row === undefined || input === undefined) return row === undefined && input === undefined;
  return Number(row.requested_credit_units) === Number(input.requestedCreditUnits)
    && Number(row.maximum_credit_units) === Number(input.maximumCreditUnits)
    && row.adviser_required === input.adviserRequired
    && row.adviser_approval_id === (input.adviserApprovalId ?? null)
    && row.evaluation_engine === input.evaluationEngine
    && row.evaluation_version === input.evaluationVersion
    && row.policy_reference === input.policyReference
    && canonicalJson(row.evaluation_trace) === canonicalJson(input.evaluationTrace);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isDatabaseConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['23503', '23514', 'P0001'].includes(String(error.code));
}

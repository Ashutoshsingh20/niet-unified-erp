import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateRegistrationAddDropDto, DecideRegistrationAddDropDto } from './registration-add-drop.dto';

interface BaseRequestRow { id: string; student_id: string; period_id: string; scope_type: string;
  scope_id: string; status: string }
interface ChangeRow { id: string; registration_request_id: string; student_id: string; period_id: string;
  scope_type: string; scope_id: string; before_manifest_sha256: string; after_manifest_sha256: string;
  status: string; version: number; requested_by: string }
interface SnapshotRow { requested_credit_units: string; maximum_credit_units: string;
  adviser_required: boolean; adviser_approval_id: string | null; timetable_conflict_count: number;
  timetable_manifest_sha256: string;
  evaluation_engine: string; evaluation_version: string; policy_reference: string;
  evaluation_trace: Record<string, unknown> }
interface AssignmentRow { offering_id: string; pool_id: string; entitlement_id: string }

@Injectable()
export class RegistrationAddDropService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async create(input: CreateRegistrationAddDropDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const before = [...input.beforeOfferingIds].sort();
    const after = [...input.afterOfferingIds].sort();
    return this.dataSource.transaction(async (manager) => {
      const prior = await manager.query<readonly { id: string }[]>(
        'SELECT id FROM registration.add_drop_requests WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (prior[0] !== undefined) return this.resolveReplay(manager, input, before, after);
      this.assertEnabled();
      if (sameValues(before, after)) throw new ConflictException('Add/drop request must change the offering set');
      const bases = await manager.query<readonly BaseRequestRow[]>(
        'SELECT * FROM registration.requests WHERE id=$1 FOR UPDATE', [input.registrationRequestId]);
      const base = bases[0];
      if (base === undefined) throw new NotFoundException('Confirmed registration request not found');
      this.policy.assertScope(actor, base.scope_type, base.scope_id);
      if (base.status !== 'CONFIRMED' || base.scope_type !== input.scopeType || base.scope_id !== input.scopeId) {
        throw new ConflictException('Add/drop requires a confirmed registration request in the supplied scope');
      }
      const current = await this.currentOfferingIds(manager, base.id);
      if (!sameValues(current, before)) {
        throw new ConflictException('Add/drop before manifest no longer matches the confirmed allocation');
      }
      const addDropWindowId = this.config.get('REGISTRATION_WINDOW_ENFORCEMENT_ENABLED', { infer: true })
        ? await this.assertOpenWindow(manager, base.period_id, base.scope_type, base.scope_id) : null;
      const offerings = await manager.query<readonly { id: string }[]>(`SELECT id FROM registration.offerings
        WHERE id=ANY($1::uuid[]) AND period_id=$2 AND status='PUBLISHED'
          AND scope_type=$3 AND scope_id=$4 ORDER BY id`,
      [after, base.period_id, base.scope_type, base.scope_id]);
      if (offerings.length !== after.length) {
        throw new ConflictException('Every resulting offering must be published in the registration period and scope');
      }
      const additions = after.filter((id) => !before.includes(id));
      const removals = before.filter((id) => !after.includes(id));
      const assignments = [...(input.capacityAssignments ?? [])]
        .sort((a, b) => a.offeringId.localeCompare(b.offeringId));
      if (new Set(assignments.map((item) => item.offeringId)).size !== assignments.length
        || assignments.some((item) => !additions.includes(item.offeringId))) {
        throw new ConflictException('Capacity assignments must uniquely match added offerings');
      }
      const snapshot = input.eligibilitySnapshot;
      this.assertEligibilityInput(snapshot);
      const timetableEvidence = await this.timetableEvidence(manager, after);
      const requiredOverrides = new Set<string>();
      if (Number(snapshot.requestedCreditUnits) > Number(snapshot.maximumCreditUnits)) {
        requiredOverrides.add('CREDIT_LIMIT');
      }
      if (snapshot.adviserRequired && snapshot.adviserApprovalId === undefined) {
        requiredOverrides.add('ADVISER_APPROVAL');
      }
      if (timetableEvidence.conflictCount > 0) requiredOverrides.add('TIMETABLE_CONFLICT');
      const overrideIds = [...(input.overrideAuthorizationIds ?? [])].sort();
      const authorizations = overrideIds.length === 0 ? [] : await manager.query<readonly {
        id: string; exception_type: string }[]>(`SELECT id,exception_type
          FROM registration.override_authorizations WHERE id=ANY($1::uuid[]) AND status='APPROVED'
            AND student_id=$2 AND period_id=$3 AND scope_type=$4 AND scope_id=$5
            AND offering_manifest_sha256=$6 ORDER BY id FOR UPDATE`,
      [overrideIds, base.student_id, base.period_id, base.scope_type, base.scope_id, manifestHash(after)]);
      const suppliedTypes = new Set(authorizations.map((row) => row.exception_type));
      if (authorizations.length !== overrideIds.length || suppliedTypes.size !== authorizations.length
        || [...requiredOverrides].some((type) => !suppliedTypes.has(type))
        || [...suppliedTypes].some((type) => type !== 'CAPACITY' && !requiredOverrides.has(type))) {
        throw new ConflictException('Approved overrides must exactly match detected add/drop exceptions');
      }
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO registration.add_drop_requests
          (id,registration_request_id,student_id,period_id,scope_type,scope_id,
           before_manifest_sha256,after_manifest_sha256,before_item_count,after_item_count,
           idempotency_key,requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, base.id, base.student_id, base.period_id, base.scope_type, base.scope_id,
          manifestHash(before), manifestHash(after), before.length, after.length, input.idempotencyKey,
          actor.subjectId]);
      } catch (error) {
        if (isUnique(error)) {
          const replay = await manager.query<readonly { id: string }[]>(
            'SELECT id FROM registration.add_drop_requests WHERE idempotency_key=$1', [input.idempotencyKey]);
          if (replay[0] !== undefined) return this.resolveReplay(manager, input, before, after);
          throw new ConflictException('Another add/drop request is already pending for this registration');
        }
        throw error;
      }
      for (const offeringId of before) {
        await manager.query(`INSERT INTO registration.add_drop_manifest_items
          (add_drop_request_id,manifest_side,offering_id) VALUES ($1,'BEFORE',$2)`, [id, offeringId]);
      }
      for (const offeringId of after) {
        await manager.query(`INSERT INTO registration.add_drop_manifest_items
          (add_drop_request_id,manifest_side,offering_id) VALUES ($1,'AFTER',$2)`, [id, offeringId]);
      }
      for (const authorization of authorizations) {
        try {
          await manager.query(`INSERT INTO registration.add_drop_override_usages
            (add_drop_request_id,authorization_id,exception_type,used_by) VALUES ($1,$2,$3,$4)`,
          [id, authorization.id, authorization.exception_type, actor.subjectId]);
        } catch (error) {
          if (isConstraint(error)) throw new ConflictException('Add/drop override is invalid or already used');
          throw error;
        }
      }
      for (const assignment of assignments) {
        try {
          await manager.query(`INSERT INTO registration.add_drop_capacity_assignments
            (add_drop_request_id,offering_id,pool_id,entitlement_id,assigned_by)
            VALUES ($1,$2,$3,$4,$5)`, [id, assignment.offeringId, assignment.poolId,
            assignment.entitlementId, actor.subjectId]);
        } catch (error) {
          if (isConstraint(error)) throw new ConflictException('Add/drop capacity entitlement is invalid');
          throw error;
        }
      }
      try {
        await manager.query(`INSERT INTO registration.add_drop_eligibility_snapshots
          (add_drop_request_id,requested_credit_units,maximum_credit_units,adviser_required,
           adviser_approval_id,timetable_conflict_count,timetable_manifest_sha256,
           evaluation_engine,evaluation_version,
           policy_reference,evaluation_trace,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, [id,
          snapshot.requestedCreditUnits, snapshot.maximumCreditUnits, snapshot.adviserRequired,
          snapshot.adviserApprovalId ?? null, timetableEvidence.conflictCount,
          timetableEvidence.manifestSha256, snapshot.evaluationEngine,
          snapshot.evaluationVersion, snapshot.policyReference, JSON.stringify(snapshot.evaluationTrace),
          actor.subjectId]);
      } catch (error) {
        if (isConstraint(error)) throw new ConflictException('Add/drop eligibility evidence is invalid');
        throw error;
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.add-drop.requested', resourceType: 'registration-add-drop', resourceId: id,
        details: { registrationRequestId: base.id, studentId: base.student_id,
          beforeOfferingIds: before, afterOfferingIds: after, additions, removals,
          registrationWindowId: addDropWindowId, overrideAuthorizationIds: overrideIds,
          timetableConflictCount: timetableEvidence.conflictCount,
          timetableManifestSha256: timetableEvidence.manifestSha256 } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationAddDropRequested',
        aggregateType: 'registration-add-drop', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { addDropRequestId: id, registrationRequestId: base.id, studentId: base.student_id } });
      return { id, replayed: false };
    });
  }

  async decide(id: string, input: DecideRegistrationAddDropDto, actor: Principal): Promise<void> {
    this.assertEnabled();
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly ChangeRow[]>(
        'SELECT * FROM registration.add_drop_requests WHERE id=$1 FOR UPDATE', [id]);
      const change = rows[0];
      if (change === undefined) throw new NotFoundException('Registration add/drop request not found');
      this.policy.assertScope(actor, change.scope_type, change.scope_id);
      if (change.status !== 'PENDING' || change.version !== input.expectedVersion) {
        throw new ConflictException('Add/drop request is not the expected pending version');
      }
      if (change.requested_by === actor.subjectId) {
        throw new ForbiddenException('Add/drop requester cannot decide the same request');
      }
      const bases = await manager.query<readonly BaseRequestRow[]>(
        'SELECT * FROM registration.requests WHERE id=$1 FOR UPDATE', [change.registration_request_id]);
      const base = bases[0];
      if (base === undefined || base.status !== 'CONFIRMED') {
        throw new ConflictException('Base registration is no longer confirmed');
      }
      const before = await this.manifest(manager, id, 'BEFORE');
      const after = await this.manifest(manager, id, 'AFTER');
      const current = await this.currentOfferingIds(manager, base.id);
      if (!sameValues(current, before)) {
        throw new ConflictException('Add/drop before manifest no longer matches the confirmed allocation');
      }
      const registrationWindowId = this.config.get('REGISTRATION_WINDOW_ENFORCEMENT_ENABLED', { infer: true })
        ? await this.assertOpenWindow(manager, base.period_id, base.scope_type, base.scope_id) : null;
      const additions = after.filter((offeringId) => !before.includes(offeringId));
      const removals = before.filter((offeringId) => !after.includes(offeringId));
      const snapshotRows = await manager.query<readonly SnapshotRow[]>(
        'SELECT * FROM registration.add_drop_eligibility_snapshots WHERE add_drop_request_id=$1', [id]);
      const snapshot = snapshotRows[0];
      if (snapshot === undefined) throw new ConflictException('Add/drop eligibility evidence is missing');
      if (input.outcome === 'APPROVED') {
        const currentTimetable = await this.timetableEvidence(manager, after);
        if (currentTimetable.conflictCount !== snapshot.timetable_conflict_count
          || currentTimetable.manifestSha256 !== snapshot.timetable_manifest_sha256) {
          throw new ConflictException('Published timetable changed after add/drop evaluation');
        }
        await this.assertCapacity(manager, id, additions);
      }
      await manager.query(`UPDATE registration.add_drop_requests SET status=$2,version=version+1,
        decided_by=$3,decided_at=clock_timestamp(),decision_reason=$4 WHERE id=$1`,
      [id, input.outcome, actor.subjectId, input.reason]);
      if (input.outcome === 'APPROVED') {
        const removedAllocations = removals.length === 0 ? [] : await manager.query<readonly {
          offering_id: string; pool_id: string | null }[]>(`SELECT offering_id,pool_id
          FROM registration.confirmed_item_allocations WHERE request_id=$1
            AND offering_id=ANY($2::uuid[]) ORDER BY offering_id FOR UPDATE`, [base.id, removals]);
        if (removedAllocations.length !== removals.length) {
          throw new ConflictException('One or more dropped allocations no longer exist');
        }
        if (removals.length > 0) {
          await manager.query(`DELETE FROM registration.confirmed_item_allocations
            WHERE request_id=$1 AND offering_id=ANY($2::uuid[])`, [base.id, removals]);
        }
        if (additions.length > 0) {
          try {
            await manager.query(`INSERT INTO registration.confirmed_item_allocations
              (request_id,offering_id,student_id,pool_id,add_drop_request_id)
              SELECT $1,a.offering_id,$2,c.pool_id,$3
              FROM unnest($4::uuid[]) a(offering_id)
              LEFT JOIN registration.add_drop_capacity_assignments c
                ON c.add_drop_request_id=$3 AND c.offering_id=a.offering_id`,
            [base.id, base.student_id, id, additions]);
          } catch (error) {
            if (isConstraint(error)) {
              throw new ConflictException('An added offering allocation conflicts with current registration');
            }
            throw error;
          }
        }
        for (const allocation of removedAllocations) {
          await manager.query(`INSERT INTO registration.add_drop_allocation_events
            (id,add_drop_request_id,registration_request_id,student_id,offering_id,action,pool_id,recorded_by)
            VALUES ($1,$2,$3,$4,$5,'DROP',$6,$7)`, [randomUUID(), id, base.id, base.student_id,
            allocation.offering_id, allocation.pool_id, actor.subjectId]);
        }
        const addedAssignments = additions.length === 0 ? [] : await manager.query<readonly {
          offering_id: string; pool_id: string | null }[]>(`SELECT a.offering_id,c.pool_id
            FROM unnest($2::uuid[]) a(offering_id) LEFT JOIN registration.add_drop_capacity_assignments c
              ON c.add_drop_request_id=$1 AND c.offering_id=a.offering_id ORDER BY a.offering_id`,
        [id, additions]);
        for (const allocation of addedAssignments) {
          await manager.query(`INSERT INTO registration.add_drop_allocation_events
            (id,add_drop_request_id,registration_request_id,student_id,offering_id,action,pool_id,recorded_by)
            VALUES ($1,$2,$3,$4,$5,'ADD',$6,$7)`, [randomUUID(), id, base.id, base.student_id,
            allocation.offering_id, allocation.pool_id, actor.subjectId]);
        }
      }
      await manager.query(`INSERT INTO registration.add_drop_decisions
        (id,add_drop_request_id,outcome,evaluation_engine,evaluation_version,evaluation_trace,reason,decided_by)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [randomUUID(), id, input.outcome,
        input.evaluationEngine, input.evaluationVersion, JSON.stringify(input.evaluationTrace),
        input.reason, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `registration.add-drop.${input.outcome.toLowerCase()}`,
        resourceType: 'registration-add-drop', resourceId: id,
        details: { registrationRequestId: base.id, beforeOfferingIds: before, afterOfferingIds: after,
          additions, removals, registrationWindowId } });
      await this.evidence.outbox(manager, { eventType: input.outcome === 'APPROVED'
        ? 'RegistrationAddDropApproved' : 'RegistrationAddDropRejected',
      aggregateType: 'registration-add-drop', aggregateId: id, classification: 'CONFIDENTIAL',
      payload: { addDropRequestId: id, registrationRequestId: base.id, studentId: base.student_id } });
    });
  }

  private assertEnabled(): void {
    if (!this.config.get('REGISTRATION_ADD_DROP_ENABLED', { infer: true })) {
      throw new ForbiddenException('Registration add/drop is disabled pending NIET policy approval');
    }
  }

  private async resolveReplay(manager: EntityManager, input: CreateRegistrationAddDropDto,
    before: readonly string[], after: readonly string[]): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly ChangeRow[]>(
      'SELECT * FROM registration.add_drop_requests WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    const storedBefore = row === undefined ? [] : await this.manifest(manager, row.id, 'BEFORE');
    const storedAfter = row === undefined ? [] : await this.manifest(manager, row.id, 'AFTER');
    const snapshotRows = row === undefined ? [] : await manager.query<readonly SnapshotRow[]>(
      'SELECT * FROM registration.add_drop_eligibility_snapshots WHERE add_drop_request_id=$1', [row.id]);
    const overrides = row === undefined ? [] : await manager.query<readonly { authorization_id: string }[]>(
      `SELECT authorization_id FROM registration.add_drop_override_usages
       WHERE add_drop_request_id=$1 ORDER BY authorization_id`, [row.id]);
    const assignments = row === undefined ? [] : await manager.query<readonly AssignmentRow[]>(
      `SELECT offering_id,pool_id,entitlement_id FROM registration.add_drop_capacity_assignments
       WHERE add_drop_request_id=$1 ORDER BY offering_id`, [row.id]);
    const inputAssignments = [...(input.capacityAssignments ?? [])]
      .sort((a, b) => a.offeringId.localeCompare(b.offeringId));
    if (row !== undefined && row.registration_request_id === input.registrationRequestId
      && row.scope_type === input.scopeType && row.scope_id === input.scopeId
      && sameValues(storedBefore, before) && sameValues(storedAfter, after)
      && snapshotMatches(snapshotRows[0], input.eligibilitySnapshot)
      && JSON.stringify(overrides.map((item) => item.authorization_id))
        === JSON.stringify([...(input.overrideAuthorizationIds ?? [])].sort())
      && JSON.stringify(assignments.map((item) => ({ offeringId: item.offering_id,
        poolId: item.pool_id, entitlementId: item.entitlement_id }))) === JSON.stringify(inputAssignments)) {
      return { id: row.id, replayed: true };
    }
    throw new ConflictException('Add/drop idempotency key already has different content');
  }

  private async assertCapacity(manager: EntityManager, changeId: string,
    additions: readonly string[]): Promise<void> {
    if (additions.length === 0) return;
    const offerings = await manager.query<readonly { id: string; capacity: number }[]>(`SELECT id,capacity
      FROM registration.offerings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [additions]);
    if (offerings.length !== additions.length) throw new ConflictException('Added offering is unavailable');
    const override = await manager.query<readonly { present: boolean }[]>(`SELECT EXISTS(
      SELECT 1 FROM registration.add_drop_override_usages
      WHERE add_drop_request_id=$1 AND exception_type='CAPACITY') present`, [changeId]);
    if (override[0]?.present === true) return;
    if (!this.config.get('REGISTRATION_RESERVED_CAPACITY_ENFORCEMENT_ENABLED', { infer: true })) {
      const counts = await manager.query<readonly { offering_id: string; confirmed: number }[]>(`SELECT o.id offering_id,
        count(a.request_id)::int confirmed FROM registration.offerings o
        LEFT JOIN registration.confirmed_item_allocations a ON a.offering_id=o.id
        WHERE o.id=ANY($1::uuid[]) GROUP BY o.id ORDER BY o.id`, [additions]);
      const countByOffering = new Map(counts.map((row) => [row.offering_id, row.confirmed]));
      if (offerings.some((row) => (countByOffering.get(row.id) ?? 0) >= row.capacity)) {
        throw new ConflictException('One or more added offerings have no remaining confirmed capacity');
      }
      return;
    }
    await manager.query(`SELECT id FROM registration.capacity_pools
      WHERE offering_id=ANY($1::uuid[]) AND status='PUBLISHED' ORDER BY id FOR UPDATE`, [additions]);
    const violations = await manager.query<readonly { blocked: boolean }[]>(`WITH target AS (
        SELECT o.id,o.capacity,a.pool_id FROM registration.offerings o
        LEFT JOIN registration.add_drop_capacity_assignments a
          ON a.add_drop_request_id=$1 AND a.offering_id=o.id
        WHERE o.id=ANY($2::uuid[])
      ), reserved AS (
        SELECT offering_id,sum(capacity)::int capacity FROM registration.capacity_pools
        WHERE status='PUBLISHED' GROUP BY offering_id
      ) SELECT EXISTS(SELECT 1 FROM target t
        LEFT JOIN registration.capacity_pools p ON p.id=t.pool_id AND p.status='PUBLISHED'
        LEFT JOIN reserved rs ON rs.offering_id=t.id
        WHERE CASE WHEN t.pool_id IS NULL THEN
          (SELECT count(*) FROM registration.confirmed_item_allocations c
            WHERE c.offering_id=t.id AND c.pool_id IS NULL)>=t.capacity-COALESCE(rs.capacity,0)
        ELSE p.id IS NULL OR (SELECT count(*) FROM registration.confirmed_item_allocations c
            WHERE c.offering_id=t.id AND c.pool_id=t.pool_id)>=p.capacity END) blocked`,
    [changeId, additions]);
    if (violations[0]?.blocked === true) {
      throw new ConflictException('One or more added offerings have no remaining confirmed capacity');
    }
  }

  private async currentOfferingIds(manager: EntityManager, requestId: string): Promise<string[]> {
    const rows = await manager.query<readonly { offering_id: string }[]>(`SELECT offering_id
      FROM registration.confirmed_item_allocations WHERE request_id=$1 ORDER BY offering_id FOR UPDATE`,
    [requestId]);
    return rows.map((row) => row.offering_id);
  }

  private async manifest(manager: EntityManager, id: string, side: 'BEFORE' | 'AFTER'): Promise<string[]> {
    const rows = await manager.query<readonly { offering_id: string }[]>(`SELECT offering_id
      FROM registration.add_drop_manifest_items WHERE add_drop_request_id=$1 AND manifest_side=$2
      ORDER BY offering_id`, [id, side]);
    return rows.map((row) => row.offering_id);
  }

  private async timetableEvidence(manager: EntityManager,
    offeringIds: readonly string[]): Promise<{ conflictCount: number; manifestSha256: string }> {
    const rows = await manager.query<readonly { conflict_count: number; manifest_sha256: string }[]>(`WITH meetings AS (
      SELECT * FROM registration.timetable_meetings
      WHERE status='PUBLISHED' AND offering_id=ANY($1::uuid[])
    ), conflicts AS (SELECT a.id first_id,b.id second_id FROM meetings a JOIN meetings b
      ON a.id<b.id AND a.offering_id<>b.offering_id AND a.weekday=b.weekday
      AND int4range(a.start_minute,a.end_minute,'[)') && int4range(b.start_minute,b.end_minute,'[)'))
    SELECT (SELECT count(*)::int FROM conflicts) conflict_count,
      encode(digest(COALESCE((SELECT string_agg(concat_ws(':',id::text,offering_id::text,
        meeting_key,weekday::text,start_minute::text,end_minute::text,room_key,instructor_subject_id),','
        ORDER BY id) FROM meetings),''),'sha256'),'hex') manifest_sha256`,
    [offeringIds]);
    return { conflictCount: rows[0]?.conflict_count ?? 0,
      manifestSha256: rows[0]?.manifest_sha256 ?? manifestHash([]) };
  }

  private async assertOpenWindow(manager: EntityManager, periodId: string,
    scopeType: string, scopeId: string): Promise<string> {
    const rows = await manager.query<readonly { id: string }[]>(`SELECT id FROM registration.windows
      WHERE period_id=$1 AND window_type='ADD_DROP' AND scope_type=$2 AND scope_id=$3
        AND status='PUBLISHED' AND opens_at<=clock_timestamp() AND closes_at>clock_timestamp()`,
    [periodId, scopeType, scopeId]);
    if (rows[0] === undefined) throw new ConflictException('No approved add/drop window is open');
    return rows[0].id;
  }

  private assertEligibilityInput(snapshot: CreateRegistrationAddDropDto['eligibilitySnapshot']): void {
    if (!snapshot.adviserRequired && snapshot.adviserApprovalId !== undefined) {
      throw new ConflictException('Adviser approval evidence is unexpected when policy does not require it');
    }
  }
}

function manifestHash(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join(',')).digest('hex');
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatches(row: SnapshotRow | undefined,
  input: CreateRegistrationAddDropDto['eligibilitySnapshot']): boolean {
  return row !== undefined && Number(row.requested_credit_units) === Number(input.requestedCreditUnits)
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

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['23503', '23505', '23514', 'P0001'].includes(String(error.code));
}

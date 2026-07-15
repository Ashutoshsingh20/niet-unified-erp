import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { DecideStudentWithdrawalDto, RequestStudentWithdrawalDto,
  StudentWithdrawalExceptionsQueryDto } from './student-withdrawals.dto';

interface StudentRow { id: string; subject_id: string | null; status: string; version: number;
  scope_type: string; scope_id: string }
interface RequestRow { id: string; student_id: string; idempotency_key: string; reason: string;
  status: string; version: number; requested_by: string; scope_type: string; scope_id: string }
interface DecisionRow { decision: string; evaluation_engine: string; evaluation_version: string;
  policy_reference: string; evaluation_trace: Record<string, unknown>; reason: string; decided_by: string }

export interface StudentWithdrawalException {
  readonly requestId: string;
  readonly studentId: string;
  readonly activeHoldCount: number;
  readonly openRegistrationCount: number;
  readonly openProgrammeEnrolmentCount: number;
  readonly pendingAddDropCount: number;
  readonly pendingFinanceCount: number;
  readonly nonZeroAccountCount: number;
}

@Injectable()
export class StudentWithdrawalsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async request(input: RequestStudentWithdrawalDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled();
    return this.dataSource.transaction(async (manager) => {
      const student = await this.lockStudent(manager, input.studentId);
      this.policy.assertScope(actor, student.scope_type, student.scope_id);
      if (student.subject_id !== actor.subjectId) {
        throw new ForbiddenException('Only the student can request withdrawal');
      }
      const existing = await manager.query<readonly RequestRow[]>(`SELECT r.*,s.scope_type,s.scope_id
        FROM student.withdrawal_requests r JOIN student.records s ON s.id=r.student_id
        WHERE r.student_id=$1 OR r.idempotency_key=$2 FOR UPDATE OF r`,
      [input.studentId, input.idempotencyKey]);
      if (existing[0] !== undefined) {
        const row = existing[0];
        if (row.student_id === input.studentId && row.idempotency_key === input.idempotencyKey
          && row.reason === input.reason && row.requested_by === actor.subjectId) {
          return { id: row.id, replayed: true };
        }
        throw new ConflictException('Withdrawal request or idempotency key already has different content');
      }
      if (student.version !== input.expectedStudentVersion
        || ['WITHDRAWN', 'TERMINATED', 'COMPLETED'].includes(student.status)) {
        throw new ConflictException('Student is not at the expected withdrawable version');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO student.withdrawal_requests
        (id,student_id,idempotency_key,reason,requested_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, input.studentId, input.idempotencyKey, input.reason, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'student.withdrawal.requested', resourceType: 'student-withdrawal-request',
        resourceId: id, details: { studentId: input.studentId } });
      await this.evidence.outbox(manager, { eventType: 'StudentWithdrawalRequested',
        aggregateType: 'student-withdrawal-request', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { studentWithdrawalRequestId: id, studentId: input.studentId } });
      return { id, replayed: false };
    });
  }

  async decide(id: string, input: DecideStudentWithdrawalDto,
    actor: Principal): Promise<{ status: 'REJECTED' | 'WITHDRAWN'; replayed: boolean }> {
    this.assertEnabled();
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly RequestRow[]>(`SELECT r.*,s.scope_type,s.scope_id
        FROM student.withdrawal_requests r JOIN student.records s ON s.id=r.student_id
        WHERE r.id=$1 FOR UPDATE OF r,s`, [id]);
      const request = rows[0];
      if (request === undefined) throw new NotFoundException('Student withdrawal request not found');
      this.policy.assertScope(actor, request.scope_type, request.scope_id);
      const decisions = await manager.query<readonly DecisionRow[]>(
        'SELECT * FROM student.withdrawal_decisions WHERE request_id=$1', [id]);
      if (decisions[0] !== undefined) {
        const decision = decisions[0];
        if (decision.decision === input.decision && decision.evaluation_engine === input.evaluationEngine
          && decision.evaluation_version === input.evaluationVersion
          && decision.policy_reference === input.policyReference
          && canonicalJson(decision.evaluation_trace) === canonicalJson(input.evaluationTrace)
          && decision.reason === input.reason && decision.decided_by === actor.subjectId) {
          return { status: request.status as 'REJECTED' | 'WITHDRAWN', replayed: true };
        }
        throw new ConflictException('Withdrawal request already has a different decision');
      }
      if (request.requested_by === actor.subjectId) {
        throw new ForbiddenException('Withdrawal requester cannot decide the same request');
      }
      if (request.status !== 'REQUESTED' || request.version !== input.expectedRequestVersion) {
        throw new ConflictException('Withdrawal request is not the expected pending version');
      }
      if (input.decision === 'APPROVED') await this.assertHardBlockersCleared(manager, request.student_id);
      await manager.query(`INSERT INTO student.withdrawal_decisions
        (id,request_id,decision,evaluation_engine,evaluation_version,policy_reference,
         evaluation_trace,reason,decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [randomUUID(), id, input.decision, input.evaluationEngine, input.evaluationVersion,
        input.policyReference, JSON.stringify(input.evaluationTrace), input.reason, actor.subjectId]);
      const status = input.decision === 'APPROVED' ? 'WITHDRAWN' : 'REJECTED';
      if (status === 'WITHDRAWN') await this.closeAcademicState(manager, request, input, actor);
      await manager.query('UPDATE student.withdrawal_requests SET status=$2,version=version+1 WHERE id=$1',
        [id, status]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `student.withdrawal.${status.toLowerCase()}`,
        resourceType: 'student-withdrawal-request', resourceId: id,
        details: { studentId: request.student_id, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion, policyReference: input.policyReference } });
      await this.evidence.outbox(manager, { eventType: status === 'WITHDRAWN'
        ? 'StudentWithdrawn' : 'StudentWithdrawalRejected', aggregateType: 'student-withdrawal-request',
        aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { studentWithdrawalRequestId: id, studentId: request.student_id } });
      return { status, replayed: false };
    });
  }

  async list(input: StudentWithdrawalExceptionsQueryDto,
    actor: Principal): Promise<{ items: StudentWithdrawalException[]; nextCursor: string | null }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const rows = await this.dataSource.query<readonly { request_id: string; student_id: string;
      active_holds: number; open_registrations: number; open_enrolments: number;
      pending_add_drop: number; pending_finance: number; nonzero_accounts: number }[]>(`SELECT r.id request_id,r.student_id,
      (SELECT count(*)::int FROM student.holds h WHERE h.student_id=r.student_id
        AND h.status IN ('PROPOSED','ACTIVE')) active_holds,
      (SELECT count(*)::int FROM registration.requests rr WHERE rr.student_id=r.student_id
        AND rr.status IN ('CONFIRMED','WAITLISTED')) open_registrations,
      (SELECT count(*)::int FROM student.programme_enrolments pe WHERE pe.student_id=r.student_id
        AND pe.status IN ('PROVISIONAL','ACTIVE')) open_enrolments,
      (SELECT count(*)::int FROM registration.add_drop_requests adr WHERE adr.student_id=r.student_id
        AND adr.status='PENDING') pending_add_drop,
      (SELECT count(*)::int FROM admissions.conversions c
        JOIN admissions.cancellation_requests cr ON cr.offer_id=c.offer_id
        WHERE c.student_id=r.student_id AND cr.status='PENDING_FINANCE') pending_finance,
      (SELECT count(*)::int FROM finance.accounts fa
        LEFT JOIN finance.account_student_links fasl ON fasl.account_id=fa.id
        WHERE COALESCE(fa.student_id,fasl.student_id)=r.student_id
        AND (SELECT COALESCE(sum(CASE WHEN e.ledger_account='RECEIVABLE' AND e.direction='DEBIT'
          THEN e.amount_minor WHEN e.ledger_account='RECEIVABLE' AND e.direction='CREDIT'
          THEN -e.amount_minor ELSE 0 END),0) FROM finance.postings p
          JOIN finance.ledger_entries e ON e.posting_id=p.id WHERE p.account_id=fa.id)<>0) nonzero_accounts
      FROM student.withdrawal_requests r JOIN student.records s ON s.id=r.student_id
      WHERE r.status='REQUESTED' AND s.scope_type=$1 AND s.scope_id=$2
        AND ($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT $4`,
    [input.scopeType, input.scopeId, input.after ?? null, input.limit + 1]);
    const hasNext = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return { items: page.map((row) => ({ requestId: row.request_id, studentId: row.student_id,
      activeHoldCount: row.active_holds, openRegistrationCount: row.open_registrations,
      openProgrammeEnrolmentCount: row.open_enrolments, pendingFinanceCount: row.pending_finance,
      pendingAddDropCount: row.pending_add_drop, nonZeroAccountCount: row.nonzero_accounts })),
    nextCursor: hasNext ? page.at(-1)?.request_id ?? null : null };
  }

  private async assertHardBlockersCleared(manager: EntityManager, studentId: string): Promise<void> {
    const blockers = await manager.query<readonly { active_holds: number; pending_finance: number;
      pending_refunds: number; pending_add_drop: number }[]>(`SELECT
      (SELECT count(*)::int FROM student.holds WHERE student_id=$1
        AND status IN ('PROPOSED','ACTIVE')) active_holds,
      (SELECT count(*)::int FROM admissions.conversions c
        JOIN admissions.cancellation_requests r ON r.offer_id=c.offer_id
        WHERE c.student_id=$1 AND r.status='PENDING_FINANCE') pending_finance,
      (SELECT count(*)::int FROM finance.accounts a
        LEFT JOIN finance.account_student_links fasl ON fasl.account_id=a.id
        JOIN finance.postings p ON p.account_id=a.id
        JOIN finance.refund_requests rr ON rr.original_payment_posting_id=p.id
        LEFT JOIN finance.refund_decisions rd ON rd.request_id=rr.id
        WHERE COALESCE(a.student_id,fasl.student_id)=$1 AND rd.id IS NULL) pending_refunds,
      (SELECT count(*)::int FROM registration.add_drop_requests
        WHERE student_id=$1 AND status='PENDING') pending_add_drop`, [studentId]);
    const row = blockers[0];
    if ((row?.active_holds ?? 0) > 0 || (row?.pending_finance ?? 0) > 0
      || (row?.pending_refunds ?? 0) > 0 || (row?.pending_add_drop ?? 0) > 0) {
      throw new ConflictException('Student withdrawal has unresolved hold, finance, or add/drop blockers');
    }
  }

  private async closeAcademicState(manager: EntityManager, request: RequestRow,
    input: DecideStudentWithdrawalDto, actor: Principal): Promise<void> {
    const registrations = await manager.query<readonly { id: string; status: string }[]>(`SELECT id,status
      FROM registration.requests WHERE student_id=$1 AND status IN ('CONFIRMED','WAITLISTED')
      ORDER BY id FOR UPDATE`, [request.student_id]);
    for (const registration of registrations) {
      await manager.query(`INSERT INTO registration.withdrawals
        (id,request_id,from_status,reason,withdrawn_by) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), registration.id, registration.status, input.reason, actor.subjectId]);
      await manager.query(`UPDATE registration.waitlist_entries SET status='REMOVED'
        WHERE request_id=$1 AND status='WAITING'`, [registration.id]);
      await manager.query(`UPDATE registration.requests SET status='CANCELLED',version=version+1,
        decision_reason=$2 WHERE id=$1`, [registration.id, input.reason]);
      if (registration.status === 'CONFIRMED') {
        await manager.query(`DELETE FROM registration.confirmed_item_allocations
          WHERE request_id=$1`, [registration.id]);
      }
    }
    const enrolments = await manager.query<readonly { id: string; status: string }[]>(`SELECT id,status
      FROM student.programme_enrolments WHERE student_id=$1 AND status IN ('PROVISIONAL','ACTIVE')
      ORDER BY id FOR UPDATE`, [request.student_id]);
    for (const enrolment of enrolments) {
      await manager.query(`INSERT INTO student.programme_enrolment_withdrawals
        (id,withdrawal_request_id,enrolment_id,from_status,reason,policy_reference,withdrawn_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), request.id, enrolment.id, enrolment.status,
        input.reason, input.policyReference, actor.subjectId]);
      await manager.query(`UPDATE student.programme_enrolments SET status='WITHDRAWN',version=version+1,
        activated_by=COALESCE(activated_by,$2),activated_at=COALESCE(activated_at,clock_timestamp()) WHERE id=$1`,
      [enrolment.id, actor.subjectId]);
    }
    const student = await this.lockStudent(manager, request.student_id);
    await manager.query(`INSERT INTO student.status_history
      (id,student_id,from_status,to_status,record_version,reason,rule_version,changed_by)
      VALUES ($1,$2,$3,'WITHDRAWN',$4,$5,$6,$7)`, [randomUUID(), student.id, student.status,
      student.version + 1, input.reason, input.policyReference, actor.subjectId]);
    await manager.query(`UPDATE student.records SET status='WITHDRAWN',version=version+1,
      updated_at=clock_timestamp() WHERE id=$1`, [student.id]);
  }

  private async lockStudent(manager: EntityManager, id: string): Promise<StudentRow> {
    const rows = await manager.query<readonly StudentRow[]>(
      'SELECT * FROM student.records WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Student record not found');
    return rows[0];
  }

  private assertEnabled(): void {
    if (!this.config.get('STUDENT_WITHDRAWAL_ENABLED', { infer: true })) {
      throw new ForbiddenException('Student withdrawal is disabled pending NIET lifecycle approval');
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

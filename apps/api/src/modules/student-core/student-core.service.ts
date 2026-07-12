import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';

export interface StudentCoreOverview {
  student: { id: string; displayName: string; status: string };
  programmes: readonly { enrolmentId: string; programmeKey: string; programmeTitle: string;
    programmeVersion: number; regulationKey: string; regulationVersion: number;
    status: string; startsOn: string; endsOn: string | null }[];
  holds: readonly { holdId: string; holdKey: string; effect: string;
    reason: string; status: string; raisedAt: string }[];
  registrations: readonly { requestId: string; periodTitle: string; offeringId: string;
    offeringTitle: string; courseKey: string }[];
  schedule: readonly { meetingId: string; offeringTitle: string; courseKey: string;
    weekday: number; startMinute: number; endMinute: number; roomKey: string }[];
  attendance: readonly { sessionId: string; offeringTitle: string; courseKey: string;
    presenceState: string; observedAt: string }[];
  accounts: readonly { accountId: string; currency: string; balanceMinor: string }[];
}
interface StudentRow { id: string; display_name: string; status: string; scope_type: string; scope_id: string }
@Injectable()
export class StudentCoreService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService) {}
  async overview(actor: Principal): Promise<StudentCoreOverview> {
    const students = await this.dataSource.query<readonly StudentRow[]>(`SELECT id,display_name,status,
      scope_type,scope_id FROM student.records WHERE subject_id=$1 ORDER BY created_at DESC LIMIT 2`,
    [actor.subjectId]);
    const student = students[0];
    if (student === undefined) throw new NotFoundException('No canonical student record is linked to this identity');
    if (students.length > 1) throw new NotFoundException('Canonical student identity is ambiguous');
    this.policy.assertScope(actor, student.scope_type, student.scope_id);
    const [programmes, holds, registrations, schedule, attendance, accounts] = await Promise.all([
      this.dataSource.query<readonly { enrolment_id: string; programme_key: string;
        programme_title: string; programme_version: number; regulation_key: string;
        regulation_version: number; status: string; starts_on: string; ends_on: string | null }[]>(`SELECT
        e.id enrolment_id,p.programme_key,p.title programme_title,p.version programme_version,
        r.regulation_key,r.version regulation_version,e.status,e.starts_on::text,e.ends_on::text
        FROM student.programme_enrolments e JOIN curriculum.programme_versions p ON p.id=e.programme_version_id
        JOIN curriculum.regulation_versions r ON r.id=p.regulation_id WHERE e.student_id=$1
        ORDER BY e.starts_on DESC`, [student.id]),
      this.dataSource.query<readonly { hold_id: string; hold_key: string; effect: string;
        reason: string; status: string; raised_at: Date }[]>(`SELECT id hold_id,hold_key,effect,reason,status,raised_at
        FROM student.holds WHERE student_id=$1 ORDER BY raised_at DESC`, [student.id]),
      this.dataSource.query<readonly { request_id: string; period_title: string; offering_id: string;
        offering_title: string; course_key: string }[]>(`SELECT r.id request_id,p.title period_title,
        o.id offering_id,o.title offering_title,o.course_key FROM registration.requests r
        JOIN registration.academic_periods p ON p.id=r.period_id
        JOIN registration.request_items i ON i.request_id=r.id
        JOIN registration.offerings o ON o.id=i.offering_id
        WHERE r.student_id=$1 AND r.status='CONFIRMED' ORDER BY p.starts_at DESC,o.offering_key`, [student.id]),
      this.dataSource.query<readonly { meeting_id: string; offering_title: string; course_key: string;
        weekday: number; start_minute: number; end_minute: number; room_key: string }[]>(`SELECT m.id meeting_id,
        o.title offering_title,o.course_key,m.weekday,m.start_minute,m.end_minute,m.room_key
        FROM registration.requests r JOIN registration.request_items i ON i.request_id=r.id
        JOIN registration.offerings o ON o.id=i.offering_id
        JOIN registration.timetable_meetings m ON m.offering_id=o.id AND m.status='PUBLISHED'
        WHERE r.student_id=$1 AND r.status='CONFIRMED'
        ORDER BY m.weekday,m.start_minute,o.offering_key`, [student.id]),
      this.dataSource.query<readonly { session_id: string; offering_title: string; course_key: string;
        presence_state: string; observed_at: Date }[]>(`SELECT s.id session_id,o.title offering_title,o.course_key,
        COALESCE((SELECT c.corrected_state FROM teaching.attendance_corrections c
          WHERE c.session_id=s.id AND c.student_id=$1 ORDER BY c.correction_sequence DESC LIMIT 1),
          ob.presence_state) presence_state,ob.observed_at
        FROM teaching.sessions s JOIN registration.offerings o ON o.id=s.offering_id
        JOIN teaching.attendance_observations ob ON ob.session_id=s.id AND ob.student_id=$1
        WHERE s.status='FINALIZED' ORDER BY s.starts_at DESC`, [student.id]),
      this.dataSource.query<readonly { account_id: string; currency: string; balance_minor: string }[]>(`SELECT a.id account_id,
        a.currency,COALESCE(sum(CASE WHEN e.ledger_account='RECEIVABLE' AND e.direction='DEBIT'
          THEN e.amount_minor WHEN e.ledger_account='RECEIVABLE' AND e.direction='CREDIT'
          THEN -e.amount_minor ELSE 0 END),0)::text balance_minor
        FROM finance.student_accounts a LEFT JOIN finance.postings p ON p.account_id=a.id
        LEFT JOIN finance.ledger_entries e ON e.posting_id=p.id WHERE a.student_id=$1
        GROUP BY a.id,a.currency ORDER BY a.currency`, [student.id]),
    ]);
    return {
      student: { id: student.id, displayName: student.display_name, status: student.status },
      programmes: programmes.map((row) => ({ enrolmentId: row.enrolment_id,
        programmeKey: row.programme_key, programmeTitle: row.programme_title,
        programmeVersion: row.programme_version, regulationKey: row.regulation_key,
        regulationVersion: row.regulation_version, status: row.status,
        startsOn: row.starts_on, endsOn: row.ends_on })),
      holds: holds.map((row) => ({ holdId: row.hold_id, holdKey: row.hold_key,
        effect: row.effect, reason: row.reason, status: row.status,
        raisedAt: row.raised_at.toISOString() })),
      registrations: registrations.map((row) => ({ requestId: row.request_id, periodTitle: row.period_title,
        offeringId: row.offering_id, offeringTitle: row.offering_title, courseKey: row.course_key })),
      schedule: schedule.map((row) => ({ meetingId: row.meeting_id, offeringTitle: row.offering_title,
        courseKey: row.course_key, weekday: row.weekday, startMinute: row.start_minute,
        endMinute: row.end_minute, roomKey: row.room_key })),
      attendance: attendance.map((row) => ({ sessionId: row.session_id, offeringTitle: row.offering_title,
        courseKey: row.course_key, presenceState: row.presence_state,
        observedAt: row.observed_at.toISOString() })),
      accounts: accounts.map((row) => ({ accountId: row.account_id, currency: row.currency,
        balanceMinor: row.balance_minor })),
    };
  }
}

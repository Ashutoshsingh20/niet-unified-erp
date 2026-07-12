import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateTimetableMeetingDto, PublishTimetableMeetingDto } from './timetable.dto';
interface MeetingRow { id: string; offering_id: string; status: string; record_version: number;
  scope_type: string; scope_id: string }
@Injectable()
export class TimetableService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateTimetableMeetingDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (input.endMinute <= input.startMinute) throw new ConflictException('Meeting end must be after start');
    const offerings = await this.dataSource.query<readonly { scope_type: string; scope_id: string }[]>(
      "SELECT scope_type,scope_id FROM registration.offerings WHERE id=$1 AND status='PUBLISHED'", [input.offeringId]);
    if (offerings[0]?.scope_type !== input.scopeType || offerings[0]?.scope_id !== input.scopeId) {
      throw new ConflictException('A published offering in the same scope is required');
    }
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO registration.timetable_meetings
          (id,offering_id,meeting_key,weekday,start_minute,end_minute,room_key,
           instructor_subject_id,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, input.offeringId,
          input.meetingKey, input.weekday, input.startMinute, input.endMinute, input.roomKey,
          input.instructorSubjectId, input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwDatabaseConflict(error, 'Meeting key already exists for this offering'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'timetable.meeting.drafted', resourceType: 'timetable-meeting', resourceId: id,
        details: { offeringId: input.offeringId, weekday: input.weekday,
          startMinute: input.startMinute, endMinute: input.endMinute,
          roomKey: input.roomKey, instructorSubjectId: input.instructorSubjectId } });
    });
    return { id };
  }
  async publish(id: string, input: PublishTimetableMeetingDto, actor: Principal): Promise<void> {
    if (!this.config.get('TIMETABLE_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Timetable publication is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly MeetingRow[]>(
        'SELECT * FROM registration.timetable_meetings WHERE id=$1 FOR UPDATE', [id]);
      const meeting = rows[0];
      if (meeting === undefined) throw new NotFoundException('Timetable meeting not found');
      this.policy.assertScope(actor, meeting.scope_type, meeting.scope_id);
      if (meeting.status !== 'DRAFT' || meeting.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Timetable meeting is not the expected draft version');
      }
      try {
        await manager.query(`UPDATE registration.timetable_meetings SET status='PUBLISHED',
          record_version=record_version+1,published_by=$2,published_at=clock_timestamp(),
          policy_decision_reference=$3 WHERE id=$1`, [id, actor.subjectId, input.policyDecisionReference]);
      } catch (error) { throwDatabaseConflict(error, 'Timetable room, instructor, or offering conflicts with a published meeting'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'timetable.meeting.published', resourceType: 'timetable-meeting', resourceId: id,
        details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'ScheduleChanged',
        aggregateType: 'timetable-meeting', aggregateId: id, classification: 'INTERNAL',
        payload: { timetableMeetingId: id, courseOfferingId: meeting.offering_id } });
    });
  }
}
function throwDatabaseConflict(error: unknown, fallback: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505') throw new ConflictException(fallback);
    if (error.code === '23P01') throw new ConflictException('Timetable room, instructor, or offering conflicts with a published meeting');
  }
  throw error;
}

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

interface DueWaitlist { request_id: string; student_id: string; expires_at: Date;
  policy_reference: string }

export class WaitlistExpiryService {
  constructor(private readonly pool: Pool, private readonly workerId: string) {}

  async processOne(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<DueWaitlist>(`SELECT t.request_id,r.student_id,t.expires_at,
        t.policy_reference FROM registration.waitlist_terms t
        JOIN registration.requests r ON r.id=t.request_id
        LEFT JOIN registration.waitlist_expirations x ON x.request_id=t.request_id
        WHERE r.status='WAITLISTED' AND t.expires_at<=clock_timestamp() AND x.id IS NULL
        ORDER BY t.expires_at,t.request_id FOR UPDATE OF r SKIP LOCKED LIMIT 1`);
      const row = due.rows[0];
      if (row === undefined) { await client.query('COMMIT'); return false; }
      const actor = `system:waitlist-expiry:${this.workerId}`;
      const expirationId = randomUUID(); const correlationId = randomUUID();
      await client.query(`INSERT INTO registration.waitlist_expirations
        (id,request_id,expires_at,policy_reference,expired_by) VALUES ($1,$2,$3,$4,$5)`,
      [expirationId, row.request_id, row.expires_at, row.policy_reference, actor]);
      await client.query(`UPDATE registration.waitlist_entries SET status='REMOVED'
        WHERE request_id=$1 AND status='WAITING'`, [row.request_id]);
      await client.query(`UPDATE registration.requests SET status='CANCELLED',version=version+1,
        decision_reason='Governed waitlist expiry reached' WHERE id=$1 AND status='WAITLISTED'`,
      [row.request_id]);
      await client.query(`INSERT INTO platform.audit_events
        (id,actor_subject_id,action,resource_type,resource_id,outcome,correlation_id,details)
        VALUES ($1,$2,'registration.waitlist.expired','registration-request',$3,'SUCCEEDED',$4,
          jsonb_build_object('expiresAt',$5::timestamptz,'policyReference',$6::text))`,
      [randomUUID(), actor, row.request_id, correlationId, row.expires_at, row.policy_reference]);
      await client.query(`INSERT INTO platform.outbox_events
        (id,event_type,event_version,aggregate_type,aggregate_id,correlation_id,classification,payload)
        VALUES ($1,'RegistrationWaitlistExpired',1,'registration-request',$2,$3,'CONFIDENTIAL',
          jsonb_build_object('registrationRequestId',$2::text,'studentId',$4::text))`,
      [randomUUID(), row.request_id, correlationId, row.student_id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { ConversionExceptionsQueryDto, ResolveConversionExceptionDto,
  ScanConversionExceptionsDto } from './conversion-exceptions.dto';

type IssueCode = 'APPLICATION_STATE_MISMATCH' | 'OFFER_STATE_MISMATCH' | 'STUDENT_SOURCE_MISMATCH'
  | 'FINANCE_LINK_MISSING' | 'SEAT_CONSUMPTION_MISMATCH';
interface InvariantRow { conversion_id: string; application_id: string; offer_id: string; student_id: string;
  scope_type: string; scope_id: string; application_status: string; offer_status: string;
  source_system: string; source_key: string; finance_accounts: number; finance_links: number;
  has_seat: boolean; seat_consumed: boolean }
interface CaseRow { id: string; conversion_id: string; issue_code: IssueCode; details: Record<string, unknown>;
  fingerprint_sha256: string; scope_type: string; scope_id: string; status: 'OPEN' | 'RESOLVED' | 'WAIVED';
  version: number; detected_by: string; detected_at: Date; converted_by: string }
interface ResolutionRow { outcome: 'RESOLVED' | 'WAIVED'; evaluation_engine: string;
  evaluation_version: string; policy_reference: string; evaluation_trace: Record<string, unknown>;
  reason: string; resolved_by: string }
export interface ConversionExceptionView { readonly id: string; readonly conversionId: string;
  readonly issueCode: IssueCode; readonly details: Record<string, unknown>;
  readonly status: 'OPEN' | 'RESOLVED' | 'WAIVED'; readonly version: number;
  readonly detectedAt: string }

@Injectable()
export class ConversionExceptionsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async scan(input: ScanConversionExceptionsDto, actor: Principal):
  Promise<{ scanned: number; discovered: number; open: number }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['conversion-exception-scan', input.scopeType, input.scopeId])]);
      const rows = await invariantRows(manager, input.scopeType, input.scopeId, input.limit);
      let discovered = 0;
      for (const row of rows) {
        for (const issue of detectIssues(row)) {
          const fingerprint = createHash('sha256').update(canonicalJson(issue.details)).digest('hex');
          const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO
            admissions.conversion_exception_cases
            (id,conversion_id,issue_code,fingerprint_sha256,details,scope_type,scope_id,detected_by)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
            ON CONFLICT (conversion_id,issue_code,fingerprint_sha256) DO NOTHING RETURNING id`,
          [randomUUID(), row.conversion_id, issue.code, fingerprint, JSON.stringify(issue.details),
            input.scopeType, input.scopeId, actor.subjectId]);
          if (inserted[0] !== undefined) {
            discovered += 1;
            await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
              action: 'admission.conversion-exception.detected',
              resourceType: 'admission-conversion-exception', resourceId: inserted[0].id,
              details: { conversionId: row.conversion_id, issueCode: issue.code,
                fingerprintSha256: fingerprint, scopeType: input.scopeType, scopeId: input.scopeId } });
            await this.evidence.outbox(manager, { eventType: 'AdmissionConversionExceptionDetected',
              aggregateType: 'admission-conversion-exception', aggregateId: inserted[0].id,
              classification: 'RESTRICTED', payload: {
                admissionConversionExceptionId: inserted[0].id, issueCode: issue.code } });
          }
        }
      }
      const counts = await manager.query<readonly { count: number }[]>(`SELECT count(*)::int count
        FROM admissions.conversion_exception_cases WHERE scope_type=$1 AND scope_id=$2 AND status='OPEN'`,
      [input.scopeType, input.scopeId]);
      return { scanned: rows.length, discovered, open: counts[0]?.count ?? 0 };
    });
  }

  async list(input: ConversionExceptionsQueryDto, actor: Principal):
  Promise<{ items: ConversionExceptionView[]; nextCursor: string | null }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const rows = await this.dataSource.query<readonly CaseRow[]>(`SELECT c.*,
      conversion.converted_by FROM admissions.conversion_exception_cases c
      JOIN admissions.conversions conversion ON conversion.id=c.conversion_id
      WHERE c.scope_type=$1 AND c.scope_id=$2 AND ($3::text IS NULL OR c.status=$3)
        AND ($4::uuid IS NULL OR c.id>$4) ORDER BY c.id LIMIT $5`,
    [input.scopeType, input.scopeId, input.status ?? null, input.after ?? null, input.limit + 1]);
    const hasNext = rows.length > input.limit; const page = rows.slice(0, input.limit);
    return { items: page.map(toView), nextCursor: hasNext ? page.at(-1)?.id ?? null : null };
  }

  async resolve(id: string, input: ResolveConversionExceptionDto, actor: Principal):
  Promise<{ status: 'RESOLVED' | 'WAIVED'; replayed: boolean }> {
    if (!this.config.get('ADMISSION_CONVERSION_EXCEPTION_RESOLUTION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Conversion exception resolution is disabled pending NIET approval');
    }
    if (input.outcome === 'WAIVED'
      && !this.config.get('ADMISSION_CONVERSION_EXCEPTION_WAIVER_ENABLED', { infer: true })) {
      throw new ForbiddenException('Conversion exception waiver is disabled pending NIET approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly CaseRow[]>(`SELECT c.*,conversion.converted_by
        FROM admissions.conversion_exception_cases c JOIN admissions.conversions conversion
        ON conversion.id=c.conversion_id WHERE c.id=$1 FOR UPDATE OF c`, [id]);
      const exceptionCase = rows[0];
      if (exceptionCase === undefined) throw new NotFoundException('Conversion exception not found');
      this.policy.assertScope(actor, exceptionCase.scope_type, exceptionCase.scope_id);
      const prior = await manager.query<readonly ResolutionRow[]>(
        'SELECT * FROM admissions.conversion_exception_resolutions WHERE case_id=$1', [id]);
      if (prior[0] !== undefined) {
        if (sameResolution(prior[0], input, actor)) return { status: prior[0].outcome, replayed: true };
        throw new ConflictException('Conversion exception already has different resolution evidence');
      }
      if (exceptionCase.status !== 'OPEN' || exceptionCase.version !== input.expectedVersion) {
        throw new ConflictException('Conversion exception is not the expected open version');
      }
      if (actor.subjectId === exceptionCase.detected_by || actor.subjectId === exceptionCase.converted_by) {
        throw new ForbiddenException('Detector or conversion actor cannot resolve the same exception');
      }
      if (input.outcome === 'RESOLVED') {
        const current = (await invariantRows(manager, exceptionCase.scope_type,
          exceptionCase.scope_id, 1, exceptionCase.conversion_id))[0];
        if (current === undefined || detectIssues(current).some((issue) => issue.code === exceptionCase.issue_code)) {
          throw new ConflictException('Conversion invariant is still failing; resolution cannot be recorded');
        }
      }
      const resolutionId = randomUUID();
      await manager.query(`INSERT INTO admissions.conversion_exception_resolutions
        (id,case_id,outcome,evaluation_engine,evaluation_version,policy_reference,
         evaluation_trace,reason,resolved_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [resolutionId, id, input.outcome, input.evaluationEngine, input.evaluationVersion,
        input.policyReference, JSON.stringify(input.evaluationTrace), input.reason, actor.subjectId]);
      await manager.query(`UPDATE admissions.conversion_exception_cases SET status=$2,version=version+1
        WHERE id=$1`, [id, input.outcome]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `admission.conversion-exception.${input.outcome.toLowerCase()}`,
        resourceType: 'admission-conversion-exception', resourceId: id,
        details: { resolutionId, conversionId: exceptionCase.conversion_id,
          issueCode: exceptionCase.issue_code, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion, policyReference: input.policyReference } });
      await this.evidence.outbox(manager, { eventType: input.outcome === 'RESOLVED'
        ? 'AdmissionConversionExceptionResolved' : 'AdmissionConversionExceptionWaived',
      aggregateType: 'admission-conversion-exception', aggregateId: id, classification: 'RESTRICTED',
      payload: { admissionConversionExceptionId: id, resolutionId } });
      return { status: input.outcome, replayed: false };
    });
  }
}

async function invariantRows(manager: EntityManager, scopeType: string, scopeId: string, limit: number,
  conversionId?: string): Promise<readonly InvariantRow[]> {
  return manager.query(`SELECT c.id conversion_id,c.application_id,c.offer_id,c.student_id,
    a.scope_type,a.scope_id,a.status application_status,o.status offer_status,
    s.source_system,s.source_key,
    (SELECT count(*)::int FROM finance.accounts fa WHERE fa.application_id=c.application_id) finance_accounts,
    (SELECT count(*)::int FROM finance.account_student_links fsl
      WHERE fsl.conversion_id=c.id AND fsl.application_id=c.application_id
        AND fsl.student_id=c.student_id) finance_links,
    EXISTS (SELECT 1 FROM admissions.offer_seat_reservations osr WHERE osr.offer_id=c.offer_id) has_seat,
    EXISTS (SELECT 1 FROM admissions.offer_seat_reservations osr
      JOIN admissions.seat_conversions sc ON sc.reservation_id=osr.reservation_id
      JOIN admissions.seat_reservations sr ON sr.id=osr.reservation_id
      WHERE osr.offer_id=c.offer_id AND sc.conversion_id=c.id AND sr.status='CONVERTED') seat_consumed
    FROM admissions.conversions c JOIN admissions.applications a ON a.id=c.application_id
    JOIN admissions.offers o ON o.id=c.offer_id JOIN student.records s ON s.id=c.student_id
    WHERE a.scope_type=$1 AND a.scope_id=$2 AND ($3::uuid IS NULL OR c.id=$3)
    ORDER BY c.id LIMIT $4`, [scopeType, scopeId, conversionId ?? null, limit]);
}
function detectIssues(row: InvariantRow): readonly { code: IssueCode; details: Record<string, unknown> }[] {
  const issues: { code: IssueCode; details: Record<string, unknown> }[] = [];
  if (row.application_status !== 'CONVERTED') issues.push({ code: 'APPLICATION_STATE_MISMATCH',
    details: { expected: 'CONVERTED', actual: row.application_status } });
  if (row.offer_status !== 'ACCEPTED') issues.push({ code: 'OFFER_STATE_MISMATCH',
    details: { expected: 'ACCEPTED', actual: row.offer_status } });
  if (row.source_system !== 'admissions' || row.source_key !== row.application_id) {
    issues.push({ code: 'STUDENT_SOURCE_MISMATCH', details: { expectedSourceSystem: 'admissions',
      sourceSystem: row.source_system, sourceKeyMatchesApplication: row.source_key === row.application_id } });
  }
  if (row.finance_accounts !== row.finance_links) issues.push({ code: 'FINANCE_LINK_MISSING',
    details: { applicantAccountCount: row.finance_accounts, linkedAccountCount: row.finance_links } });
  if (row.has_seat && !row.seat_consumed) issues.push({ code: 'SEAT_CONSUMPTION_MISMATCH',
    details: { offerHasReservation: true, reservationConsumedByConversion: false } });
  return issues;
}
function toView(row: CaseRow): ConversionExceptionView {
  return { id: row.id, conversionId: row.conversion_id, issueCode: row.issue_code,
    details: row.details, status: row.status, version: row.version,
    detectedAt: row.detected_at.toISOString() };
}
function sameResolution(row: ResolutionRow, input: ResolveConversionExceptionDto, actor: Principal): boolean {
  return row.outcome === input.outcome && row.evaluation_engine === input.evaluationEngine
    && row.evaluation_version === input.evaluationVersion && row.policy_reference === input.policyReference
    && canonicalJson(row.evaluation_trace) === canonicalJson(input.evaluationTrace)
    && row.reason === input.reason && row.resolved_by === actor.subjectId;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

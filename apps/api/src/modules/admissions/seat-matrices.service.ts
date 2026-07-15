import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateSeatMatrixDto, PublishSeatMatrixDto, ReserveSeatDto } from './seat-matrices.dto';
interface MatrixRow { id: string; matrix_key: string; version: number; title: string;
  programme_key: string; cycle_key: string; scope_type: string; scope_id: string;
  idempotency_key: string; category_count: number; category_manifest_sha256: string;
  status: 'DRAFT' | 'PUBLISHED'; record_version: number; policy_decision_reference: string | null;
  created_by: string; published_by: string | null }
interface ReservationRow { id: string; matrix_id: string; application_id: string; category_id: string;
  slot_id: string; idempotency_key: string; evaluation_engine: string; evaluation_version: string;
  policy_reference: string; evaluation_trace: Record<string, unknown>; reason: string;
  reserved_by: string; slot_number: number; category_key: string; merit_entry_id: string | null }
export interface SeatAvailability { readonly categoryKey: string; readonly title: string;
  readonly capacity: number; readonly reserved: number; readonly converted: number;
  readonly available: number }
@Injectable()
export class SeatMatricesService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateSeatMatrixDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    if (new Set(input.categories.map((category) => category.allocationOrder)).size !== input.categories.length) {
      throw new ConflictException('Seat category allocation order must be unique');
    }
    const totalCapacity = input.categories.reduce((sum, category) => sum + category.capacity, 0);
    if (totalCapacity > 50_000) throw new ConflictException('Seat matrix exceeds supported operational capacity');
    const manifest = categoryManifest(input);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['admission-seat-matrix', input.idempotencyKey])]);
      const existing = await manager.query<readonly MatrixRow[]>(
        'SELECT * FROM admissions.seat_matrices WHERE idempotency_key=$1 FOR UPDATE', [input.idempotencyKey]);
      if (existing[0] !== undefined) return replayCreate(existing[0], input, manifest, actor);
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO admissions.seat_matrices
          (id,matrix_key,version,title,programme_key,cycle_key,scope_type,scope_id,idempotency_key,
           category_count,category_manifest_sha256,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, input.matrixKey,
          input.version, input.title, input.programmeKey, input.cycleKey, input.scopeType,
          input.scopeId, input.idempotencyKey, input.categories.length, manifest, actor.subjectId]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Seat matrix version already exists');
        throw error;
      }
      for (const category of input.categories) {
        const categoryId = randomUUID();
        await manager.query(`INSERT INTO admissions.seat_categories
          (id,matrix_id,category_key,title,capacity,allocation_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [categoryId, id, category.categoryKey, category.title, category.capacity, category.allocationOrder]);
        await manager.query(`INSERT INTO admissions.seat_slots(id,category_id,slot_number)
          SELECT gen_random_uuid(),$1,generate_series(1,$2)`, [categoryId, category.capacity]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.seat-matrix.drafted', resourceType: 'admission-seat-matrix', resourceId: id,
        details: { matrixKey: input.matrixKey, version: input.version, programmeKey: input.programmeKey,
          cycleKey: input.cycleKey, totalCapacity, categoryManifestSha256: manifest,
          scopeType: input.scopeType, scopeId: input.scopeId } });
      return { id, replayed: false };
    });
  }
  async publish(id: string, input: PublishSeatMatrixDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    this.assertEnabled('ADMISSION_SEAT_MATRIX_PUBLICATION_ENABLED',
      'Seat matrix publication is disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly MatrixRow[]>(
        'SELECT * FROM admissions.seat_matrices WHERE id=$1 FOR UPDATE', [id]);
      const matrix = rows[0];
      if (matrix === undefined) throw new NotFoundException('Seat matrix not found');
      this.policy.assertScope(actor, matrix.scope_type, matrix.scope_id);
      if (matrix.status === 'PUBLISHED') {
        if (matrix.policy_decision_reference === input.policyDecisionReference
          && matrix.published_by === actor.subjectId) return { replayed: true };
        throw new ConflictException('Seat matrix already has different publication evidence');
      }
      if (matrix.created_by === actor.subjectId) throw new ForbiddenException('Seat matrix maker cannot publish it');
      if (matrix.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Seat matrix is not the expected draft version');
      }
      await manager.query(`UPDATE admissions.seat_matrices SET status='PUBLISHED',
        record_version=record_version+1,policy_decision_reference=$2,published_by=$3,
        published_at=clock_timestamp() WHERE id=$1`, [id, input.policyDecisionReference, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.seat-matrix.published', resourceType: 'admission-seat-matrix', resourceId: id,
        details: { matrixKey: matrix.matrix_key, version: matrix.version,
          policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionSeatMatrixPublished',
        aggregateType: 'admission-seat-matrix', aggregateId: id, classification: 'INTERNAL',
        payload: { admissionSeatMatrixId: id, matrixKey: matrix.matrix_key, version: matrix.version } });
      return { replayed: false };
    });
  }
  async reserve(matrixId: string, input: ReserveSeatDto,
    actor: Principal): Promise<{ id: string; slotNumber: number; replayed: boolean }> {
    this.assertEnabled('ADMISSION_SEAT_RESERVATION_ENABLED',
      'Seat reservation is disabled pending NIET approval');
    return this.dataSource.transaction(async (manager) => {
      const matrices = await manager.query<readonly MatrixRow[]>(
        'SELECT * FROM admissions.seat_matrices WHERE id=$1 FOR SHARE', [matrixId]);
      const matrix = matrices[0];
      if (matrix === undefined) throw new NotFoundException('Seat matrix not found');
      this.policy.assertScope(actor, matrix.scope_type, matrix.scope_id);
      const existing = await manager.query<readonly ReservationRow[]>(`SELECT r.*,s.slot_number,c.category_key,
        mers.merit_entry_id
        FROM admissions.seat_reservations r JOIN admissions.seat_slots s ON s.id=r.slot_id
        JOIN admissions.seat_categories c ON c.id=r.category_id
        LEFT JOIN admissions.merit_entry_seat_reservations mers ON mers.reservation_id=r.id
        WHERE r.idempotency_key=$1 FOR UPDATE OF r`, [input.idempotencyKey]);
      if (existing[0] !== undefined) return replayReservation(existing[0], matrixId, input, actor);
      if (matrix.status !== 'PUBLISHED' || matrix.record_version !== input.expectedMatrixRecordVersion) {
        throw new ConflictException('Seat matrix is not the expected published version');
      }
      const applications = await manager.query<readonly { id: string; status: string; programme_key: string;
        scope_type: string; scope_id: string }[]>(
        'SELECT id,status,programme_key,scope_type,scope_id FROM admissions.applications WHERE id=$1 FOR UPDATE',
      [input.applicationId]);
      const application = applications[0];
      if (application === undefined) throw new NotFoundException('Admission application not found');
      if (application.status !== 'OFFERED' || application.programme_key !== matrix.programme_key
        || application.scope_type !== matrix.scope_type || application.scope_id !== matrix.scope_id) {
        throw new ConflictException('Application is not eligible for this published seat matrix');
      }
      const categories = await manager.query<readonly { id: string }[]>(`SELECT id FROM admissions.seat_categories
        WHERE matrix_id=$1 AND category_key=$2`, [matrixId, input.categoryKey]);
      const category = categories[0];
      if (category === undefined) throw new ConflictException('Seat category is not in this matrix');
      if (this.config.get('ADMISSION_MERIT_SEAT_ENFORCEMENT_ENABLED', { infer: true })
        && input.meritEntryId === undefined) {
        throw new ConflictException('A published merit entry is required for seat reservation');
      }
      if (input.meritEntryId !== undefined) {
        const meritEntries = await manager.query<readonly { id: string }[]>(`SELECT e.id
          FROM admissions.merit_list_entries e JOIN admissions.merit_lists l ON l.id=e.list_id
          WHERE e.id=$1 AND e.application_id=$2 AND e.category_key=$3 AND l.status='PUBLISHED'
            AND l.programme_key=$4 AND l.cycle_key=$5 AND l.scope_type=$6 AND l.scope_id=$7 FOR SHARE OF e,l`,
        [input.meritEntryId, input.applicationId, input.categoryKey, matrix.programme_key,
          matrix.cycle_key, matrix.scope_type, matrix.scope_id]);
        if (meritEntries[0] === undefined) {
          throw new ConflictException('Merit entry is not eligible for this seat reservation');
        }
      }
      const slots = await manager.query<readonly { id: string; slot_number: number }[]>(`SELECT s.id,s.slot_number
        FROM admissions.seat_slots s WHERE s.category_id=$1 AND NOT EXISTS (
          SELECT 1 FROM admissions.seat_reservations r WHERE r.slot_id=s.id
            AND r.status IN ('RESERVED','CONVERTED'))
        ORDER BY s.slot_number LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, [category.id]);
      const slot = slots[0];
      if (slot === undefined) throw new ConflictException('Seat category has no available capacity');
      const id = randomUUID();
      await manager.query(`INSERT INTO admissions.seat_reservations
        (id,matrix_id,category_id,slot_id,application_id,idempotency_key,evaluation_engine,
         evaluation_version,policy_reference,evaluation_trace,reason,reserved_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [id, matrixId, category.id,
        slot.id, input.applicationId, input.idempotencyKey, input.evaluationEngine,
        input.evaluationVersion, input.policyReference, JSON.stringify(input.evaluationTrace),
        input.reason, actor.subjectId]);
      if (input.meritEntryId !== undefined) {
        await manager.query(`INSERT INTO admissions.merit_entry_seat_reservations
          (merit_entry_id,reservation_id) VALUES ($1,$2)`, [input.meritEntryId, id]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.seat.reserved', resourceType: 'admission-seat-reservation', resourceId: id,
        details: { admissionApplicationId: input.applicationId, admissionSeatMatrixId: matrixId,
          categoryKey: input.categoryKey, slotNumber: slot.slot_number,
          meritEntryId: input.meritEntryId,
          evaluationEngine: input.evaluationEngine, evaluationVersion: input.evaluationVersion,
          policyReference: input.policyReference } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionSeatReserved',
        aggregateType: 'admission-seat-reservation', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionSeatReservationId: id, admissionApplicationId: input.applicationId } });
      return { id, slotNumber: slot.slot_number, replayed: false };
    });
  }
  async availability(id: string, actor: Principal): Promise<{ items: SeatAvailability[] }> {
    const matrices = await this.dataSource.query<readonly MatrixRow[]>(
      'SELECT * FROM admissions.seat_matrices WHERE id=$1', [id]);
    const matrix = matrices[0];
    if (matrix === undefined) throw new NotFoundException('Seat matrix not found');
    this.policy.assertScope(actor, matrix.scope_type, matrix.scope_id);
    const rows = await this.dataSource.query<readonly { category_key: string; title: string;
      capacity: number; reserved: number; converted: number }[]>(`SELECT c.category_key,c.title,c.capacity,
      count(r.id) FILTER (WHERE r.status='RESERVED')::int reserved,
      count(r.id) FILTER (WHERE r.status='CONVERTED')::int converted FROM admissions.seat_categories c
      LEFT JOIN admissions.seat_slots s ON s.category_id=c.id
      LEFT JOIN admissions.seat_reservations r ON r.slot_id=s.id
        AND r.status IN ('RESERVED','CONVERTED')
      WHERE c.matrix_id=$1 GROUP BY c.id,c.category_key,c.title,c.capacity,c.allocation_order
      ORDER BY c.allocation_order`, [id]);
    return { items: rows.map((row) => ({ categoryKey: row.category_key, title: row.title,
      capacity: row.capacity, reserved: row.reserved, converted: row.converted,
      available: row.capacity - row.reserved - row.converted })) };
  }
  private assertEnabled(key: keyof Pick<Environment, 'ADMISSION_SEAT_MATRIX_PUBLICATION_ENABLED'
    | 'ADMISSION_SEAT_RESERVATION_ENABLED'>, message: string): void {
    if (!this.config.get(key, { infer: true })) throw new ForbiddenException(message);
  }
}
function categoryManifest(input: CreateSeatMatrixDto): string {
  const value = [...input.categories].sort((a, b) => a.allocationOrder - b.allocationOrder)
    .map((category) => [category.categoryKey, category.title, String(category.capacity),
      String(category.allocationOrder)].map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('')).join('');
  return createHash('sha256').update(value).digest('hex');
}
function replayCreate(row: MatrixRow, input: CreateSeatMatrixDto, manifest: string,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.matrix_key !== input.matrixKey || row.version !== input.version || row.title !== input.title
    || row.programme_key !== input.programmeKey || row.cycle_key !== input.cycleKey
    || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
    || row.category_count !== input.categories.length || row.category_manifest_sha256 !== manifest
    || row.created_by !== actor.subjectId) throw new ConflictException('Seat matrix replay has different content');
  return { id: row.id, replayed: true };
}
function replayReservation(row: ReservationRow, matrixId: string, input: ReserveSeatDto,
  actor: Principal): { id: string; slotNumber: number; replayed: boolean } {
  if (row.matrix_id !== matrixId || row.application_id !== input.applicationId
    || row.merit_entry_id !== (input.meritEntryId ?? null)
    || row.category_key !== input.categoryKey || row.evaluation_engine !== input.evaluationEngine
    || row.evaluation_version !== input.evaluationVersion || row.policy_reference !== input.policyReference
    || canonicalJson(row.evaluation_trace) !== canonicalJson(input.evaluationTrace)
    || row.reason !== input.reason || row.reserved_by !== actor.subjectId) {
    throw new ConflictException('Seat reservation replay has different content');
  }
  return { id: row.id, slotNumber: row.slot_number, replayed: true };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

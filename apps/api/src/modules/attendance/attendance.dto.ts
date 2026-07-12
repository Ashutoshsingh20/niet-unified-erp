import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID,
  Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CreateTeachingSessionDto {
  @IsUUID() offeringId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) sessionKey!: string;
  @IsISO8601({ strict: true }) startsAt!: string;
  @IsISO8601({ strict: true }) endsAt!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

export class VersionedSessionCommandDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class RecordAttendanceObservationDto {
  @IsUUID() studentId!: string;
  @IsIn(['OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED'])
  presenceState!: 'OBSERVED_PRESENT' | 'OBSERVED_ABSENT' | 'NOT_OBSERVED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) sourceKind!: string;
  @IsOptional() @IsString() @MaxLength(300) sourceReference?: string;
  @IsISO8601({ strict: true }) observedAt!: string;
  @IsObject() evidence!: Record<string, unknown>;
}

export class FinalizeAttendanceDto extends VersionedSessionCommandDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class RequestAttendanceCorrectionDto {
  @IsUUID() studentId!: string;
  @IsIn(['OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED'])
  proposedState!: 'OBSERVED_PRESENT' | 'OBSERVED_ABSENT' | 'NOT_OBSERVED';
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class ApproveAttendanceCorrectionDto {
  @IsInt() @Min(1) expectedRequestVersion!: number;
  @IsInt() @Min(1) expectedSessionVersion!: number;
}

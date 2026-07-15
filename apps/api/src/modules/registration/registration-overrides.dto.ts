import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject,
  IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRegistrationOverrideDto {
  @IsUUID() studentId!: string;
  @IsUUID() periodId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('4', { each: true })
  offeringIds!: string[];
  @IsIn(['CREDIT_LIMIT', 'ADVISER_APPROVAL', 'TIMETABLE_CONFLICT', 'CAPACITY'])
  exceptionType!: 'CREDIT_LIMIT' | 'ADVISER_APPROVAL' | 'TIMETABLE_CONFLICT' | 'CAPACITY';
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

export class DecideRegistrationOverrideDto {
  @IsIn(['APPROVED', 'REJECTED']) outcome!: 'APPROVED' | 'REJECTED';
  @IsInt() @Min(1) expectedRecordVersion!: number;
}

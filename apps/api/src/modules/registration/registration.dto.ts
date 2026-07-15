import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsISO8601, IsIn, IsInt,
  IsBoolean, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength,
  ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAcademicPeriodDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) periodKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsISO8601({ strict: true }) startsAt!: string;
  @IsISO8601({ strict: true }) endsAt!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

export class PublishAcademicPeriodDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(200) policyDecisionReference!: string;
}

export class CreateOfferingDto {
  @IsUUID() periodId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,99}$/) offeringKey!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,99}$/) courseKey!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsInt() @Min(1) capacity!: number;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

export class PublishOfferingDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
}

export class RegistrationEligibilitySnapshotDto {
  @Matches(/^\d{1,6}(\.\d{1,2})?$/) requestedCreditUnits!: string;
  @Matches(/^\d{1,6}(\.\d{1,2})?$/) maximumCreditUnits!: string;
  @IsBoolean() adviserRequired!: boolean;
  @IsOptional() @IsUUID() adviserApprovalId?: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
}

export class SubmitRegistrationDto {
  @IsUUID() studentId!: string;
  @IsUUID() periodId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('4', { each: true })
  offeringIds!: string[];
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsOptional() @ValidateNested() @Type(() => RegistrationEligibilitySnapshotDto)
  eligibilitySnapshot?: RegistrationEligibilitySnapshotDto;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsUUID('4', { each: true })
  overrideAuthorizationIds?: string[];
}

export class WaitlistTermsDto {
  @IsISO8601({ strict: true }) expiresAt!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
}

export class DecideRegistrationDto {
  @IsIn(['CONFIRMED', 'WAITLISTED', 'REJECTED'])
  outcome!: 'CONFIRMED' | 'WAITLISTED' | 'REJECTED';
  @IsUUID() regulationId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,50}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @ValidateNested() @Type(() => WaitlistTermsDto) waitlistTerms?: WaitlistTermsDto;
}
export class PromoteWaitlistDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
}
export class WithdrawRegistrationDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
}

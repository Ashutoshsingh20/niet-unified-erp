import { IsIn, IsInt, IsObject, IsString, IsUUID, Matches, MaxLength, Min, MinLength }
  from 'class-validator';

export class CreateCapacityPoolDto {
  @IsUUID() offeringId!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) poolKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsInt() @Min(1) capacity!: number;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class PublishCapacityPoolDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}
export class CreateCapacityEntitlementDto {
  @IsUUID() studentId!: string;
  @IsUUID() poolId!: string;
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class DecideCapacityEntitlementDto {
  @IsIn(['APPROVED', 'REJECTED']) outcome!: 'APPROVED' | 'REJECTED';
  @IsInt() @Min(1) expectedRecordVersion!: number;
}

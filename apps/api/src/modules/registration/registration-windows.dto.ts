import { IsISO8601, IsIn, IsInt, IsString, IsUUID, Matches, MaxLength, Min,
  MinLength } from 'class-validator';
export class CreateRegistrationWindowDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) windowKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsUUID() periodId!: string;
  @IsIn(['SUBMISSION','ADD_DROP']) windowType!: 'SUBMISSION' | 'ADD_DROP';
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsISO8601({ strict: true }) opensAt!: string;
  @IsISO8601({ strict: true }) closesAt!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsUUID() idempotencyKey!: string;
}
export class PublishRegistrationWindowDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}
export class ActiveRegistrationWindowQueryDto {
  @IsUUID() periodId!: string;
  @IsIn(['SUBMISSION','ADD_DROP']) windowType!: 'SUBMISSION' | 'ADD_DROP';
}

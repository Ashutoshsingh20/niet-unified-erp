import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches,
  Max, MaxLength, Min, MinLength } from 'class-validator';

export class RequestStudentWithdrawalDto {
  @IsUUID() studentId!: string;
  @IsUUID() idempotencyKey!: string;
  @IsInt() @Min(1) expectedStudentVersion!: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class DecideStudentWithdrawalDto {
  @IsInt() @Min(1) expectedRequestVersion!: number;
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class StudentWithdrawalExceptionsQueryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() after?: string;
}

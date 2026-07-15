import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength,
  Min, MinLength } from 'class-validator';

export class ScanConversionExceptionsDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit = 500;
}
export class ConversionExceptionsQueryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsOptional() @IsIn(['OPEN','RESOLVED','WAIVED']) status?: 'OPEN' | 'RESOLVED' | 'WAIVED';
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() after?: string;
}
export class ResolveConversionExceptionDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsIn(['RESOLVED','WAIVED']) outcome!: 'RESOLVED' | 'WAIVED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

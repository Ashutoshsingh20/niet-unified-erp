import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsObject, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
export class SeatCategoryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) categoryKey!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsInt() @Min(1) @Max(10_000) capacity!: number;
  @IsInt() @Min(1) @Max(100) allocationOrder!: number;
}
export class CreateSeatMatrixDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) matrixKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) programmeKey!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) cycleKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsUUID() idempotencyKey!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ArrayUnique((category: SeatCategoryDto) => category.categoryKey)
  @ValidateNested({ each: true }) @Type(() => SeatCategoryDto) categories!: SeatCategoryDto[];
}
export class PublishSeatMatrixDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}
export class ReserveSeatDto {
  @IsUUID() applicationId!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) categoryKey!: string;
  @IsUUID() idempotencyKey!: string;
  @IsInt() @Min(1) expectedMatrixRecordVersion!: number;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

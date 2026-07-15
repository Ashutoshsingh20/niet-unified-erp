import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString,
  IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class FeeStructureLineDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) lineKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) feeHeadKey!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) installmentKey!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dueOn!: string;
  @Matches(/^[1-9][0-9]{0,14}$/) amountMinor!: string;
  @IsInt() @Min(1) @Max(10_000) allocationOrder!: number;
}

export class CreateFeeStructureDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) structureKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsUUID() idempotencyKey!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ArrayUnique((line: FeeStructureLineDto) => line.lineKey)
  @ValidateNested({ each: true }) @Type(() => FeeStructureLineDto)
  lines!: FeeStructureLineDto[];
}

export class PublishFeeStructureDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}

export class RaiseGovernedDemandDto {
  @IsUUID() accountId!: string;
  @IsUUID() idempotencyKey!: string;
  @IsInt() @Min(1) expectedStructureRecordVersion!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ArrayUnique()
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/, { each: true }) lineKeys!: string[];
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

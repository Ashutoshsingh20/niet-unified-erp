import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsObject, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class MeritListEntryDto {
  @IsUUID() applicationId!: string;
  @IsInt() @Min(1) @Max(1_000_000) meritRank!: number;
  @IsInt() @Min(1) @Max(1_000_000) allocationOrder!: number;
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) categoryKey!: string;
  @IsString() @MinLength(1) @MaxLength(100) scoreDisplay!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class CreateMeritListDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) listKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) programmeKey!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) cycleKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsString() @MinLength(3) @MaxLength(300) sourceEvidenceReference!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10_000)
  @ArrayUnique((entry: MeritListEntryDto) => entry.applicationId)
  @ArrayUnique((entry: MeritListEntryDto) => entry.allocationOrder)
  @ValidateNested({ each: true }) @Type(() => MeritListEntryDto) entries!: MeritListEntryDto[];
}

export class PublishMeritListDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) publicationReference!: string;
}

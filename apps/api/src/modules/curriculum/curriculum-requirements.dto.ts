import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject,
  IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class CourseCatalogueEntryDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) courseKey!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @Matches(/^\d{1,6}(\.\d{1,2})?$/) creditUnits!: string;
  @IsObject() attributes!: Record<string, unknown>;
}

export class CreateCourseCatalogueDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) catalogueKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsUUID() regulationId!: string;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ArrayUnique((item: CourseCatalogueEntryDto) => item.courseKey)
  @ValidateNested({ each: true }) @Type(() => CourseCatalogueEntryDto)
  entries!: CourseCatalogueEntryDto[];
}

export class PublishCurriculumConfigurationDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}

export class RequirementClauseDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) clauseKey!: string;
  @IsInt() @Min(1) sequence!: number;
  @IsIn(['COURSE_COMPLETION','MINIMUM_GRADE','MINIMUM_CREDITS','COREQUISITE','BASKET',
    'EQUIVALENCE','TRANSFER','RPL','MOOC','ABC_APAAR','CUSTOM'])
  clauseType!: 'COURSE_COMPLETION' | 'MINIMUM_GRADE' | 'MINIMUM_CREDITS' | 'COREQUISITE'
    | 'BASKET' | 'EQUIVALENCE' | 'TRANSFER' | 'RPL' | 'MOOC' | 'ABC_APAAR' | 'CUSTOM';
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsObject() ruleDocument!: Record<string, unknown>;
}

export class CreateRequirementSetDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) requirementKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsIn(['COURSE_ELIGIBILITY','DEGREE_AUDIT'])
  requirementType!: 'COURSE_ELIGIBILITY' | 'DEGREE_AUDIT';
  @IsUUID() programmeVersionId!: string;
  @IsUUID() catalogueId!: string;
  @IsOptional() @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) targetCourseKey?: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationContractVersion!: string;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ArrayUnique((item: RequirementClauseDto) => item.clauseKey)
  @ValidateNested({ each: true }) @Type(() => RequirementClauseDto)
  clauses!: RequirementClauseDto[];
}

export class RequirementEvaluationResultDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) clauseKey!: string;
  @IsIn(['SATISFIED','UNSATISFIED','UNKNOWN','NOT_APPLICABLE'])
  outcome!: 'SATISFIED' | 'UNSATISFIED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
  @IsString() @MinLength(3) @MaxLength(1000) explanation!: string;
  @IsObject() evidenceTrace!: Record<string, unknown>;
}

export class CreateRequirementEvaluationDto {
  @IsUUID() requirementSetId!: string;
  @IsUUID() studentId!: string;
  @IsIn(['REGISTRATION','DEGREE_AUDIT','WHAT_IF'])
  evaluationMode!: 'REGISTRATION' | 'DEGREE_AUDIT' | 'WHAT_IF';
  @Matches(/^[0-9a-f]{64}$/) candidateManifestSha256!: string;
  @Matches(/^[0-9a-f]{64}$/) sourceEvidenceManifestSha256!: string;
  @IsIn(['ELIGIBLE','INELIGIBLE','INCOMPLETE']) result!: 'ELIGIBLE' | 'INELIGIBLE' | 'INCOMPLETE';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluatorEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluatorVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(2000) explanationSummary!: string;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ArrayUnique((item: RequirementEvaluationResultDto) => item.clauseKey)
  @ValidateNested({ each: true }) @Type(() => RequirementEvaluationResultDto)
  clauseResults!: RequirementEvaluationResultDto[];
}

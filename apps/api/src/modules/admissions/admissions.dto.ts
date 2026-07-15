import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBase64, IsBoolean, IsIn,
  IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  MinLength, ValidateNested, IsISO8601 } from 'class-validator';
export class CreateApplicationDto {
  @IsString() @MinLength(1) @MaxLength(200) applicantSubjectId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) programmeKey!: string;
  @IsBase64() encryptedPayloadBase64!: string;
  @IsString() @MinLength(3) @MaxLength(200) encryptionKeyReference!: string;
  @Matches(/^[a-f0-9]{64}$/) payloadSha256!: string;
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class SubmitApplicationDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Matches(/^[a-f0-9]{64}$/) evidenceManifestSha256!: string;
}
export class DecideApplicationDto {
  @IsIn(['OFFERED','REJECTED']) outcome!: 'OFFERED' | 'REJECTED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) regulationReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
}
export class IssueAdmissionOfferDto {
  @Matches(/^[a-zA-Z0-9_.-]{3,100}$/) offerReference!: string;
  @Matches(/^[a-f0-9]{64}$/) termsManifestSha256!: string;
  @IsISO8601({ strict: true }) expiresAt!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsInt() @Min(1) expectedApplicationVersion!: number;
}
export class AcceptAdmissionOfferDto {
  @IsInt() @Min(1) expectedOfferVersion!: number;
}
export class TransitionAdmissionOfferDto {
  @IsInt() @Min(1) expectedOfferVersion!: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
}
export class AdmissionOfferExceptionsQueryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsISO8601({ strict: true }) dueBefore!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() after?: string;
}
export class RequestAdmissionCancellationDto {
  @IsUUID() idempotencyKey!: string;
  @IsInt() @Min(1) expectedOfferVersion!: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class AssessAdmissionCancellationDto {
  @IsInt() @Min(1) expectedRequestVersion!: number;
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsIn(['NOT_APPLICABLE', 'NO_REFUND_REQUIRED', 'FINANCE_REVIEW_REQUIRED'])
  financialDisposition!: 'NOT_APPLICABLE' | 'NO_REFUND_REQUIRED' | 'FINANCE_REVIEW_REQUIRED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class AdmissionCancellationExceptionsQueryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() after?: string;
}
export class ConvertAdmissionDto {
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) displayName!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) mappingEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) mappingVersion!: string;
  @IsObject() mappingTrace!: Record<string, unknown>;
  @IsInt() @Min(1) expectedOfferVersion!: number;
}

export class AdmissionChecklistItemDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,99}$/) requirementKey!: string;
  @IsString() @MinLength(3) @MaxLength(150) title!: string;
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/) documentTypeKey!: string;
  @IsBoolean() required!: boolean;
}

export class CreateAdmissionChecklistDto {
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsInt() @Min(1) expectedApplicationVersion!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ArrayUnique((item: AdmissionChecklistItemDto) => item.requirementKey)
  @ValidateNested({ each: true }) @Type(() => AdmissionChecklistItemDto)
  items!: AdmissionChecklistItemDto[];
}

export class PublishAdmissionChecklistDto {
  @IsInt() @Min(1) expectedChecklistVersion!: number;
}

export class AttachAdmissionDocumentDto {
  @IsUUID() documentId!: string;
}

export class VerifyAdmissionDocumentDto {
  @IsIn(['VERIFIED', 'REJECTED']) outcome!: 'VERIFIED' | 'REJECTED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) verificationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) verificationVersion!: string;
  @IsObject() verificationTrace!: Record<string, unknown>;
  @Matches(/^[a-f0-9]{64}$/) evidenceSha256!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class AdmissionDocumentExceptionsQueryDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @IsUUID() after?: string;
}

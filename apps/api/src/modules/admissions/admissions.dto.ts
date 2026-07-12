import { IsBase64, IsIn, IsInt, IsObject, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
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
  @IsInt() @Min(1) expectedApplicationVersion!: number;
}
export class AcceptAdmissionOfferDto {
  @IsInt() @Min(1) expectedOfferVersion!: number;
}
export class ConvertAdmissionDto {
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) displayName!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) mappingEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) mappingVersion!: string;
  @IsObject() mappingTrace!: Record<string, unknown>;
  @IsInt() @Min(1) expectedOfferVersion!: number;
}

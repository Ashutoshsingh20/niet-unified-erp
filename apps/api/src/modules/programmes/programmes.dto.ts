import { IsDateString, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
export class CreateProgrammeVersionDto {
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) programmeKey!: string;
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsUUID() regulationId!: string;
  @Matches(/^[a-f0-9]{64}$/) structureManifestSha256!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class PublishProgrammeVersionDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}
export class AssignProgrammeDto {
  @IsUUID() studentId!: string;
  @IsUUID() programmeVersionId!: string;
  @IsDateString() startsOn!: string;
  @IsOptional() @IsDateString() endsOn?: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) assignmentEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) assignmentVersion!: string;
  @IsObject() assignmentTrace!: Record<string, unknown>;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class ActivateProgrammeEnrolmentDto { @IsInt() @Min(1) expectedVersion!: number; }

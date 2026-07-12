import { IsBase64, IsISO8601, IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CreateMigrationBatchDto {
  @Matches(/^[a-zA-Z0-9_.-]{3,100}$/) batchKey!: string;
  @IsString() @MinLength(2) @MaxLength(100) sourceSystem!: string;
  @Matches(/^[a-f0-9]{64}$/) sourceManifestSha256!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) mappingVersion!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class StageMigrationRowDto {
  @IsString() @MinLength(1) @MaxLength(300) sourceKey!: string;
  @Matches(/^[a-f0-9]{64}$/) sourceRowSha256!: string;
  @IsISO8601({ strict: true }) extractedAt!: string;
  @IsBase64() encryptedCandidateBase64!: string;
  @IsString() @MinLength(3) @MaxLength(200) encryptionKeyReference!: string;
}
export class VersionedMigrationCommandDto { @IsInt() @Min(1) expectedVersion!: number; }
export class ReconcileMigrationDto extends VersionedMigrationCommandDto {
  @Matches(/^[0-9]{1,18}$/) expectedRowCount!: string;
  @Matches(/^[a-f0-9]{64}$/) expectedRowsSha256!: string;
}
export class ApproveMigrationDto extends VersionedMigrationCommandDto {
  @IsString() @MinLength(3) @MaxLength(300) reconciliationReference!: string;
}

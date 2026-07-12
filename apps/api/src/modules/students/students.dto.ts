import { IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateStudentRecordDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  sourceSystem!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceKey!: string;

  @IsISO8601({ strict: true })
  sourceExtractedAt!: string;

  @Matches(/^[a-zA-Z0-9_.-]{1,50}$/)
  mappingVersion!: string;

  @Matches(/^[a-f0-9]{64}$/)
  sourceRowSha256!: string;

  @IsOptional()
  @IsUUID()
  migrationBatchId?: string;
}

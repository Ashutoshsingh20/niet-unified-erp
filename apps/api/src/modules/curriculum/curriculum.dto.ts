import { IsInt, IsObject, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRegulationVersionDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  regulationKey!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @Matches(/^[a-zA-Z0-9_.-]{1,50}$/)
  ruleSchemaVersion!: string;

  @IsObject()
  ruleDocument!: Record<string, unknown>;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  impactSummary!: string;
}

export class PublishRegulationVersionDto {
  @IsInt()
  @Min(1)
  expectedRecordVersion!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  policyDecisionReference!: string;
}

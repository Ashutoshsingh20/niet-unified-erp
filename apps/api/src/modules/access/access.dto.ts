import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateOrganizationUnitDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  unitKey!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  unitType!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsISO8601({ strict: true })
  effectiveFrom!: string;
}

export class CreateRoleDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  roleKey!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(150)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9_.:-]{2,149}$/, { each: true })
  permissions!: string[];
}

export class AssignRoleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId!: string;

  @IsUUID()
  roleId!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveUntil?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class RevokeAssignmentDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class CreateDelegationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  delegateSubjectId!: string;

  @Matches(/^[a-z][a-z0-9_.:-]{2,149}$/)
  permission!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @IsISO8601({ strict: true })
  effectiveUntil!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class CreateAccessReviewDto {
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

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reviewerSubjectId!: string;

  @IsISO8601({ strict: true })
  dueAt!: string;
}

export class DecideAccessReviewItemDto {
  @Matches(/^(RETAIN|REVOKE)$/)
  decision!: 'RETAIN' | 'REVOKE';

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  @IsInt()
  @Min(1)
  expectedAssignmentVersion!: number;
}

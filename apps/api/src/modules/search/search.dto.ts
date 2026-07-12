import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

export class UpsertSearchRecordDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  sourceType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceId!: string;

  @IsInt()
  @Min(1)
  sourceVersion!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  summary!: string;

  @Matches(/^[a-z][a-z0-9_.:-]{2,149}$/)
  requiredPermission!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @IsIn(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
  classification!: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

  @Matches(/^\/[a-zA-Z0-9/_?=&.-]{1,500}$/)
  actionPath!: string;
}


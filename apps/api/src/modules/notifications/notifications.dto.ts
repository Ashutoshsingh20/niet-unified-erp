import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateNotificationTemplateDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  templateKey!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleTemplate!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  bodyTemplate!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Matches(/^[a-z][a-zA-Z0-9]{0,49}$/, { each: true })
  requiredVariables!: string[];

  @IsBoolean()
  allowExternalPush!: boolean;
}

export class CreateNotificationDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  templateKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  recipientSubjectId!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;

  @IsObject()
  variables!: Record<string, unknown>;

  @IsIn(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
  classification!: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

  @IsOptional()
  @Matches(/^\/[a-zA-Z0-9/_?=&.-]{1,500}$/)
  actionPath?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

export class UpdateNotificationPreferencesDto {
  @IsBoolean()
  externalPushEnabled!: boolean;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  before?: string;
}

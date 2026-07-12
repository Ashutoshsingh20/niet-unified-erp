import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateWorkflowDefinitionDto {
  @ApiProperty({ example: 'student.generic-request' })
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  definitionKey!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @Matches(/^[a-z][a-z0-9_.:-]{2,149}$/)
  submitPermission!: string;

  @Matches(/^[a-z][a-z0-9_.:-]{2,149}$/)
  approvalPermission!: string;

  @IsBoolean()
  prohibitRequesterApproval!: boolean;
}

export class SubmitWorkflowRequestDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  definitionKey!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsObject()
  @IsNotEmptyObject()
  requestData!: Record<string, unknown>;
}

export class DecideWorkflowTaskDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}


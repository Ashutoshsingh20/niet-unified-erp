import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject,
  IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { RegistrationCapacityAssignmentDto, RegistrationEligibilitySnapshotDto } from './registration.dto';

export class CreateRegistrationAddDropDto {
  @IsUUID() registrationRequestId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('4', { each: true })
  beforeOfferingIds!: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('4', { each: true })
  afterOfferingIds!: string[];
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @ValidateNested() @Type(() => RegistrationEligibilitySnapshotDto)
  eligibilitySnapshot!: RegistrationEligibilitySnapshotDto;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsUUID('4', { each: true })
  overrideAuthorizationIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true })
  @Type(() => RegistrationCapacityAssignmentDto)
  capacityAssignments?: RegistrationCapacityAssignmentDto[];
}

export class DecideRegistrationAddDropDto {
  @IsIn(['APPROVED', 'REJECTED']) outcome!: 'APPROVED' | 'REJECTED';
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) evaluationEngine!: string;
  @Matches(/^[a-zA-Z0-9_.-]{1,100}$/) evaluationVersion!: string;
  @IsObject() evaluationTrace!: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
}

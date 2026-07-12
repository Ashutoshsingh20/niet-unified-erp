import { IsIn, IsInt, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
export class ProposeStudentHoldDto {
  @IsUUID() studentId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) holdKey!: string;
  @IsIn(['REGISTRATION_SUBMISSION']) effect!: 'REGISTRATION_SUBMISSION';
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class ActivateStudentHoldDto { @IsInt() @Min(1) expectedVersion!: number; }
export class ReleaseStudentHoldDto extends ActivateStudentHoldDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

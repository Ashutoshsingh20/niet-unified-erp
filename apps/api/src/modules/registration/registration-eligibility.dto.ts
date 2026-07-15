import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, IsUUID, Matches,
  MaxLength, MinLength } from 'class-validator';
export class CreateAdviserApprovalDto {
  @IsUUID() studentId!: string;
  @IsUUID() periodId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('4', { each: true })
  offeringIds!: string[];
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) policyReference!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

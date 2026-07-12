import { IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
export class CreateTimetableMeetingDto {
  @IsUUID() offeringId!: string;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) meetingKey!: string;
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @IsInt() @Min(0) @Max(1438) startMinute!: number;
  @IsInt() @Min(1) @Max(1439) endMinute!: number;
  @Matches(/^[a-zA-Z0-9_.-]{2,100}$/) roomKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) instructorSubjectId!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}
export class PublishTimetableMeetingDto {
  @IsInt() @Min(1) expectedRecordVersion!: number;
  @IsString() @MinLength(3) @MaxLength(300) policyDecisionReference!: string;
}

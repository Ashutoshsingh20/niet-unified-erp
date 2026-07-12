import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateStudentAccountDto {
  @IsUUID() studentId!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
}

export class PostFinanceTransactionDto {
  @IsUUID() accountId!: string;
  @Matches(/^[1-9][0-9]{0,14}$/) amountMinor!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class ReversePostingDto {
  @IsUUID() idempotencyKey!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

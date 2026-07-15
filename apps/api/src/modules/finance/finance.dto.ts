import { IsISO8601, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

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

export class RecordProviderPaymentDto {
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) providerKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) providerEventId!: string;
  @IsUUID() accountId!: string;
  @Matches(/^[1-9][0-9]{0,14}$/) amountMinor!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @Matches(/^[0-9a-f]{64}$/) payloadSha256!: string;
  @IsString() @MinLength(1) @MaxLength(100) verificationEngine!: string;
  @IsString() @MinLength(1) @MaxLength(100) verificationVersion!: string;
  @IsString() @MinLength(3) @MaxLength(300) verificationTraceReference!: string;
  @IsISO8601({ strict: true }) providerOccurredAt!: string;
}

export class IssueReceiptDto {
  @Matches(/^[0-9a-f]{64}$/) documentManifestSha256!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class CreateReconciliationDto {
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) providerKey!: string;
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/) scopeType!: string;
  @IsString() @MinLength(1) @MaxLength(200) scopeId!: string;
  @IsISO8601({ strict: true }) periodStart!: string;
  @IsISO8601({ strict: true }) periodEnd!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsInt() @Min(0) @Max(2_147_483_647) expectedEventCount!: number;
  @Matches(/^(0|[1-9][0-9]{0,14})$/) expectedAmountMinor!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class ApproveReconciliationDto {
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class RequestRefundDto {
  @IsUUID() idempotencyKey!: string;
  @Matches(/^[1-9][0-9]{0,14}$/) amountMinor!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

export class DecideRefundDto {
  @Matches(/^(APPROVED|REJECTED)$/) decision!: 'APPROVED' | 'REJECTED';
  @ValidateIf((input: DecideRefundDto) => input.decision === 'APPROVED')
  @IsUUID() postingIdempotencyKey?: string;
  @IsString() @MinLength(3) @MaxLength(300) evidenceReference!: string;
}

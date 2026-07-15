import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import {
  ApproveReconciliationDto,
  CreateApplicantAccountDto,
  CreateReconciliationDto,
  CreateStudentAccountDto,
  DecideRefundDto,
  IssueReceiptDto,
  PostFinanceTransactionDto,
  RecordProviderPaymentDto,
  RequestRefundDto,
  ReversePostingDto,
} from './finance.dto';
import { FinanceService } from './finance.service';

@ApiTags('finance') @ApiBearerAuth() @Controller({ path: 'finance', version: '1' })
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}
  @Post('student-accounts') @RequirePermission('finance.student-account.create')
  @ApiCreatedResponse({ description: 'A currency-specific student account was created.' })
  createAccount(@Body() input: CreateStudentAccountDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.finance.createAccount(input, actor);
  }
  @Post('applicant-accounts') @RequirePermission('finance.applicant-account.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A currency-specific applicant account was created.' })
  createApplicantAccount(@Body() input: CreateApplicantAccountDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.createApplicantAccount(input, actor);
  }
  @Post('demands') @RequirePermission('finance.demand.raise', { stepUpLevel: 2 })
  postDemand(@Body() input: PostFinanceTransactionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.post(input, 'DEMAND', actor);
  }
  @Post('payments') @RequirePermission('finance.payment.post', { stepUpLevel: 2 })
  postPayment(@Body() input: PostFinanceTransactionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.post(input, 'PAYMENT', actor);
  }
  @Post('provider-events/payments') @RequirePermission('finance.provider-event.record', { stepUpLevel: 2 })
  recordProviderPayment(@Body() input: RecordProviderPaymentDto,
    @CurrentPrincipal() actor: Principal): Promise<{ providerEventId: string; postingId: string;
      replayed: boolean }> {
    return this.finance.recordProviderPayment(input, actor);
  }
  @Post('postings/:id/receipt') @RequirePermission('finance.receipt.issue', { stepUpLevel: 2 })
  issueReceipt(@Param('id', ParseUUIDPipe) id: string, @Body() input: IssueReceiptDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.issueReceipt(id, input, actor);
  }
  @Post('reconciliations') @RequirePermission('finance.reconciliation.create', { stepUpLevel: 2 })
  createReconciliation(@Body() input: CreateReconciliationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; actualEventCount: number;
      actualAmountMinor: string; eventSetSha256: string; replayed: boolean }> {
    return this.finance.createReconciliation(input, actor);
  }
  @Post('reconciliations/:id/approval')
  @RequirePermission('finance.reconciliation.approve', { stepUpLevel: 2 })
  approveReconciliation(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: ApproveReconciliationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ approvalId: string; replayed: boolean }> {
    return this.finance.approveReconciliation(id, input, actor);
  }
  @Post('postings/:id/refund-requests') @RequirePermission('finance.refund.request', { stepUpLevel: 2 })
  requestRefund(@Param('id', ParseUUIDPipe) id: string, @Body() input: RequestRefundDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.requestRefund(id, input, actor);
  }
  @Post('refund-requests/:id/decision') @RequirePermission('finance.refund.decide', { stepUpLevel: 2 })
  decideRefund(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideRefundDto,
    @CurrentPrincipal() actor: Principal): Promise<{ decisionId: string; postingId: string | null;
      replayed: boolean }> {
    return this.finance.decideRefund(id, input, actor);
  }
  @Post('postings/:id/reversal') @RequirePermission('finance.reversal.approve', { stepUpLevel: 2 })
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() input: ReversePostingDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.reverse(id, input, actor);
  }
}

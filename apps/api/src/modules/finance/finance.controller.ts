import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateStudentAccountDto, PostFinanceTransactionDto, ReversePostingDto } from './finance.dto';
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
  @Post('postings/:id/reversal') @RequirePermission('finance.reversal.approve', { stepUpLevel: 2 })
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() input: ReversePostingDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.finance.reverse(id, input, actor);
  }
}

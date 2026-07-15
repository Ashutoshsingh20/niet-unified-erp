import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { DecideStudentWithdrawalDto, RequestStudentWithdrawalDto,
  StudentWithdrawalExceptionsQueryDto } from './student-withdrawals.dto';
import { StudentWithdrawalsService, type StudentWithdrawalException } from './student-withdrawals.service';

@ApiTags('student-withdrawals') @ApiBearerAuth()
@Controller({ path: 'student-withdrawals', version: '1' })
export class StudentWithdrawalsController {
  constructor(private readonly withdrawals: StudentWithdrawalsService) {}

  @Post() @RequirePermission('student.withdrawal.request')
  request(@Body() input: RequestStudentWithdrawalDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.withdrawals.request(input, actor);
  }

  @Post(':id/decision') @RequirePermission('student.withdrawal.decide', { stepUpLevel: 2 })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideStudentWithdrawalDto,
    @CurrentPrincipal() actor: Principal): Promise<{ status: 'REJECTED' | 'WITHDRAWN'; replayed: boolean }> {
    return this.withdrawals.decide(id, input, actor);
  }

  @Get('exceptions') @RequirePermission('student.withdrawal-exception.read')
  list(@Query() input: StudentWithdrawalExceptionsQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ items: StudentWithdrawalException[];
      nextCursor: string | null }> {
    return this.withdrawals.list(input, actor);
  }
}

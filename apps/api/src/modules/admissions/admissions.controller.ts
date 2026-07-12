import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { AdmissionsService } from './admissions.service';
import { CreateApplicationDto, DecideApplicationDto, SubmitApplicationDto } from './admissions.dto';
@ApiTags('admissions') @ApiBearerAuth() @Controller({ path: 'admissions', version: '1' })
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}
  @Post('applications') @RequirePermission('admission.application.create')
  create(@Body() input: CreateApplicationDto, @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.admissions.create(input, actor);
  }
  @Post('applications/:id/submission') @RequirePermission('admission.application.submit')
  submit(@Param('id', ParseUUIDPipe) id: string, @Body() input: SubmitApplicationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.admissions.submit(id, input, actor); }
  @Post('applications/:id/decision') @RequirePermission('admission.application.decide', { stepUpLevel: 2 })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideApplicationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.admissions.decide(id, input, actor); }
}

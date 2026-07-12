import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { AdmissionsService } from './admissions.service';
import { AcceptAdmissionOfferDto, ConvertAdmissionDto, CreateApplicationDto,
  DecideApplicationDto, IssueAdmissionOfferDto, SubmitApplicationDto } from './admissions.dto';
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
  @Post('applications/:id/offer') @RequirePermission('admission.offer.issue', { stepUpLevel: 2 })
  issueOffer(@Param('id', ParseUUIDPipe) id: string, @Body() input: IssueAdmissionOfferDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.admissions.issueOffer(id, input, actor);
  }
  @Post('offers/:id/acceptance') @RequirePermission('admission.offer.accept')
  acceptOffer(@Param('id', ParseUUIDPipe) id: string, @Body() input: AcceptAdmissionOfferDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.admissions.acceptOffer(id, input, actor); }
  @Post('offers/:id/conversion') @RequirePermission('admission.conversion.execute', { stepUpLevel: 2 })
  convert(@Param('id', ParseUUIDPipe) id: string, @Body() input: ConvertAdmissionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ studentId: string; replayed: boolean }> {
    return this.admissions.convert(id, input, actor);
  }
}

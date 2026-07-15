import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { AdmissionsService, type AdmissionCancellationException,
  type AdmissionDocumentException, type AdmissionOfferException } from './admissions.service';
import { AcceptAdmissionOfferDto, AdmissionDocumentExceptionsQueryDto,
  AdmissionCancellationExceptionsQueryDto, AdmissionOfferExceptionsQueryDto,
  AssessAdmissionCancellationDto,
  AttachAdmissionDocumentDto, ConvertAdmissionDto, CreateAdmissionChecklistDto,
  CreateApplicationDto, DecideApplicationDto, IssueAdmissionOfferDto,
  PublishAdmissionChecklistDto, RequestAdmissionCancellationDto, SubmitApplicationDto,
  ResolveAdmissionCancellationFinanceDto,
  TransitionAdmissionOfferDto,
  VerifyAdmissionDocumentDto } from './admissions.dto';
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
  @Post('applications/:id/document-checklist')
  @RequirePermission('admission.document-checklist.configure', { stepUpLevel: 2 })
  createDocumentChecklist(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateAdmissionChecklistDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.admissions.createDocumentChecklist(id, input, actor);
  }
  @Post('document-checklists/:id/publication')
  @RequirePermission('admission.document-checklist.publish', { stepUpLevel: 2 })
  publishDocumentChecklist(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: PublishAdmissionChecklistDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.admissions.publishDocumentChecklist(id, input, actor);
  }
  @Post('document-checklist-items/:id/attachments')
  @RequirePermission('admission.document.attach')
  attachDocument(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: AttachAdmissionDocumentDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.admissions.attachDocument(id, input, actor);
  }
  @Post('document-attachments/:id/verification')
  @RequirePermission('admission.document.verify', { stepUpLevel: 2 })
  verifyDocument(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: VerifyAdmissionDocumentDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; checklistComplete: boolean;
      replayed: boolean }> {
    return this.admissions.verifyDocument(id, input, actor);
  }
  @Get('document-exceptions') @RequirePermission('admission.document-exception.read')
  listDocumentExceptions(@Query() input: AdmissionDocumentExceptionsQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ items: AdmissionDocumentException[];
      nextCursor: string | null }> {
    return this.admissions.listDocumentExceptions(input, actor);
  }
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
  @Post('offers/:id/decline') @RequirePermission('admission.offer.decline')
  declineOffer(@Param('id', ParseUUIDPipe) id: string, @Body() input: TransitionAdmissionOfferDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.admissions.declineOffer(id, input, actor);
  }
  @Post('offers/:id/withdrawal')
  @RequirePermission('admission.offer.withdraw', { stepUpLevel: 2 })
  withdrawOffer(@Param('id', ParseUUIDPipe) id: string, @Body() input: TransitionAdmissionOfferDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.admissions.withdrawOffer(id, input, actor);
  }
  @Post('offers/:id/expiration')
  @RequirePermission('admission.offer.expire', { stepUpLevel: 2 })
  expireOffer(@Param('id', ParseUUIDPipe) id: string, @Body() input: TransitionAdmissionOfferDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.admissions.expireOffer(id, input, actor);
  }
  @Get('offer-exceptions') @RequirePermission('admission.offer-exception.read')
  listOfferExceptions(@Query() input: AdmissionOfferExceptionsQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ items: AdmissionOfferException[];
      nextCursor: string | null }> {
    return this.admissions.listOfferExceptions(input, actor);
  }
  @Post('offers/:id/cancellation-requests') @RequirePermission('admission.cancellation.request')
  requestCancellation(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: RequestAdmissionCancellationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.admissions.requestCancellation(id, input, actor);
  }
  @Post('cancellation-requests/:id/assessment')
  @RequirePermission('admission.cancellation.assess', { stepUpLevel: 2 })
  assessCancellation(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: AssessAdmissionCancellationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ status: 'REJECTED' | 'PENDING_FINANCE' | 'CANCELLED';
      replayed: boolean }> {
    return this.admissions.assessCancellation(id, input, actor);
  }
  @Get('cancellation-exceptions') @RequirePermission('admission.cancellation-exception.read')
  listCancellationExceptions(@Query() input: AdmissionCancellationExceptionsQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ items: AdmissionCancellationException[];
      nextCursor: string | null }> {
    return this.admissions.listCancellationExceptions(input, actor);
  }
  @Post('cancellation-requests/:id/finance-resolution')
  @RequirePermission('admission.cancellation-finance.resolve', { stepUpLevel: 2 })
  resolveCancellationFinance(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: ResolveAdmissionCancellationFinanceDto,
    @CurrentPrincipal() actor: Principal): Promise<{ status: 'CANCELLED' | 'REJECTED';
      replayed: boolean }> {
    return this.admissions.resolveCancellationFinance(id, input, actor);
  }
  @Post('offers/:id/conversion') @RequirePermission('admission.conversion.execute', { stepUpLevel: 2 })
  convert(@Param('id', ParseUUIDPipe) id: string, @Body() input: ConvertAdmissionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ studentId: string; replayed: boolean }> {
    return this.admissions.convert(id, input, actor);
  }
}

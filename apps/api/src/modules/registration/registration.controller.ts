import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateAcademicPeriodDto, CreateOfferingDto, DecideRegistrationDto,
  PublishAcademicPeriodDto, PublishOfferingDto, SubmitRegistrationDto } from './registration.dto';
import { PromoteWaitlistDto, WithdrawRegistrationDto } from './registration.dto';
import { RegistrationService } from './registration.service';

@ApiTags('registration')
@ApiBearerAuth()
@Controller({ path: 'registration', version: '1' })
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post('academic-periods')
  @RequirePermission('registration.configuration.draft')
  @ApiCreatedResponse({ description: 'An academic period draft was created.' })
  createPeriod(@Body() input: CreateAcademicPeriodDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.registration.createPeriod(input, actor);
  }

  @Post('academic-periods/:id/publication')
  @HttpCode(204)
  @RequirePermission('registration.configuration.publish', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The approved academic period was published.' })
  publishPeriod(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishAcademicPeriodDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.registration.publishPeriod(id, input, actor);
  }

  @Post('offerings')
  @RequirePermission('registration.configuration.draft')
  createOffering(@Body() input: CreateOfferingDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.registration.createOffering(input, actor);
  }

  @Post('offerings/:id/publication')
  @HttpCode(204)
  @RequirePermission('registration.configuration.publish', { stepUpLevel: 2 })
  publishOffering(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishOfferingDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.registration.publishOffering(id, input, actor);
  }

  @Post('requests')
  @RequirePermission('registration.request.submit')
  createRequest(@Body() input: SubmitRegistrationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.registration.submit(input, actor);
  }

  @Post('requests/:id/decision')
  @HttpCode(204)
  @RequirePermission('registration.request.decide', { stepUpLevel: 2 })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideRegistrationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.registration.decide(id, input, actor);
  }
  @Post('requests/:id/waitlist-promotion') @HttpCode(204)
  @RequirePermission('registration.waitlist.promote', { stepUpLevel: 2 })
  promote(@Param('id', ParseUUIDPipe) id: string, @Body() input: PromoteWaitlistDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.registration.promote(id, input, actor); }
  @Post('requests/:id/withdrawal') @HttpCode(204)
  @RequirePermission('registration.request.withdraw')
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Body() input: WithdrawRegistrationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.registration.withdraw(id, input, actor); }
}

import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateAdviserApprovalDto } from './registration-eligibility.dto';
import { RegistrationEligibilityService } from './registration-eligibility.service';

@ApiTags('registration')
@ApiBearerAuth()
@Controller({ path: 'registration/adviser-approvals', version: '1' })
export class RegistrationEligibilityController {
  constructor(private readonly eligibility: RegistrationEligibilityService) {}

  @Post()
  @RequirePermission('registration.adviser-approval.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'Immutable adviser approval evidence was recorded.' })
  approve(@Body() input: CreateAdviserApprovalDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.eligibility.approve(input, actor);
  }
}

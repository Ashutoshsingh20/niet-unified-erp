import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateCapacityEntitlementDto, CreateCapacityPoolDto, DecideCapacityEntitlementDto,
  PublishCapacityPoolDto } from './registration-capacity.dto';
import { RegistrationCapacityService } from './registration-capacity.service';

@ApiTags('registration') @ApiBearerAuth()
@Controller({ path: 'registration/capacity', version: '1' })
export class RegistrationCapacityController {
  constructor(private readonly capacity: RegistrationCapacityService) {}
  @Post('pools') @RequirePermission('registration.capacity-pool.draft', { stepUpLevel: 2 })
  createPool(@Body() input: CreateCapacityPoolDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.capacity.createPool(input, actor);
  }
  @Post('pools/:id/publication') @HttpCode(204)
  @RequirePermission('registration.capacity-pool.publish', { stepUpLevel: 2 })
  publishPool(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishCapacityPoolDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.capacity.publishPool(id, input, actor); }
  @Post('entitlements')
  @RequirePermission('registration.capacity-entitlement.request', { stepUpLevel: 2 })
  createEntitlement(@Body() input: CreateCapacityEntitlementDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.capacity.createEntitlement(input, actor);
  }
  @Post('entitlements/:id/decision') @HttpCode(204)
  @RequirePermission('registration.capacity-entitlement.decide', { stepUpLevel: 2 })
  decideEntitlement(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: DecideCapacityEntitlementDto, @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.capacity.decideEntitlement(id, input, actor);
  }
}

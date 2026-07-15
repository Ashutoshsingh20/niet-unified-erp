import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateRegistrationOverrideDto, DecideRegistrationOverrideDto }
  from './registration-overrides.dto';
import { RegistrationOverridesService } from './registration-overrides.service';

@ApiTags('registration') @ApiBearerAuth()
@Controller({ path: 'registration/overrides', version: '1' })
export class RegistrationOverridesController {
  constructor(private readonly overrides: RegistrationOverridesService) {}
  @Post() @RequirePermission('registration.override.request', { stepUpLevel: 2 })
  create(@Body() input: CreateRegistrationOverrideDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.overrides.create(input, actor);
  }
  @Post(':id/decision') @HttpCode(204)
  @RequirePermission('registration.override.decide', { stepUpLevel: 2 })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideRegistrationOverrideDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.overrides.decide(id, input, actor); }
}

import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateRegistrationAddDropDto, DecideRegistrationAddDropDto } from './registration-add-drop.dto';
import { RegistrationAddDropService } from './registration-add-drop.service';

@ApiTags('registration')
@ApiBearerAuth()
@Controller({ path: 'registration/add-drop', version: '1' })
export class RegistrationAddDropController {
  constructor(private readonly addDrop: RegistrationAddDropService) {}

  @Post('requests')
  @RequirePermission('registration.add-drop.request')
  @ApiCreatedResponse({ description: 'An immutable registration add/drop request was created.' })
  create(@Body() input: CreateRegistrationAddDropDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.addDrop.create(input, actor);
  }

  @Post('requests/:id/decision')
  @HttpCode(204)
  @RequirePermission('registration.add-drop.decide', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The add/drop request was decided and approved changes applied.' })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() input: DecideRegistrationAddDropDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.addDrop.decide(id, input, actor);
  }
}

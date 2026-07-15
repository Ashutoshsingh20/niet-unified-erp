import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ActiveRegistrationWindowQueryDto, CreateRegistrationWindowDto,
  PublishRegistrationWindowDto } from './registration-windows.dto';
import { RegistrationWindowsService, type RegistrationWindowView } from './registration-windows.service';
@ApiTags('registration') @ApiBearerAuth()
@Controller({ path: 'registration/windows', version: '1' })
export class RegistrationWindowsController {
  constructor(private readonly windows: RegistrationWindowsService) {}
  @Post() @RequirePermission('registration.window.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A versioned registration window draft was created.' })
  create(@Body() input: CreateRegistrationWindowDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.windows.create(input, actor);
  }
  @Post(':id/publication') @RequirePermission('registration.window.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishRegistrationWindowDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.windows.publish(id, input, actor);
  }
  @Get('active') @RequirePermission('registration.window.read')
  active(@Query() input: ActiveRegistrationWindowQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ item: RegistrationWindowView | null }> {
    return this.windows.active(input.periodId, input.windowType, actor);
  }
}

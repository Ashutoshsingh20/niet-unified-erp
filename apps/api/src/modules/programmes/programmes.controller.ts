import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ActivateProgrammeEnrolmentDto, AssignProgrammeDto, CreateProgrammeVersionDto,
  PublishProgrammeVersionDto } from './programmes.dto';
import { ProgrammesService } from './programmes.service';
@ApiTags('programmes') @ApiBearerAuth() @Controller({ path: 'programmes', version: '1' })
export class ProgrammesController {
  constructor(private readonly programmes: ProgrammesService) {}
  @Post('versions') @RequirePermission('programme.version.create')
  create(@Body() input: CreateProgrammeVersionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> { return this.programmes.create(input, actor); }
  @Post('versions/:id/publication') @HttpCode(204)
  @RequirePermission('programme.version.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishProgrammeVersionDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.programmes.publish(id, input, actor); }
  @Post('enrolments') @RequirePermission('programme.enrolment.assign')
  assign(@Body() input: AssignProgrammeDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> { return this.programmes.assign(input, actor); }
  @Post('enrolments/:id/activation') @HttpCode(204)
  @RequirePermission('programme.enrolment.activate', { stepUpLevel: 2 })
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() input: ActivateProgrammeEnrolmentDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.programmes.activate(id, input, actor); }
}

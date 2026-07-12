import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ActivateStudentHoldDto, ProposeStudentHoldDto, ReleaseStudentHoldDto } from './holds.dto';
import { HoldsService } from './holds.service';
@ApiTags('student-holds') @ApiBearerAuth() @Controller({ path: 'student-holds', version: '1' })
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}
  @Post() @RequirePermission('student.hold.propose')
  propose(@Body() input: ProposeStudentHoldDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> { return this.holds.propose(input, actor); }
  @Post(':id/activation') @HttpCode(204) @RequirePermission('student.hold.activate', { stepUpLevel: 2 })
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() input: ActivateStudentHoldDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.holds.activate(id, input, actor); }
  @Post(':id/release') @HttpCode(204) @RequirePermission('student.hold.release', { stepUpLevel: 2 })
  release(@Param('id', ParseUUIDPipe) id: string, @Body() input: ReleaseStudentHoldDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.holds.release(id, input, actor); }
}

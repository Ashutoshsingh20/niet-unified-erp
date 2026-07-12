import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateTimetableMeetingDto, PublishTimetableMeetingDto } from './timetable.dto';
import { TimetableService } from './timetable.service';
@ApiTags('timetable') @ApiBearerAuth() @Controller({ path: 'timetable', version: '1' })
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}
  @Post('meetings') @RequirePermission('timetable.meeting.create')
  create(@Body() input: CreateTimetableMeetingDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> { return this.timetable.create(input, actor); }
  @Post('meetings/:id/publication') @HttpCode(204)
  @RequirePermission('timetable.meeting.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishTimetableMeetingDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.timetable.publish(id, input, actor); }
}

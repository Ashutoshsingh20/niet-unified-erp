import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ApproveAttendanceCorrectionDto, CreateTeachingSessionDto, FinalizeAttendanceDto,
  RecordAttendanceObservationDto, RequestAttendanceCorrectionDto,
  VersionedSessionCommandDto } from './attendance.dto';
import { AttendanceService } from './attendance.service';

@ApiTags('attendance')
@ApiBearerAuth()
@Controller({ path: 'attendance', version: '1' })
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('sessions')
  @RequirePermission('attendance.session.create')
  @ApiCreatedResponse({ description: 'A teaching session was planned.' })
  createSession(@Body() input: CreateTeachingSessionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.attendance.createSession(input, actor);
  }

  @Post('sessions/:id/open')
  @HttpCode(204)
  @RequirePermission('attendance.session.open')
  openSession(@Param('id', ParseUUIDPipe) id: string, @Body() input: VersionedSessionCommandDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.attendance.openSession(id, input, actor);
  }

  @Post('sessions/:id/observations')
  @RequirePermission('attendance.observation.record')
  record(@Param('id', ParseUUIDPipe) id: string, @Body() input: RecordAttendanceObservationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.attendance.recordObservation(id, input, actor);
  }

  @Post('sessions/:id/finalization')
  @HttpCode(204)
  @RequirePermission('attendance.session.finalize', { stepUpLevel: 2 })
  finalize(@Param('id', ParseUUIDPipe) id: string, @Body() input: FinalizeAttendanceDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.attendance.finalize(id, input, actor);
  }

  @Post('sessions/:id/correction-requests')
  @RequirePermission('attendance.correction.request')
  requestCorrection(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: RequestAttendanceCorrectionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.attendance.requestCorrection(id, input, actor);
  }

  @Post('correction-requests/:id/approval')
  @HttpCode(204)
  @RequirePermission('attendance.correction.approve', { stepUpLevel: 2 })
  approveCorrection(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: ApproveAttendanceCorrectionDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.attendance.approveCorrection(id, input, actor);
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateSeatMatrixDto, PublishSeatMatrixDto, ReserveSeatDto } from './seat-matrices.dto';
import { SeatMatricesService, type SeatAvailability } from './seat-matrices.service';
@ApiTags('admissions') @ApiBearerAuth() @Controller({ path: 'admissions/seat-matrices', version: '1' })
export class SeatMatricesController {
  constructor(private readonly seats: SeatMatricesService) {}
  @Post() @RequirePermission('admission.seat-matrix.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A versioned seat matrix draft was created.' })
  create(@Body() input: CreateSeatMatrixDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.seats.create(input, actor);
  }
  @Post(':id/publication') @RequirePermission('admission.seat-matrix.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishSeatMatrixDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.seats.publish(id, input, actor);
  }
  @Post(':id/reservations') @RequirePermission('admission.seat.reserve', { stepUpLevel: 2 })
  reserve(@Param('id', ParseUUIDPipe) id: string, @Body() input: ReserveSeatDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; slotNumber: number; replayed: boolean }> {
    return this.seats.reserve(id, input, actor);
  }
  @Get(':id/availability') @RequirePermission('admission.seat-availability.read')
  availability(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<{ items: SeatAvailability[] }> {
    return this.seats.availability(id, actor);
  }
}

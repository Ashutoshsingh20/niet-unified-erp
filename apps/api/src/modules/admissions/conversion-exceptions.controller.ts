import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ConversionExceptionsQueryDto, ResolveConversionExceptionDto,
  ScanConversionExceptionsDto } from './conversion-exceptions.dto';
import { ConversionExceptionsService, type ConversionExceptionView } from './conversion-exceptions.service';

@ApiTags('admissions') @ApiBearerAuth()
@Controller({ path: 'admissions/conversion-exceptions', version: '1' })
export class ConversionExceptionsController {
  constructor(private readonly exceptions: ConversionExceptionsService) {}
  @Post('scan') @RequirePermission('admission.conversion-exception.scan', { stepUpLevel: 2 })
  scan(@Body() input: ScanConversionExceptionsDto, @CurrentPrincipal() actor: Principal):
  Promise<{ scanned: number; discovered: number; open: number }> {
    return this.exceptions.scan(input, actor);
  }
  @Get() @RequirePermission('admission.conversion-exception.read')
  list(@Query() input: ConversionExceptionsQueryDto, @CurrentPrincipal() actor: Principal):
  Promise<{ items: ConversionExceptionView[]; nextCursor: string | null }> {
    return this.exceptions.list(input, actor);
  }
  @Post(':id/resolution')
  @RequirePermission('admission.conversion-exception.resolve', { stepUpLevel: 2 })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() input: ResolveConversionExceptionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ status: 'RESOLVED' | 'WAIVED'; replayed: boolean }> {
    return this.exceptions.resolve(id, input, actor);
  }
}

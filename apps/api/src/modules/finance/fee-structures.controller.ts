import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateFeeStructureDto, PublishFeeStructureDto, RaiseGovernedDemandDto } from './fee-structures.dto';
import { FeeStructuresService } from './fee-structures.service';

@ApiTags('finance') @ApiBearerAuth() @Controller({ path: 'finance/fee-structures', version: '1' })
export class FeeStructuresController {
  constructor(private readonly fees: FeeStructuresService) {}
  @Post() @RequirePermission('finance.fee-structure.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A versioned fee structure draft was created.' })
  create(@Body() input: CreateFeeStructureDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.fees.create(input, actor);
  }
  @Post(':id/publication') @RequirePermission('finance.fee-structure.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishFeeStructureDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.fees.publish(id, input, actor);
  }
  @Post(':id/demands') @RequirePermission('finance.governed-demand.raise', { stepUpLevel: 2 })
  raiseDemand(@Param('id', ParseUUIDPipe) id: string, @Body() input: RaiseGovernedDemandDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; amountMinor: string; replayed: boolean }> {
    return this.fees.raiseDemand(id, input, actor);
  }
}

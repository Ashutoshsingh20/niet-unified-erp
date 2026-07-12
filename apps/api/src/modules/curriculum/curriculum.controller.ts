import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateRegulationVersionDto, PublishRegulationVersionDto } from './curriculum.dto';
import { CurriculumService, type RegulationVersion } from './curriculum.service';

@ApiTags('curriculum')
@ApiBearerAuth()
@Controller({ path: 'curriculum/regulations', version: '1' })
export class CurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}

  @Post()
  @RequirePermission('curriculum.regulation.draft')
  @ApiCreatedResponse({ description: 'An unpublished regulation version was drafted.' })
  create(@Body() input: CreateRegulationVersionDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.curriculum.create(input, actor);
  }

  @Post(':id/publication')
  @HttpCode(204)
  @RequirePermission('curriculum.regulation.publish', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The approved regulation version was published.' })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishRegulationVersionDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.curriculum.publish(id, input, actor);
  }

  @Get(':id')
  @RequirePermission('curriculum.regulation.read')
  get(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<RegulationVersion> {
    return this.curriculum.get(id, actor);
  }
}

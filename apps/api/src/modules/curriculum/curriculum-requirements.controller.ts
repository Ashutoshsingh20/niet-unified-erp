import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateCourseCatalogueDto, CreateRequirementEvaluationDto, CreateRequirementSetDto,
  PublishCurriculumConfigurationDto } from './curriculum-requirements.dto';
import { CurriculumRequirementsService, type CourseCatalogue, type CurriculumRequirementSet,
  type RequirementEvaluation } from './curriculum-requirements.service';

@ApiTags('curriculum')
@ApiBearerAuth()
@Controller({ path: 'curriculum', version: '1' })
export class CurriculumRequirementsController {
  constructor(private readonly requirements: CurriculumRequirementsService) {}

  @Post('catalogues')
  @RequirePermission('curriculum.catalogue.draft')
  @ApiCreatedResponse({ description: 'A versioned course catalogue draft was created.' })
  createCatalogue(@Body() input: CreateCourseCatalogueDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.requirements.createCatalogue(input, actor);
  }

  @Post('catalogues/:id/publication')
  @HttpCode(204)
  @RequirePermission('curriculum.catalogue.publish', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The course catalogue was published by a separate checker.' })
  publishCatalogue(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: PublishCurriculumConfigurationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.requirements.publishCatalogue(id, input, actor);
  }

  @Get('catalogues/:id')
  @RequirePermission('curriculum.catalogue.read')
  getCatalogue(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<CourseCatalogue> {
    return this.requirements.getCatalogue(id, actor);
  }

  @Post('requirement-sets')
  @RequirePermission('curriculum.requirements.draft')
  @ApiCreatedResponse({ description: 'A versioned requirement-set draft was created.' })
  createRequirementSet(@Body() input: CreateRequirementSetDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.requirements.createRequirementSet(input, actor);
  }

  @Post('requirement-sets/:id/publication')
  @HttpCode(204)
  @RequirePermission('curriculum.requirements.publish', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The requirement set was published by a separate checker.' })
  publishRequirementSet(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: PublishCurriculumConfigurationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.requirements.publishRequirementSet(id, input, actor);
  }

  @Get('requirement-sets/:id')
  @RequirePermission('curriculum.requirements.read')
  getRequirementSet(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<CurriculumRequirementSet> {
    return this.requirements.getRequirementSet(id, actor);
  }

  @Post('requirement-evaluations')
  @RequirePermission('curriculum.requirements.evaluate')
  @ApiCreatedResponse({ description: 'An immutable explainable requirement evaluation was recorded.' })
  evaluate(@Body() input: CreateRequirementEvaluationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.requirements.evaluate(input, actor);
  }

  @Get('requirement-evaluations/:id')
  @RequirePermission('curriculum.requirements.read')
  getEvaluation(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<RequirementEvaluation> {
    return this.requirements.getEvaluation(id, actor);
  }
}

import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import {
  CreateWorkflowDefinitionDto,
  DecideWorkflowTaskDto,
  SubmitWorkflowRequestDto,
} from './workflow.dto';
import { WorkflowService } from './workflow.service';

@ApiTags('workflow')
@ApiBearerAuth()
@Controller({ path: 'workflows', version: '1' })
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post('definitions')
  @RequirePermission('platform.workflow.configure', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A draft workflow definition was created.' })
  createDefinition(
    @Body() input: CreateWorkflowDefinitionDto,
    @CurrentPrincipal() actor: Principal,
  ): Promise<{ id: string }> {
    return this.workflows.createDefinition(input, actor);
  }

  @Post('definitions/:id/publish')
  @HttpCode(204)
  @RequirePermission('platform.workflow.publish', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The workflow definition was published.' })
  publishDefinition(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal,
  ): Promise<void> {
    return this.workflows.publishDefinition(id, actor);
  }

  @Post('requests')
  @RequirePermission('platform.workflow.submit')
  @ApiCreatedResponse({ description: 'A workflow request and approval task were created.' })
  submit(
    @Body() input: SubmitWorkflowRequestDto,
    @CurrentPrincipal() actor: Principal,
  ): Promise<{ id: string; taskId: string }> {
    return this.workflows.submit(input, actor);
  }

  @Post('tasks/:id/decision')
  @HttpCode(204)
  @RequirePermission('platform.workflow.decide', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'The workflow task was decided.' })
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: DecideWorkflowTaskDto,
    @CurrentPrincipal() actor: Principal,
  ): Promise<void> {
    return this.workflows.decide(id, input, actor);
  }
}


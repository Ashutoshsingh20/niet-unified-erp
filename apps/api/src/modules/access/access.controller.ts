import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import {
  AssignRoleDto,
  CreateDelegationDto,
  CreateOrganizationUnitDto,
  CreateRoleDto,
  RevokeAssignmentDto,
  CreateAccessReviewDto,
  DecideAccessReviewItemDto,
} from './access.dto';
import { AccessService } from './access.service';

@ApiTags('access-governance')
@ApiBearerAuth()
@Controller({ path: 'access', version: '1' })
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Post('organization-units')
  @RequirePermission('platform.organization.manage', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'Organization unit created.' })
  createOrganizationUnit(@Body() input: CreateOrganizationUnitDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.access.createOrganizationUnit(input, actor);
  }

  @Post('roles')
  @RequirePermission('platform.access.configure', { stepUpLevel: 2 })
  createRole(@Body() input: CreateRoleDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.access.createRole(input, actor);
  }

  @Post('roles/:id/publish')
  @HttpCode(204)
  @RequirePermission('platform.access.configure', { stepUpLevel: 2 })
  @ApiNoContentResponse({ description: 'Role version published.' })
  publishRole(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.access.publishRole(id, actor);
  }

  @Post('assignments')
  @RequirePermission('platform.access.assign', { stepUpLevel: 2 })
  assignRole(@Body() input: AssignRoleDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.access.assignRole(input, actor);
  }

  @Post('assignments/:id/revoke')
  @HttpCode(204)
  @RequirePermission('platform.access.assign', { stepUpLevel: 2 })
  revokeAssignment(@Param('id', ParseUUIDPipe) id: string,
    @Body() input: RevokeAssignmentDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.access.revokeAssignment(id, input, actor);
  }

  @Post('delegations')
  @RequirePermission('platform.access.delegate', { stepUpLevel: 2 })
  createDelegation(@Body() input: CreateDelegationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.access.createDelegation(input, actor);
  }

  @Post('reviews')
  @RequirePermission('platform.access.review', { stepUpLevel: 2 })
  createAccessReview(@Body() input: CreateAccessReviewDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; itemCount: number }> {
    return this.access.createAccessReview(input, actor);
  }

  @Post('reviews/:reviewId/items/:itemId/decision')
  @HttpCode(204)
  @RequirePermission('platform.access.review', { stepUpLevel: 2 })
  decideAccessReviewItem(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() input: DecideAccessReviewItemDto,
    @CurrentPrincipal() actor: Principal,
  ): Promise<void> {
    return this.access.decideAccessReviewItem(reviewId, itemId, input, actor);
  }
}

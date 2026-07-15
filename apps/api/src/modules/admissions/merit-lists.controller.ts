import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateMeritListDto, PublishMeritListDto } from './merit-lists.dto';
import { MeritListsService, type MeritListView } from './merit-lists.service';

@ApiTags('admissions') @ApiBearerAuth() @Controller({ path: 'admissions/merit-lists', version: '1' })
export class MeritListsController {
  constructor(private readonly meritLists: MeritListsService) {}

  @Post() @RequirePermission('admission.merit-list.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A versioned merit list draft was created from supplied evidence.' })
  create(@Body() input: CreateMeritListDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.meritLists.create(input, actor);
  }

  @Post(':id/publication') @RequirePermission('admission.merit-list.publish', { stepUpLevel: 2 })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() input: PublishMeritListDto,
    @CurrentPrincipal() actor: Principal): Promise<{ replayed: boolean }> {
    return this.meritLists.publish(id, input, actor);
  }

  @Get(':id') @RequirePermission('admission.merit-list.read')
  get(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<MeritListView> {
    return this.meritLists.get(id, actor);
  }
}

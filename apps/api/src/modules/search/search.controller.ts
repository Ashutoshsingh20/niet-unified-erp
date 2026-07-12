import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { SearchQueryDto, UpsertSearchRecordDto } from './search.dto';
import { SearchService, type SearchResultItem } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermission('platform.search.use')
  query(@Query() input: SearchQueryDto,
    @CurrentPrincipal() actor: Principal): Promise<{ items: SearchResultItem[] }> {
    return this.search.query(input, actor);
  }

  @Post('records')
  @RequirePermission('platform.search.index')
  upsert(@Body() input: UpsertSearchRecordDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.search.upsert(input, actor);
  }
}


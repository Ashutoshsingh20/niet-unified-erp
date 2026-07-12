import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import {
  CreateNotificationDto,
  CreateNotificationTemplateDto,
  ListNotificationsQueryDto,
  UpdateNotificationPreferencesDto,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';
import type { NotificationListItem } from './notifications.types';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('templates')
  @RequirePermission('platform.notifications.configure', { stepUpLevel: 2 })
  createTemplate(@Body() input: CreateNotificationTemplateDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.notifications.createTemplate(input, actor);
  }

  @Post('templates/:id/publish')
  @HttpCode(204)
  @RequirePermission('platform.notifications.configure', { stepUpLevel: 2 })
  publishTemplate(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.notifications.publishTemplate(id, actor);
  }

  @Post()
  @RequirePermission('platform.notifications.send')
  create(@Body() input: CreateNotificationDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; pushEventId: string | null }> {
    return this.notifications.create(input, actor);
  }

  @Get()
  @RequirePermission('platform.notifications.read')
  list(@CurrentPrincipal() actor: Principal,
    @Query() query: ListNotificationsQueryDto): Promise<{ items: NotificationListItem[] }> {
    return this.notifications.list(actor, query);
  }

  @Post(':id/read')
  @HttpCode(204)
  @RequirePermission('platform.notifications.read')
  markRead(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.notifications.markRead(id, actor);
  }

  @Patch('preferences')
  @RequirePermission('platform.notifications.preferences')
  updatePreferences(@Body() input: UpdateNotificationPreferencesDto,
    @CurrentPrincipal() actor: Principal): Promise<{ version: number }> {
    return this.notifications.updatePreferences(input, actor);
  }

  @Get('preferences')
  @RequirePermission('platform.notifications.preferences')
  getPreferences(@CurrentPrincipal() actor: Principal): Promise<{
    externalPushEnabled: boolean; version: number;
  }> {
    return this.notifications.getPreferences(actor);
  }
}

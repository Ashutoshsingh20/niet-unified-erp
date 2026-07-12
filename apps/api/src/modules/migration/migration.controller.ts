import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { ApproveMigrationDto, CreateMigrationBatchDto, ReconcileMigrationDto,
  StageMigrationRowDto, VersionedMigrationCommandDto } from './migration.dto';
import { MigrationService } from './migration.service';
@ApiTags('migration') @ApiBearerAuth() @Controller({ path: 'migration', version: '1' })
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}
  @Post('batches') @RequirePermission('migration.student.create')
  create(@Body() input: CreateMigrationBatchDto, @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.migration.create(input, actor);
  }
  @Post('batches/:id/rows') @RequirePermission('migration.student.stage')
  stage(@Param('id', ParseUUIDPipe) id: string, @Body() input: StageMigrationRowDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> { return this.migration.stage(id, input, actor); }
  @Post('batches/:id/validation') @RequirePermission('migration.student.validate')
  validate(@Param('id', ParseUUIDPipe) id: string, @Body() input: VersionedMigrationCommandDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.migration.validate(id, input, actor); }
  @Post('batches/:id/reconciliation') @RequirePermission('migration.student.reconcile', { stepUpLevel: 2 })
  reconcile(@Param('id', ParseUUIDPipe) id: string, @Body() input: ReconcileMigrationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.migration.reconcile(id, input, actor); }
  @Post('batches/:id/approval') @RequirePermission('migration.student.approve', { stepUpLevel: 2 })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() input: ApproveMigrationDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.migration.approve(id, input, actor); }
  @Post('batches/:id/application') @RequirePermission('migration.student.apply', { stepUpLevel: 2 })
  apply(@Param('id', ParseUUIDPipe) id: string, @Body() input: VersionedMigrationCommandDto,
    @CurrentPrincipal() actor: Principal): Promise<void> { return this.migration.apply(id, input, actor); }
}

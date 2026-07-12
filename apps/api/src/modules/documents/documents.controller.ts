import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateDocumentTypeDto, InitiateDocumentUploadDto, RecordDocumentScanDto } from './documents.dto';
import { DocumentsService } from './documents.service';
import type { UploadGrant } from '../../platform/object-storage/object-storage.port';

@ApiTags('documents')
@ApiBearerAuth()
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('types')
  @RequirePermission('platform.documents.configure', { stepUpLevel: 2 })
  createType(@Body() input: CreateDocumentTypeDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string }> {
    return this.documents.createType(input, actor);
  }

  @Post('types/:id/publish')
  @HttpCode(204)
  @RequirePermission('platform.documents.configure', { stepUpLevel: 2 })
  publishType(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.documents.publishType(id, actor);
  }

  @Post('uploads')
  @RequirePermission('platform.documents.upload')
  @ApiCreatedResponse({ description: 'Quarantine upload grant created.' })
  initiateUpload(@Body() input: InitiateDocumentUploadDto,
    @CurrentPrincipal() actor: Principal): Promise<{ documentId: string; upload: UploadGrant }> {
    return this.documents.initiateUpload(input, actor);
  }

  @Post(':id/upload-completion')
  @HttpCode(204)
  @RequirePermission('platform.documents.upload')
  completeUpload(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.documents.completeUpload(id, actor);
  }

  @Post(':id/scan-result')
  @HttpCode(204)
  @RequirePermission('platform.documents.scan')
  recordScan(@Param('id', ParseUUIDPipe) id: string, @Body() input: RecordDocumentScanDto,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.documents.recordScan(id, input, actor);
  }

  @Post(':id/promotion')
  @HttpCode(204)
  @RequirePermission('platform.documents.scan')
  promote(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<void> {
    return this.documents.promote(id, actor);
  }

  @Post(':id/download')
  @RequirePermission('platform.documents.read')
  createDownload(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<{ url: string; expiresAt: string }> {
    return this.documents.createDownload(id, actor);
  }
}

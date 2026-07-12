import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'niet-unified-erp-api';
  readonly timestamp: string;
}

@ApiTags('platform')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'Process liveness probe' })
  @ApiOkResponse({ description: 'The API process is live.' })
  live(): HealthResponse {
    return {
      status: 'ok',
      service: 'niet-unified-erp-api',
      timestamp: new Date().toISOString(),
    };
  }
}


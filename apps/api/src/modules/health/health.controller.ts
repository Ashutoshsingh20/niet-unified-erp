import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../../platform/auth/public.decorator';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'niet-unified-erp-api';
  readonly timestamp: string;
}

@ApiTags('platform')
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

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

  @Get('ready')
  @ApiOperation({ summary: 'Transactional dependency readiness probe' })
  @ApiOkResponse({ description: 'The API can reach its authoritative database.' })
  async ready(): Promise<HealthResponse> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', service: 'niet-unified-erp-api', timestamp: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException('The authoritative database is unavailable');
    }
  }
}

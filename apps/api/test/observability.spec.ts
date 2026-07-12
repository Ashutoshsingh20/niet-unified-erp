import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HealthController } from '../src/modules/health/health.controller';
import { MetricsController } from '../src/platform/observability/metrics.controller';
import { MetricsService } from '../src/platform/observability/metrics.service';

describe('operational probes', () => {
  it('exports process and bounded-label HTTP metrics', async () => {
    const metrics = new MetricsService();
    metrics.requests.inc({ method: 'GET', route: '/api/v1/health/live', status_code: '200' });
    const output = await new MetricsController(metrics).render();
    expect(output).toContain('niet_erp_http_requests_total');
    expect(output).toContain('route="/api/v1/health/live"');
    expect(output).toContain('niet_erp_process_cpu_user_seconds_total');
  });

  it('reports readiness only when PostgreSQL responds', async () => {
    const available = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as unknown as DataSource;
    await expect(new HealthController(available).ready()).resolves.toMatchObject({ status: 'ok' });
    const unavailable = { query: jest.fn().mockRejectedValue(new Error('offline')) } as unknown as DataSource;
    await expect(new HealthController(unavailable).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

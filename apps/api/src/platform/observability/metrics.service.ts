import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'niet_erp_http_requests_total',
    help: 'Completed API requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'niet_erp_http_request_duration_seconds',
    help: 'API request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'niet_erp_' });
  }

}

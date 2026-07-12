import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();
    return next.handle().pipe(finalize(() => {
      const route = request.routeOptions?.url ?? 'unmatched';
      const labels = { method: request.method, route, status_code: String(reply.statusCode) };
      this.metrics.requests.inc(labels);
      this.metrics.duration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1e9);
    }));
  }
}

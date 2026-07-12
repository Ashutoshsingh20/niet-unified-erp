import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

@Public()
@Controller('internal')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

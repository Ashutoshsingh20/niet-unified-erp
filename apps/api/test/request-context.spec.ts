import { RequestContextService } from '../src/platform/request-context/request-context.service';

describe('RequestContextService', () => {
  it('isolates a correlation ID within the active asynchronous context', async () => {
    const service = new RequestContextService();
    expect(service.getCorrelationId()).toBeUndefined();

    await service.run({ correlationId: 'request-1' }, async () => {
      await Promise.resolve();
      expect(service.getCorrelationId()).toBe('request-1');
    });

    expect(service.getCorrelationId()).toBeUndefined();
  });
});


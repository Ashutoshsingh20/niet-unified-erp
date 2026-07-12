import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestContextService } from './request-context.service';

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestContextHook(context: RequestContextService) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const candidate = request.headers[CORRELATION_HEADER];
    const correlationId = typeof candidate === 'string' && SAFE_CORRELATION_ID.test(candidate)
      ? candidate
      : randomUUID();

    void reply.header(CORRELATION_HEADER, correlationId);
    context.run({ correlationId }, done);
  };
}

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Principal } from './auth.types';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new Error('Authenticated principal is unavailable');
    }
    return principal;
  },
);


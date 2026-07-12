import type { Principal } from './auth.types';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}


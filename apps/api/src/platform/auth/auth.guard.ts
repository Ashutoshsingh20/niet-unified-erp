import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AUTHORIZATION_REQUIREMENT } from './require-permission.decorator';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import { PolicyService } from './policy.service';
import { TokenVerifierService } from './token-verifier.service';
import type { AuthorizationRequirement } from './auth.types';
import { AccessGrantService } from './access-grant.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: TokenVerifierService,
    private readonly policy: PolicyService,
    private readonly accessGrants: AccessGrantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearerToken(request.headers.authorization);
    const identity = await this.tokenVerifier.verify(token);
    request.principal = await this.accessGrants.resolve(identity);

    const requirement = this.reflector.getAllAndOverride<AuthorizationRequirement>(
      AUTHORIZATION_REQUIREMENT,
      targets,
    );
    if (requirement === undefined) {
      throw new UnauthorizedException('Protected route has no authorization policy');
    }
    this.policy.assertAllowed(request.principal, requirement);
    return true;
  }
}

function extractBearerToken(header: string | undefined): string {
  if (header === undefined) {
    throw new UnauthorizedException('Bearer token is required');
  }
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (match?.[1] === undefined) {
    throw new UnauthorizedException('Authorization header must use Bearer authentication');
  }
  return match[1];
}

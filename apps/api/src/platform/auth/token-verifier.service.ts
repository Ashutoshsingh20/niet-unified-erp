import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Environment } from '../../config/environment';
import type { AuthenticatedIdentity } from './auth.types';

interface IdentityClaims extends JWTPayload {
  readonly acr?: string;
}

@Injectable()
export class TokenVerifierService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<Environment, true>) {
    this.issuer = config.get('OIDC_ISSUER', { infer: true });
    this.audience = config.get('OIDC_AUDIENCE', { infer: true });
    this.jwks = createRemoteJWKSet(new URL(config.get('OIDC_JWKS_URI', { infer: true })));
  }

  async verify(token: string): Promise<AuthenticatedIdentity> {
    try {
      const result = await jwtVerify<IdentityClaims>(token, this.jwks, {
        algorithms: ['RS256', 'PS256', 'ES256'],
        audience: this.audience,
        issuer: this.issuer,
      });
      if (result.payload.sub === undefined) {
        throw new UnauthorizedException('Token is missing a subject');
      }

      return {
        subjectId: result.payload.sub,
        ...(typeof result.payload.sid === 'string' ? { sessionId: result.payload.sid } : {}),
        assuranceLevel: parseAssuranceLevel(result.payload.acr),
      };
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Bearer token is invalid or expired');
    }
  }
}

function parseAssuranceLevel(acr: string | undefined): number {
  if (acr === undefined) return 0;
  const parsed = Number.parseInt(acr, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

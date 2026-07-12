import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { PolicyService } from './policy.service';
import { TokenVerifierService } from './token-verifier.service';
import { AccessGrantService } from './access-grant.service';

@Global()
@Module({
  providers: [
    TokenVerifierService,
    PolicyService,
    AccessGrantService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PolicyService],
})
export class AuthModule {}

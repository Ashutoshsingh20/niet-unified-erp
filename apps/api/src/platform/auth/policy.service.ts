import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthorizationRequirement, Principal } from './auth.types';

@Injectable()
export class PolicyService {
  assertAllowed(principal: Principal, requirement: AuthorizationRequirement): void {
    if (!principal.permissions.has(requirement.permission)) {
      throw new ForbiddenException('The requested action is not permitted');
    }
    if (
      requirement.stepUpLevel !== undefined
      && principal.assuranceLevel < requirement.stepUpLevel
    ) {
      throw new ForbiddenException('Step-up authentication is required');
    }
  }
}


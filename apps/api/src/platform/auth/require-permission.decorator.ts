import { SetMetadata } from '@nestjs/common';
import type { AuthorizationRequirement } from './auth.types';

export const AUTHORIZATION_REQUIREMENT = Symbol('authorizationRequirement');

export function RequirePermission(
  permission: string,
  options: { readonly stepUpLevel?: number } = {},
): ClassDecorator & MethodDecorator {
  const requirement: AuthorizationRequirement = {
    permission,
    ...(options.stepUpLevel === undefined ? {} : { stepUpLevel: options.stepUpLevel }),
  };
  return SetMetadata(AUTHORIZATION_REQUIREMENT, requirement);
}


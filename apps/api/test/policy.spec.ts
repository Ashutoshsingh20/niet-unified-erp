import { ForbiddenException } from '@nestjs/common';
import type { Principal } from '../src/platform/auth/auth.types';
import { PolicyService } from '../src/platform/auth/policy.service';

const principal = (permissions: readonly string[], assuranceLevel = 1): Principal => ({
  subjectId: 'subject-1',
  assuranceLevel,
  permissions: new Set(permissions),
  scopes: {},
});

describe('PolicyService', () => {
  const policy = new PolicyService();

  it('denies a missing permission', () => {
    expect(() => policy.assertAllowed(principal([]), { permission: 'workflow.read' }))
      .toThrow(ForbiddenException);
  });

  it('denies insufficient step-up assurance', () => {
    expect(() => policy.assertAllowed(principal(['result.approve']), {
      permission: 'result.approve',
      stepUpLevel: 2,
    })).toThrow('Step-up authentication is required');
  });

  it('allows an explicitly granted permission with sufficient assurance', () => {
    expect(() => policy.assertAllowed(principal(['result.approve'], 2), {
      permission: 'result.approve',
      stepUpLevel: 2,
    })).not.toThrow();
  });

  it('denies access outside the granted resource scope', () => {
    const scoped: Principal = {
      ...principal(['student.read']),
      scopes: { organization: ['unit-1'] },
    };
    expect(() => policy.assertScope(scoped, 'organization', 'unit-2'))
      .toThrow('outside the permitted scope');
  });

  it('allows institution-wide wildcard scope', () => {
    const scoped: Principal = {
      ...principal(['student.read']),
      scopes: { institution: ['*'] },
    };
    expect(() => policy.assertScope(scoped, 'organization', 'unit-2')).not.toThrow();
  });
});

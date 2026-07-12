import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedIdentity, Principal } from './auth.types';

interface EffectiveGrantRow {
  readonly permission: string;
  readonly scope_type: string;
  readonly scope_ids: readonly string[];
}

@Injectable()
export class AccessGrantService {
  constructor(private readonly dataSource: DataSource) {}

  async resolve(identity: AuthenticatedIdentity): Promise<Principal> {
    const rows = await this.dataSource.query<readonly EffectiveGrantRow[]>(
      `SELECT rp.permission, a.scope_type, array_agg(DISTINCT a.scope_id) AS scope_ids
       FROM access.subject_role_assignments a
       JOIN access.roles r ON r.id = a.role_id AND r.status = 'ACTIVE'
       JOIN access.role_permissions rp ON rp.role_id = r.id
       WHERE a.subject_id = $1
         AND a.revoked_at IS NULL
         AND a.effective_from <= clock_timestamp()
         AND (a.effective_until IS NULL OR a.effective_until > clock_timestamp())
       GROUP BY rp.permission, a.scope_type`,
      [identity.subjectId],
    );

    const permissions = new Set<string>();
    const scopes: Record<string, string[]> = {};
    for (const row of rows) {
      permissions.add(row.permission);
      const current = scopes[row.scope_type] ?? [];
      scopes[row.scope_type] = [...new Set([...current, ...row.scope_ids])];
    }

    return {
      subjectId: identity.subjectId,
      ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
      assuranceLevel: identity.assuranceLevel,
      permissions,
      scopes,
    };
  }
}

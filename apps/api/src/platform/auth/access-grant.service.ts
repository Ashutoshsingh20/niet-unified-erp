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
      `WITH RECURSIVE direct_grants AS (
         SELECT rp.permission, a.scope_type, a.scope_id
         FROM access.subject_role_assignments a
         JOIN access.roles r ON r.id = a.role_id AND r.status IN ('ACTIVE', 'RETIRED')
         JOIN access.role_permissions rp ON rp.role_id = r.id
         WHERE a.subject_id = $1
           AND a.revoked_at IS NULL
           AND a.effective_from <= clock_timestamp()
           AND (a.effective_until IS NULL OR a.effective_until > clock_timestamp())
       ), organization_tree(permission, unit_id) AS (
         SELECT g.permission, u.id
         FROM direct_grants g
         JOIN organization.units u ON g.scope_type = 'organization' AND u.id::text = g.scope_id
         WHERE u.status = 'ACTIVE'
         UNION ALL
         SELECT tree.permission, child.id
         FROM organization_tree tree
         JOIN organization.units child ON child.parent_id = tree.unit_id
         WHERE child.status = 'ACTIVE'
       ), effective_grants AS (
         SELECT permission, scope_type, scope_id
         FROM direct_grants WHERE scope_type <> 'organization'
         UNION
         SELECT permission, 'organization', unit_id::text FROM organization_tree
         UNION
         SELECT d.permission, d.scope_type, d.scope_id
         FROM access.delegations d
         JOIN access.subject_role_assignments source ON source.id = d.source_assignment_id
         JOIN access.roles source_role ON source_role.id = source.role_id
           AND source_role.status IN ('ACTIVE', 'RETIRED')
         JOIN access.role_permissions source_permission ON source_permission.role_id = source_role.id
           AND source_permission.permission = d.permission
         WHERE d.delegate_subject_id = $1 AND d.status = 'ACTIVE'
           AND d.effective_from <= clock_timestamp() AND d.effective_until > clock_timestamp()
           AND source.revoked_at IS NULL
           AND source.effective_from <= clock_timestamp()
           AND (source.effective_until IS NULL OR source.effective_until > clock_timestamp())
       )
       SELECT permission, scope_type, array_agg(DISTINCT scope_id) AS scope_ids
       FROM effective_grants
       GROUP BY permission, scope_type`,
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

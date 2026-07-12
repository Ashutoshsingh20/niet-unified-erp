import { Client } from '@opensearch-project/opensearch';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment';
import type { Principal } from '../auth/auth.types';

@Injectable()
export class OpenSearchQueryAdapter {
  private readonly client: Client;
  private readonly index: string;

  constructor(config: ConfigService<Environment, true>) {
    this.index = config.get('OPENSEARCH_INDEX', { infer: true });
    this.client = new Client({ node: config.get('OPENSEARCH_NODE', { infer: true }),
      auth: { username: config.get('OPENSEARCH_USERNAME', { infer: true }),
        password: config.get('OPENSEARCH_PASSWORD', { infer: true }) } });
  }

  async findCandidateIds(query: string, actor: Principal, limit: number): Promise<string[]> {
    if (actor.permissions.size === 0) return [];
    const global = (actor.scopes.institution ?? []).includes('*');
    const scopeFilters = global ? [] : Object.entries(actor.scopes).map(([scopeType, ids]) => ({
      bool: { filter: [
        { term: { scopeType } },
        ...(ids.includes('*') ? [] : [{ terms: { scopeId: ids } }]),
      ] },
    }));
    if (!global && scopeFilters.length === 0) return [];
    try {
      const response = await this.client.search({ index: this.index, size: limit,
        _source: false, body: { query: { bool: {
          must: [{ multi_match: { query, fields: ['title^3', 'summary'], type: 'best_fields' } }],
          filter: [
            { terms: { requiredPermission: [...actor.permissions] } },
            ...(!global ? [{ bool: { should: scopeFilters, minimum_should_match: 1 } }] : []),
          ],
        } } } });
      const hits = response.body.hits.hits as readonly { readonly _id?: string }[];
      return hits.flatMap((hit) => typeof hit._id === 'string' ? [hit._id] : []);
    } catch {
      throw new ServiceUnavailableException('Institutional search is temporarily unavailable');
    }
  }
}

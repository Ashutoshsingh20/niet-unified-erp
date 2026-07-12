import type { Client } from '@opensearch-project/opensearch';
import type { Pool, PoolClient } from 'pg';
import { calculateRetrySeconds, sanitizeOperationalError } from '../outbox/outbox-publisher.service';

interface SearchProjectionRecord {
  readonly id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly source_version: number;
  readonly indexed_version: number;
  readonly title: string;
  readonly summary: string;
  readonly required_permission: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly classification: string;
  readonly action_path: string;
  readonly index_attempts: number;
}

export class SearchProjectionService {
  private indexReady = false;

  constructor(
    private readonly pool: Pool,
    private readonly client: Client,
    private readonly index: string,
    private readonly maxAttempts: number,
  ) {}

  async processOne(): Promise<boolean> {
    const database = await this.pool.connect();
    try {
      await database.query('BEGIN');
      const result = await database.query<SearchProjectionRecord>(
        `SELECT id, source_type, source_id, source_version, indexed_version, title, summary,
                required_permission, scope_type, scope_id, classification, action_path, index_attempts
         FROM search.records
         WHERE projection_status = 'PENDING' AND failed_at IS NULL
           AND next_attempt_at <= clock_timestamp() AND indexed_version < source_version
         ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const record = result.rows[0];
      if (record === undefined) {
        await database.query('COMMIT');
        return false;
      }
      try {
        await this.ensureIndex();
        await this.client.index({ index: this.index, id: record.id, refresh: false,
          body: { sourceType: record.source_type, sourceId: record.source_id,
            sourceVersion: record.source_version, title: record.title, summary: record.summary,
            requiredPermission: record.required_permission, scopeType: record.scope_type,
            scopeId: record.scope_id, classification: record.classification,
            actionPath: record.action_path } });
        await database.query(
          `UPDATE search.records SET projection_status = 'INDEXED', indexed_version = source_version,
             indexed_at = clock_timestamp(), index_attempts = 0, last_error = NULL
           WHERE id = $1 AND source_version = $2`, [record.id, record.source_version]);
      } catch (error) {
        await this.recordFailure(database, record, error);
        this.indexReady = false;
      }
      await database.query('COMMIT');
      return true;
    } catch (error) {
      await database.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      database.release();
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexReady) return;
    const exists = await this.client.indices.exists({ index: this.index });
    if (!exists.body) {
      await this.client.indices.create({ index: this.index, body: { mappings: {
        dynamic: 'strict', properties: {
          sourceType: { type: 'keyword' }, sourceId: { type: 'keyword' },
          sourceVersion: { type: 'integer' }, title: { type: 'text' }, summary: { type: 'text' },
          requiredPermission: { type: 'keyword' }, scopeType: { type: 'keyword' },
          scopeId: { type: 'keyword' }, classification: { type: 'keyword' },
          actionPath: { type: 'keyword', index: false },
        },
      } } });
    }
    this.indexReady = true;
  }

  private async recordFailure(database: PoolClient, record: SearchProjectionRecord,
    error: unknown): Promise<void> {
    const attempt = record.index_attempts + 1;
    await database.query(
      `UPDATE search.records SET projection_status = CASE WHEN index_attempts + 1 >= $4
             THEN 'FAILED' ELSE 'PENDING' END,
         index_attempts = index_attempts + 1, last_error = $2,
         next_attempt_at = clock_timestamp() + make_interval(secs => $3),
         failed_at = CASE WHEN index_attempts + 1 >= $4 THEN clock_timestamp() ELSE NULL END
       WHERE id = $1`, [record.id, sanitizeOperationalError(error),
        calculateRetrySeconds(attempt), this.maxAttempts]);
  }
}

import { z } from 'zod';

const booleanSetting = z.enum(['true', 'false']).transform((value) => value === 'true');

const workerConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  AMQP_URL: z.string().url().optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
  OUTBOX_EXCHANGE: z.string().min(1).max(200).default('niet.erp.events'),
  OUTBOX_PUBLISHER_ENABLED: booleanSetting.default(true),
  WORKER_ID: z.string().min(1).max(200).default(`worker-${process.pid}`),
  SEARCH_PROJECTION_ENABLED: booleanSetting.default(false),
  OPENSEARCH_NODE: z.string().url().optional(),
  OPENSEARCH_USERNAME: z.string().min(1).optional(),
  OPENSEARCH_PASSWORD: z.string().min(16).optional(),
  OPENSEARCH_INDEX: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/).default('niet-erp-search-v1'),
  SEARCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
}).superRefine((value, context) => {
  if (!value.OUTBOX_PUBLISHER_ENABLED && !value.SEARCH_PROJECTION_ENABLED) {
    context.addIssue({ code: 'custom', message: 'At least one worker role must be enabled' });
  }
  if (value.OUTBOX_PUBLISHER_ENABLED && value.AMQP_URL === undefined) {
    context.addIssue({ code: 'custom', message: 'Outbox publisher requires AMQP_URL' });
  }
  if (value.SEARCH_PROJECTION_ENABLED
    && (value.OPENSEARCH_NODE === undefined || value.OPENSEARCH_USERNAME === undefined
      || value.OPENSEARCH_PASSWORD === undefined)) {
    context.addIssue({ code: 'custom', message: 'Search projection requires all OpenSearch credentials' });
  }
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function parseWorkerConfig(input: Record<string, unknown>): WorkerConfig {
  const result = workerConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid worker configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}

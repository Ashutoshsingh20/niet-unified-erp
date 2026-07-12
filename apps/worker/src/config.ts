import { z } from 'zod';

const workerConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  AMQP_URL: z.string().url(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
  OUTBOX_EXCHANGE: z.string().min(1).max(200).default('niet.erp.events'),
  WORKER_ID: z.string().min(1).max(200).default(`worker-${process.pid}`),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function parseWorkerConfig(input: Record<string, unknown>): WorkerConfig {
  const result = workerConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid worker configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}


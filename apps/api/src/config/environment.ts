import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  DATABASE_URL: z.string().url().default('postgresql://niet_erp:niet_erp_dev@127.0.0.1:5432/niet_erp'),
  OIDC_ISSUER: z.string().url().default('http://127.0.0.1:8080/realms/niet'),
  OIDC_AUDIENCE: z.string().min(1).default('niet-erp-api'),
  OIDC_JWKS_URI: z.string().url().default(
    'http://127.0.0.1:8080/realms/niet/protocol/openid-connect/certs',
  ),
  OBJECT_STORAGE_ENDPOINT: z.string().url(),
  OBJECT_STORAGE_REGION: z.string().min(1).default('us-east-1'),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(8),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(16),
  OBJECT_STORAGE_QUARANTINE_BUCKET: z.string().min(3).max(63),
  OBJECT_STORAGE_CLEAN_BUCKET: z.string().min(3).max(63),
  OPENSEARCH_NODE: z.string().url(),
  OPENSEARCH_USERNAME: z.string().min(1),
  OPENSEARCH_PASSWORD: z.string().min(16),
  OPENSEARCH_INDEX: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/).default('niet-erp-search-v1'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

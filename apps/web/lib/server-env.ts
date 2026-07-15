import 'server-only';
import { z } from 'zod';

const schema = z.object({
  NIET_API_BASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(16),
  OIDC_REDIRECT_URI: z.string().url(),
  OIDC_SELF_REGISTRATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  SESSION_ENCRYPTION_KEY: z.string().min(43),
});

export type WebConfig = z.infer<typeof schema>;

let cached: WebConfig | undefined;

export function getWebConfig(): WebConfig {
  if (cached !== undefined) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid web configuration: ${z.prettifyError(result.error)}`);
  cached = result.data;
  return cached;
}

export function isSelfRegistrationEnabled(): boolean {
  return process.env.OIDC_SELF_REGISTRATION_ENABLED === 'true';
}

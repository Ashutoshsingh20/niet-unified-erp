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
  ACADEMIC_POLICY_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_DECISION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ATTENDANCE_FINALIZATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ATTENDANCE_CORRECTION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_POSTING_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_REVERSAL_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_PROVIDER_POSTING_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_RECONCILIATION_APPROVAL_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_REFUND_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_FEE_STRUCTURE_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  FINANCE_GOVERNED_DEMAND_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  MIGRATION_APPLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_DECISION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_DOCUMENT_CHECKLIST_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_DOCUMENT_VERIFICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_DOCUMENT_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_OFFER_LIFECYCLE_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_CANCELLATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_FINANCE_ACCOUNT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_SEAT_MATRIX_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_SEAT_RESERVATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_SEAT_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_MERIT_LIST_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_MERIT_SEAT_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_CONVERSION_EXCEPTION_RESOLUTION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ADMISSION_CONVERSION_EXCEPTION_WAIVER_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  TIMETABLE_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  STUDENT_CONVERSION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  PROGRAMME_ENROLMENT_ACTIVATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  STUDENT_HOLD_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  WAITLIST_PROMOTION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_WITHDRAWAL_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_WINDOW_PUBLICATION_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_WINDOW_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  REGISTRATION_OVERRIDE_APPROVAL_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  WAITLIST_EXPIRY_ENFORCEMENT_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  STUDENT_WITHDRAWAL_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

import { spawn } from 'node:child_process';

const port = Number(process.env.CONTRACT_TEST_PORT ?? 3002);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
  env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    response = await fetch(`${baseUrl}/openapi-json`, { signal: AbortSignal.timeout(2_000) })
      .catch(() => undefined);
    if (response?.ok === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (response?.ok !== true) throw new Error(`OpenAPI endpoint did not start\n${logs.slice(-4000)}`);
  const contract = await response.json();
  if (!String(contract.openapi ?? '').startsWith('3.')) throw new Error('OpenAPI 3 contract is missing');
  const bearer = contract.components?.securitySchemes?.bearer;
  if (bearer?.type !== 'http' || bearer?.scheme !== 'bearer') {
    throw new Error('Bearer security scheme is missing from the contract');
  }
  const required = [
    '/api/v1/workflows/requests',
    '/api/v1/workflows/tasks/{id}/decision',
    '/api/v1/documents/uploads',
    '/api/v1/notifications',
    '/api/v1/search',
    '/api/v1/students/{id}',
    '/api/v1/curriculum/regulations/{id}/publication',
    '/api/v1/registration/requests/{id}/decision',
    '/api/v1/attendance/sessions/{id}/finalization',
    '/api/v1/attendance/correction-requests/{id}/approval',
    '/api/v1/finance/demands',
    '/api/v1/finance/postings/{id}/reversal',
    '/api/v1/finance/provider-events/payments',
    '/api/v1/finance/postings/{id}/receipt',
    '/api/v1/finance/reconciliations',
    '/api/v1/finance/reconciliations/{id}/approval',
    '/api/v1/finance/postings/{id}/refund-requests',
    '/api/v1/finance/refund-requests/{id}/decision',
    '/api/v1/migration/batches/{id}/reconciliation',
    '/api/v1/migration/batches/{id}/application',
    '/api/v1/admissions/applications/{id}/submission',
    '/api/v1/admissions/applications/{id}/decision',
    '/api/v1/admissions/applications/{id}/document-checklist',
    '/api/v1/admissions/document-checklists/{id}/publication',
    '/api/v1/admissions/document-checklist-items/{id}/attachments',
    '/api/v1/admissions/document-attachments/{id}/verification',
    '/api/v1/admissions/document-exceptions',
    '/api/v1/timetable/meetings/{id}/publication',
    '/api/v1/admissions/offers/{id}/acceptance',
    '/api/v1/admissions/offers/{id}/decline',
    '/api/v1/admissions/offers/{id}/withdrawal',
    '/api/v1/admissions/offers/{id}/expiration',
    '/api/v1/admissions/offer-exceptions',
    '/api/v1/admissions/offers/{id}/cancellation-requests',
    '/api/v1/admissions/cancellation-requests/{id}/assessment',
    '/api/v1/admissions/cancellation-exceptions',
    '/api/v1/admissions/offers/{id}/conversion',
    '/api/v1/student-core/me',
    '/api/v1/programmes/versions/{id}/publication',
    '/api/v1/programmes/enrolments/{id}/activation',
    '/api/v1/student-holds/{id}/activation',
    '/api/v1/student-holds/{id}/release',
    '/api/v1/registration/requests/{id}/waitlist-promotion',
    '/api/v1/registration/requests/{id}/withdrawal',
  ];
  for (const path of required) {
    if (contract.paths?.[path] === undefined) throw new Error(`Required contract path is missing: ${path}`);
  }
  const submit = contract.paths['/api/v1/workflows/requests']?.post;
  if (submit?.requestBody?.content?.['application/json']?.schema === undefined) {
    throw new Error('Workflow submission request schema is missing');
  }
  for (const path of required) {
    for (const operation of Object.values(contract.paths[path])) {
      if (!Array.isArray(operation.security)
        || !operation.security.some((item) => Object.hasOwn(item, 'bearer'))) {
        throw new Error(`Protected operation does not declare bearer security: ${path}`);
      }
    }
  }
  if (Object.keys(contract.paths).some((path) => path.startsWith('/api/workflows'))) {
    throw new Error('Unversioned workflow paths were published');
  }
  process.stdout.write('Versioned OpenAPI paths, request schemas, and bearer declarations verified\n');
} finally {
  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 5_000).unref();
  });
}

import { performance } from 'node:perf_hooks';

const target = process.env.LOAD_TEST_URL;
if (target === undefined) throw new Error('LOAD_TEST_URL is required');
const requests = Number(process.env.LOAD_TEST_REQUESTS ?? 500);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 25);
const maximumP95Ms = Number(process.env.LOAD_TEST_MAX_P95_MS ?? 500);
if (!Number.isInteger(requests) || requests < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('Load request and concurrency values must be positive integers');
}

const durations = [];
let failures = 0;
let next = 0;
async function worker() {
  for (;;) {
    const index = next;
    next += 1;
    if (index >= requests) return;
    const started = performance.now();
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
      if (response.status !== 200) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      durations.push(performance.now() - started);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
durations.sort((a, b) => a - b);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
const p95 = percentile(0.95);
if (failures > 0) throw new Error(`${failures} of ${requests} load requests failed`);
if (p95 === undefined || p95 > maximumP95Ms) {
  throw new Error(`p95 ${p95?.toFixed(1)}ms exceeded ${maximumP95Ms}ms`);
}
process.stdout.write(`Load baseline passed: ${requests} requests, concurrency ${concurrency}, p95 ${p95.toFixed(1)}ms\n`);

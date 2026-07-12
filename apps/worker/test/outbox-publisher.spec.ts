import { calculateRetrySeconds, sanitizeOperationalError } from '../src/outbox/outbox-publisher.service';

describe('calculateRetrySeconds', () => {
  it('uses bounded exponential retry', () => {
    expect(calculateRetrySeconds(1)).toBe(2);
    expect(calculateRetrySeconds(5)).toBe(32);
    expect(calculateRetrySeconds(20)).toBe(3600);
  });

  it('normalizes invalid low attempts', () => {
    expect(calculateRetrySeconds(0)).toBe(2);
  });
});

describe('sanitizeOperationalError', () => {
  it('redacts URI credentials and removes line breaks', () => {
    expect(sanitizeOperationalError(new Error('Failed amqp://user:secret@broker:5672\nretry')))
      .toBe('Failed amqp://[redacted]@broker:5672 retry');
  });
});

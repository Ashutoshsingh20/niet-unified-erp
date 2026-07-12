import { calculateRetrySeconds } from '../src/outbox/outbox-publisher.service';

describe('search projection retry policy', () => {
  it('uses the shared bounded retry schedule', () => {
    expect(calculateRetrySeconds(1)).toBe(2);
    expect(calculateRetrySeconds(12)).toBe(3600);
  });
});

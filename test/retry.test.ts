import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_SECONDS, retryWaitSeconds } from '../src/retry';

describe('retryWaitSeconds (#1936)', () => {
  it('never retries a quota_exceeded 429, whatever Retry-After says', () => {
    const body = { error: { type: 'quota_exceeded', message: 'Monthly API call limit of 100 reached.' } };
    expect(retryWaitSeconds({ status: 429, body, retryAfter: 1_700_000 }, 0)).toBeNull();
  });

  it('retries a rate-limit 429 after Retry-After', () => {
    const body = { error: { type: 'rate_limit_error', message: 'Too many signup attempts' } };
    expect(retryWaitSeconds({ status: 429, body, retryAfter: 2 }, 0)).toBe(2);
  });

  it('clamps a Retry-After above 60 seconds', () => {
    expect(retryWaitSeconds({ status: 429, body: {}, retryAfter: 1_700_000 }, 0)).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('backs off without a usable Retry-After', () => {
    expect(retryWaitSeconds({ status: 429, body: 'Too Many Requests' }, 0)).toBe(5);
    expect(retryWaitSeconds({ status: 429, body: null, retryAfter: Number.NaN }, 2)).toBe(20);
  });

  it('does not retry any other status', () => {
    expect(retryWaitSeconds({ status: 500, body: {} }, 0)).toBeNull();
  });
});

// When agent-init retries a 429 (#1936 §1, the rule every Chronary SDK follows):
// - a `quota_exceeded` 429 (a monthly plan limit) is never retried: asking
//   again cannot succeed until the limit resets or the plan changes;
// - a rate-limit 429 waits for `Retry-After`, never longer than 60 seconds.

export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Seconds to wait before retrying a 429, or null when it must not be retried.
 * Without a usable `Retry-After`, backs off 5s, 10s, 20s (capped at 60s).
 */
export function retryWaitSeconds(
  response: { status: number; body: unknown; retryAfter?: number },
  attempt: number,
): number | null {
  if (response.status !== 429) return null;
  const type = (response.body as { error?: { type?: unknown } } | null)?.error?.type;
  if (type === 'quota_exceeded') return null;
  const ra = response.retryAfter;
  const wait = ra !== undefined && Number.isFinite(ra) && ra >= 0 ? ra : Math.pow(2, attempt) * 5;
  return Math.min(wait, MAX_RETRY_AFTER_SECONDS);
}

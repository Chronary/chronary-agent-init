/**
 * The time zone for the smoke calendar. `TZ` is a POSIX variable and often
 * holds a value the API rejects (`:UTC` is the AWS Lambda default, `UTC0`,
 * `:/etc/localtime`, `CET-1CEST`): since the API validates calendar time
 * zones (#2512) that failed the bootstrap with a 400. Use `TZ` only when
 * `Intl` accepts it, then the runtime's resolved zone, then `UTC`.
 */
export function calendarTimeZone(tz: string | undefined, resolved?: string): string {
  for (const candidate of [tz, resolved ?? runtimeTimeZone()]) {
    if (candidate && isAcceptedTimeZone(candidate)) return candidate;
  }
  return 'UTC';
}

function runtimeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function isAcceptedTimeZone(tz: string): boolean {
  if (tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

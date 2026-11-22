import { describe, expect, it } from 'vitest';
import { calendarTimeZone } from '../src/timezone';

// #2512: the API rejects calendar time zones Intl does not accept, and POSIX
// TZ values are often such strings (`:UTC` is the AWS Lambda default).
describe('calendarTimeZone', () => {
  it('keeps a TZ the API accepts', () => {
    expect(calendarTimeZone('America/New_York', 'Europe/Berlin')).toBe('America/New_York');
    expect(calendarTimeZone('UTC', 'Europe/Berlin')).toBe('UTC');
  });

  it.each([':UTC', 'UTC0', ':/etc/localtime', 'CET-1CEST'])('ignores the POSIX TZ %s and uses the runtime zone', (tz) => {
    expect(calendarTimeZone(tz, 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('falls back to UTC when neither TZ nor the runtime zone is accepted', () => {
    expect(calendarTimeZone(':UTC', 'Not/AZone')).toBe('UTC');
    expect(calendarTimeZone(undefined, '')).toBe('UTC');
  });

  it('uses the runtime zone without TZ', () => {
    expect(calendarTimeZone(undefined, 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(typeof calendarTimeZone(undefined)).toBe('string');
  });
});

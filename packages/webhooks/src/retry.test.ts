import { describe, expect, it } from 'vitest';
import {
  DISABLE_AFTER_MS,
  RETRY_SCHEDULE_SEC,
  classifyStatus,
  isRetryableStatus,
  nextAttemptAt,
  parseRetryAfter,
  shouldDisableEndpoint,
} from './index.js';

const FROM = Date.UTC(2026, 0, 1);

describe('nextAttemptAt', () => {
  it('follows the Standard Webhooks schedule without jitter', () => {
    expect(RETRY_SCHEDULE_SEC.slice(0, 7)).toEqual([0, 5, 300, 1800, 7200, 18000, 36000]);
    expect(nextAttemptAt(0, FROM)?.getTime()).toBe(FROM);
    expect(nextAttemptAt(2, new Date(FROM))?.getTime()).toBe(FROM + 300_000);
  });

  it('returns null once the schedule is exhausted', () => {
    expect(nextAttemptAt(RETRY_SCHEDULE_SEC.length, FROM)).toBeNull();
  });

  it('applies bounded jitter', () => {
    expect(nextAttemptAt(2, FROM, { jitter: 0.1, random: () => 0 })?.getTime()).toBe(
      FROM + 270_000,
    );
    expect(
      nextAttemptAt(2, FROM, { jitter: 0.1, random: () => 0.999999 })?.getTime(),
    ).toBeLessThanOrEqual(FROM + 330_000);
  });

  it('honours a larger retry-after and a custom schedule', () => {
    expect(nextAttemptAt(1, FROM, { retryAfterSec: 60 })?.getTime()).toBe(FROM + 60_000);
    expect(nextAttemptAt(0, FROM, { schedule: [42] })?.getTime()).toBe(FROM + 42_000);
  });

  it('rejects negative or fractional attempts', () => {
    expect(() => nextAttemptAt(-1, FROM)).toThrow(RangeError);
    expect(() => nextAttemptAt(1.5, FROM)).toThrow(RangeError);
  });
});

describe('status handling', () => {
  it.each([
    [200, 'success'],
    [204, 'success'],
    [301, 'fail'],
    [400, 'fail'],
    [404, 'fail'],
    [408, 'retry'],
    [410, 'disable'],
    [429, 'retry'],
    [500, 'retry'],
    [502, 'retry'],
    [null, 'retry'],
  ] as const)('classifies %s as %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
    expect(isRetryableStatus(status)).toBe(expected === 'retry');
  });
});

describe('shouldDisableEndpoint', () => {
  it('disables only after 5 days of continuous failure', () => {
    expect(shouldDisableEndpoint(10, FROM, FROM + DISABLE_AFTER_MS - 1)).toBe(false);
    expect(shouldDisableEndpoint(10, new Date(FROM), new Date(FROM + DISABLE_AFTER_MS))).toBe(true);
    expect(shouldDisableEndpoint(0, FROM, FROM + DISABLE_AFTER_MS * 2)).toBe(false);
    expect(shouldDisableEndpoint(3, null, FROM)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(new Date(FROM + 30_000).toUTCString(), FROM)).toBe(30);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

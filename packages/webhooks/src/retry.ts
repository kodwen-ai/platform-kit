// Retry schedule and status handling per the Standard Webhooks spec
// ("Deliverability and reliability", "Delivery success and failure"):
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md

/** Delay before each attempt, in seconds, relative to the previous attempt (spec example schedule). */
export const RETRY_SCHEDULE_SEC: readonly number[] = Object.freeze([
  0, 5, 300, 1800, 7200, 18000, 36000, 50400, 72000, 86400,
]);

/** Endpoints failing continuously for this long are disabled (5 days). */
export const DISABLE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/** Options for `nextAttemptAt`. */
export interface NextAttemptOptions {
  /** Relative jitter, e.g. 0.1 = ±10 % of the delay. Default 0 (none). */
  jitter?: number;
  /** Server-provided `retry-after` in seconds; the later of the two wins. */
  retryAfterSec?: number;
  /** Random source in [0, 1); defaults to `Math.random`. */
  random?: () => number;
  /** Schedule override. */
  schedule?: readonly number[];
}

/** When to run attempt number `attempt` (0-based schedule index) after `from`; null = schedule exhausted, abandon. */
export function nextAttemptAt(
  attempt: number,
  from: Date | number,
  options: NextAttemptOptions = {},
): Date | null {
  const schedule = options.schedule ?? RETRY_SCHEDULE_SEC;
  if (!Number.isInteger(attempt) || attempt < 0)
    throw new RangeError('attempt must be a non-negative integer');
  const base = schedule[attempt];
  if (base === undefined) return null;
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0));
  const random = options.random ?? Math.random;
  const jittered = base * (1 + jitter * (2 * random() - 1));
  const delaySec = Math.max(jittered, options.retryAfterSec ?? 0, 0);
  return new Date(Number(from) + Math.round(delaySec * 1000));
}

/** How a delivery outcome should be handled. */
export type StatusClass = 'success' | 'disable' | 'retry' | 'fail';

/** Classify a response status; `null` means no response (timeout, network error) and is retried. */
export function classifyStatus(status: number | null): StatusClass {
  if (status === null || status === 0) return 'retry';
  if (status >= 200 && status <= 299) return 'success';
  if (status === 410) return 'disable';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

/** True when the outcome should be retried later (429, 408, 5xx, timeout/network error). */
export function isRetryableStatus(status: number | null): boolean {
  return classifyStatus(status) === 'retry';
}

/** True when the endpoint has failed continuously for at least 5 days. */
export function shouldDisableEndpoint(
  consecutiveFailures: number,
  firstFailureAt: Date | number | null,
  now: Date | number = Date.now(),
): boolean {
  if (consecutiveFailures <= 0 || firstFailureAt === null) return false;
  return Number(now) - Number(firstFailureAt) >= DISABLE_AFTER_MS;
}

/** Parse an HTTP `retry-after` header (seconds or HTTP-date) into seconds, or undefined. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date | number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Number(now)) / 1000));
}

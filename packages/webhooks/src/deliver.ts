// Minimal fetch-based Standard Webhooks sender. Spec recommends a 15-30 s timeout and
// treating redirects as failures: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
import { classifyStatus, parseRetryAfter } from './retry.js';
import type { WebhookEvent } from './schemas.js';
import { buildHeaders } from './signature.js';
import { validateWebhookUrl, type ValidateUrlOptions } from './ssrf.js';
import { VERSION } from './version.js';

/** User-Agent sent with every delivery. */
export const USER_AGENT = `codai-webhooks/${VERSION}`;

/** Input for `sendWebhook`. */
export interface SendWebhookInput {
  url: string;
  event: WebhookEvent;
  /** Active signing secrets; every one signs (rotation). */
  secrets: readonly string[];
  /** Fetch implementation; defaults to `globalThis.fetch`. Use one that re-checks resolved IPs. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Attempt timestamp; defaults to now. */
  now?: Date | number;
  /** URL policy; defaults to https-only, public targets only. */
  urlPolicy?: ValidateUrlOptions;
  /** Extra headers (cannot override the webhook-* / content-type headers). */
  headers?: Readonly<Record<string, string>>;
}

/** Outcome of one delivery attempt. */
export interface SendWebhookResult {
  /** HTTP status, or null when no response was received. */
  status: number | null;
  /** Elapsed milliseconds. */
  ms: number;
  ok: boolean;
  retryable: boolean;
  /** True when the receiver answered 410 Gone: disable the endpoint. */
  disable: boolean;
  /** Server `retry-after` in seconds, when present. */
  retryAfterSec?: number;
  error?: string;
}

function errorMessage(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `timeout after ${timeoutMs} ms`;
  return err instanceof Error ? err.message : String(err);
}

function failure(error: string, ms: number, retryable: boolean): SendWebhookResult {
  return { status: null, ms, ok: false, retryable, disable: false, error };
}

/** POST a signed JSON event to `url`; never throws, returns status/latency/retryability. */
export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const check = validateWebhookUrl(input.url, input.urlPolicy);
  if (!check.ok) return failure(`url rejected: ${check.reason}`, 0, false);
  const body = JSON.stringify(input.event);
  const timestamp = Math.floor(Number(input.now ?? Date.now()) / 1000);
  let signed: Awaited<ReturnType<typeof buildHeaders>>;
  try {
    signed = await buildHeaders({
      id: input.event.id,
      timestamp,
      payload: body,
      secrets: input.secrets,
    });
  } catch (err) {
    return failure(
      `signing failed: ${errorMessage(err, false, timeoutMs)}`,
      Date.now() - started,
      false,
    );
  }
  const doFetch = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await doFetch(check.url, {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        ...input.headers,
        ...signed,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
    });
    await response.body?.cancel().catch(() => undefined);
    const cls = classifyStatus(response.status);
    const retryAfterSec = parseRetryAfter(response.headers.get('retry-after'));
    return {
      status: response.status,
      ms: Date.now() - started,
      ok: cls === 'success',
      retryable: cls === 'retry',
      disable: cls === 'disable',
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
      ...(cls === 'success' ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (err) {
    return failure(errorMessage(err, timedOut, timeoutMs), Date.now() - started, true);
  } finally {
    clearTimeout(timer);
  }
}

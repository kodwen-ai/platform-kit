import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  USER_AGENT,
  VERSION,
  generateSecret,
  sendWebhook,
  verify,
  type WebhookEvent,
} from './index.js';

const event: WebhookEvent = {
  id: 'evt_1',
  type: 'user.created',
  created_at: '2026-10-19T07:00:00Z',
  data: { id: 1 },
};
const secret = generateSecret();

function fakeFetch(status: number, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(
    async () => new Response(status === 204 ? null : 'ok', { status, headers }),
  );
}

describe('sendWebhook', () => {
  it('posts a signed JSON body that the receiver can verify', async () => {
    const fetchMock = fakeFetch(200);
    const result = await sendWebhook({
      url: 'https://hooks.example.com/x',
      event,
      secrets: [secret],
      fetch: fetchMock,
    });
    expect(result).toMatchObject({ status: 200, ok: true, retryable: false, disable: false });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(init?.redirect).toBe('manual');
    const verified = await verify({ headers, payload: String(init?.body), secrets: [secret] });
    expect(verified).toEqual({ ok: true });
  });

  it('marks 5xx retryable with retry-after, 410 as disable, 400 as final failure', async () => {
    const r503 = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [secret],
      fetch: fakeFetch(503, { 'retry-after': '30' }),
    });
    expect(r503).toMatchObject({
      status: 503,
      ok: false,
      retryable: true,
      retryAfterSec: 30,
      error: 'HTTP 503',
    });
    const r410 = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [secret],
      fetch: fakeFetch(410),
    });
    expect(r410).toMatchObject({ ok: false, retryable: false, disable: true });
    const r400 = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [secret],
      fetch: fakeFetch(400),
    });
    expect(r400).toMatchObject({ ok: false, retryable: false, disable: false });
  });

  it('never throws on network errors and reports them as retryable', async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [secret],
      fetch: failing,
    });
    expect(result).toMatchObject({
      status: null,
      ok: false,
      retryable: true,
      error: 'fetch failed',
    });
  });

  it('aborts after timeoutMs', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const result = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [secret],
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ status: null, retryable: true, error: 'timeout after 20 ms' });
  });

  it('refuses SSRF targets and bad secrets without calling fetch', async () => {
    const fetchMock = fakeFetch(200);
    const ssrf = await sendWebhook({
      url: 'https://169.254.169.254/',
      event,
      secrets: [secret],
      fetch: fetchMock,
    });
    expect(ssrf).toMatchObject({
      ok: false,
      retryable: false,
      error: 'url rejected: private_address',
    });
    const badSecret = await sendWebhook({
      url: 'https://h.example.com',
      event,
      secrets: [],
      fetch: fetchMock,
    });
    expect(badSecret).toMatchObject({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});

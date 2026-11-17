import type { FetchLike } from '../types';

/** One recorded request. */
export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A scripted response: status + JSON (or raw text). */
export interface Scripted {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Test helper: a fake fetch answering from a FIFO script and recording every request. */
export function fakeFetch(script: Scripted[]): {
  fetch: FetchLike;
  calls: Recorded[];
  lines: () => string[];
} {
  const calls: Recorded[] = [];
  const queue = [...script];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    let body: unknown = init?.body;
    if (typeof body === 'string' && headers['content-type'] === 'application/json')
      body = JSON.parse(body);
    calls.push({ method: init?.method ?? 'GET', url, headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${init?.method} ${url}`);
    const text = next.text ?? (next.json === undefined ? '' : JSON.stringify(next.json));
    return new Response(text, { status: next.status ?? 200 });
  };
  return { fetch, calls, lines: () => calls.map((c) => `${c.method} ${c.url}`) };
}

/** Token stub. */
export const token = async (): Promise<string> => 'tok';

import { describe, expect, it, vi } from 'vitest';

import { HttpRequestError, MAX_JSON_BYTES, cancelBody, fetchJson, fetchText } from './http';

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return new Response(stream, { status: 200, headers });
}

describe('bounded HTTP JSON helper', () => {
  it('caps streamed bytes even when Content-Length is absent', async () => {
    const response = streamResponse([new Uint8Array(MAX_JSON_BYTES + 1)]);
    await expect(fetchJson(async () => response, 'https://api.example/data', {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('rejects a too-large Content-Length before consuming the body and cancels it', async () => {
    const cancel = vi.fn();
    const response = new Response('[]', { headers: { 'Content-Length': String(MAX_JSON_BYTES + 1) } });
    Object.defineProperty(response, 'body', { value: { cancel } });
    await expect(fetchJson(async () => response, 'https://api.example/data', {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'too-large' });
    expect(cancel).toHaveBeenCalled();
  });

  it('uses a full-operation deadline and aborts a slow stream', async () => {
    let signal!: AbortSignal;
    const cancel = vi.fn();
    const slow = new ReadableStream<Uint8Array>({ start() {}, cancel });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { signal = init!.signal!; return new Response(slow); });
    await expect(fetchJson(fetcher, 'https://api.example/data', {}, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it('treats a rejecting timeout cancellation as best effort', async () => {
    const slow = new ReadableStream<Uint8Array>({ start() {}, cancel: () => Promise.reject(new Error('cancel failed')) });
    await expect(fetchJson(async () => new Response(slow), 'https://api.example/data', {}, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it('cancels bodies explicitly', async () => {
    const cancel = vi.fn();
    await cancelBody({ body: { cancel } } as unknown as Response);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects manual redirects after exactly one initial request', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302 }));
    await expect(fetchJson(fetcher, 'https://api.example/data', { headers: { Authorization: 'secret' } }, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'redirect' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: 'manual' });
  });

  it('fetchText cancels a non-success body without reading it', async () => {
    const cancel = vi.fn();
    const rejected = new Response('', { status: 500 });
    Object.defineProperty(rejected, 'body', { value: { cancel } });
    await expect(fetchText(async () => rejected, 'https://api.example/data', {}, { timeoutMs: 100 })).resolves.toMatchObject({ response: { status: 500 }, text: undefined });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fetchText cancels a slow body when its deadline expires', async () => {
    const cancel = vi.fn();
    const slow = new ReadableStream<Uint8Array>({ start() {}, cancel });
    await expect(fetchText(async () => new Response(slow), 'https://api.example/data', {}, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(cancel).toHaveBeenCalled();
  });
});

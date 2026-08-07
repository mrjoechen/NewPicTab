import { describe, expect, it, vi } from 'vitest';

import type { JsonApiSourceConfig } from '../domain/types';
import { JsonApiSourceAdapter } from './jsonApi';
import { MAX_REMOTE_TEXT_LENGTH } from './text';

const source: JsonApiSourceConfig = {
  id: 'json-source', name: 'JSON', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1,
  endpoint: 'https://api.example.test/images?size=large', headers: { Authorization: 'Bearer very-secret-token', 'X-Client': 'PicTab' },
  authorizedImageOrigins: ['https://images.example.test/*'],
  arrayPath: 'data.items', fields: { imageUrl: 'image.url', stableId: 'id', title: 'title', author: 'artist.name', sourcePage: 'page', width: 'width', height: 'height' },
  startingPage: 2, pageParam: 'page'
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('JsonApiSourceAdapter', () => {
  it('validates HTTPS endpoints and never includes header values in validation errors', () => {
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [] } }));
    const result = adapter.validateConfig({ ...source, endpoint: 'https://user:password@api.example.test/images' });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(JSON.stringify(result)).not.toContain('very-secret-token');
    expect(adapter.validateConfig({ ...source, authorizedImageOrigins: ['http://images.example.test/*'] })).toMatchObject({ ok: false });
  });

  it('forwards static headers, preserves query parameters, and adds the configured page', async () => {
    const fetcher = vi.fn(async () => response({ data: { items: [{ id: 'a', image: { url: 'https://cdn.example/a.jpg' }, width: 100, height: 50 }] } }));
    const adapter = new JsonApiSourceAdapter(fetcher);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: true, images: [{ sourceId: source.id, dimensions: { width: 100, height: 50 } }] });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('size')).toBe('large');
    expect(new URL(url).searchParams.get('page')).toBe('2');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer very-secret-token');
  });

  it('returns every bounded test origin for authorization and lists up to five hundred images', async () => {
    const items = Array.from({ length: 502 }, (_, index) => ({ image: { url: `https://cdn.example/${index}.jpg` } }));
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items } }));
    const connection = await adapter.testConnection(source);
    expect(connection).toMatchObject({ ok: true, imageOrigins: ['https://cdn.example/*'], count: 500, preview: expect.any(Array) });
    expect(connection.ok && connection.preview).toHaveLength(6);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: expect.any(Array), warnings: [{ code: 'parse' }] });
    expect((await adapter.listImages(source)).images).toHaveLength(500);
  });

  it('maps optional metadata and deterministic IDs, and exposes attribution', async () => {
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [{ image: { url: 'https://cdn.example/a.jpg' }, title: 'Sunset', artist: { name: 'Ada' }, page: 'https://artist.example/a', width: 120, height: 80 }] } }));
    const result = await adapter.listImages(source);
    expect(result.images[0]).toMatchObject({ sourceId: source.id, description: 'Sunset', author: 'Ada', sourceUrl: 'https://artist.example/a', dimensions: { width: 120, height: 80 } });
    expect(result.ok && result.images[0].id).toMatch(/^img_[0-9a-f]{64}$/);
    if (!result.ok) throw new Error('expected mapped image');
    await expect(adapter.getAttribution(result.images[0])).resolves.toBe('Ada — https://artist.example/a');
  });

  it('bounds provider-controlled display metadata before returning it', async () => {
    const huge = 'x'.repeat(MAX_REMOTE_TEXT_LENGTH + 2_000);
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [{ image: { url: 'https://cdn.example/a.jpg' }, title: huge, artist: { name: huge } }] } }));
    const result = await adapter.listImages(source);
    expect(result.ok && result.images[0]?.description).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(result.ok && result.images[0]?.author).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(result.ok && result.images[0]?.attribution).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
  });

  it('uses opaque SHA-256 IDs and returns only origin-safe connection discovery', async () => {
    const signed = 'https://private-cdn.example/clients/acme/secret-album/photo.jpg?X-Amz-Signature=signed-secret';
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [{ id: 'customer-secret-id', image: { url: signed }, title: 'Safe title', page: 'https://private.example/return?token=secret' }] } }));

    const listed = await adapter.listImages(source);
    expect(listed.ok && listed.images[0]?.id).toMatch(/^img_[0-9a-f]{64}$/);
    expect(listed.ok && listed.images[0]?.id).not.toContain('customer-secret-id');
    expect(listed.ok && listed.images[0]?.id).not.toContain('secret-album');

    const tested = await adapter.testConnection(source);
    expect(tested).toMatchObject({ ok: true, count: 1, imageOrigins: ['https://private-cdn.example/*'], preview: [expect.objectContaining({ description: 'Safe title' })] });
    expect(tested).not.toHaveProperty('entries');
    expect(JSON.stringify(tested)).not.toContain('secret-album');
    expect(JSON.stringify(tested)).not.toContain('signed-secret');
    expect(JSON.stringify(tested)).not.toContain('private.example/return');
  });

  it('keeps generated IDs stable when an API response is reordered', async () => {
    const first = [{ image: { url: 'https://cdn.example/a.jpg' } }, { image: { url: 'https://cdn.example/b.jpg' } }];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { items: first } }))
      .mockResolvedValueOnce(response({ data: { items: [...first].reverse() } }));
    const adapter = new JsonApiSourceAdapter(fetcher);
    const before = await adapter.listImages(source);
    const after = await adapter.listImages(source);
    expect(Object.fromEntries(before.images.map((entry) => [entry.url, entry.id]))).toEqual(Object.fromEntries(after.images.map((entry) => [entry.url, entry.id])));
  });

  it('retains distinct URLs even when the provider stable ID collides', async () => {
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [
      { id: 'same', image: { url: 'https://cdn.example/a.jpg' } },
      { id: 'same', image: { url: 'https://cdn.example/b.jpg' } }
    ] } }));
    const result = await adapter.listImages(source);
    expect(result.ok && result.images).toHaveLength(2);
    expect(result.ok && new Set(result.images.map((entry) => entry.id)).size).toBe(2);
  });

  it('deduplicates an identical canonical URL even when provider IDs differ', async () => {
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [
      { id: 'one', image: { url: 'https://cdn.example/a.jpg' } },
      { id: 'two', image: { url: 'https://cdn.example/a.jpg' } }
    ] } }));
    const result = await adapter.listImages(source);
    expect(result.ok && result.images).toHaveLength(1);
    expect(result.ok && result.warnings).toEqual([expect.objectContaining({ itemIndex: 1 })]);
  });

  it.each([
    ['auth', 401], ['auth', 403], ['rate-limit', 429], ['http', 500]
  ] as const)('normalizes status %s without secret leakage', async (code, status) => {
    const adapter = new JsonApiSourceAdapter(async () => response({ error: 'Bearer very-secret-token' }, status));
    const result = await adapter.listImages(source);
    expect(result).toMatchObject({ images: [], error: { code } });
    expect(JSON.stringify(result)).not.toContain('very-secret-token');
  });

  it('parses an HTTP-date Retry-After value', async () => {
    const date = new Date(Date.now() + 5_000).toUTCString();
    const adapter = new JsonApiSourceAdapter(async () => new Response('', { status: 429, headers: { 'Retry-After': date } }));
    const result = await adapter.listImages(source);
    expect(result).toMatchObject({ ok: false, error: { code: 'rate-limit', retryAfterMs: expect.any(Number) } });
    if (!result.ok) expect(result.error.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes network, invalid JSON, non-array payloads, bad URLs, and invalid dimensions', async () => {
    const network = new JsonApiSourceAdapter(async () => { throw new Error('Bearer very-secret-token'); });
    await expect(network.listImages(source)).resolves.toMatchObject({ error: { code: 'network' } });
    const invalidJson = new JsonApiSourceAdapter(async () => new Response('{not-json', { status: 200 }));
    await expect(invalidJson.listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
    const nonArray = new JsonApiSourceAdapter(async () => response({ data: { items: {} } }));
    await expect(nonArray.listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
    const badItems = new JsonApiSourceAdapter(async () => response({ data: { items: [
      { image: { url: 'http://insecure.example/a.jpg' } },
      { image: { url: 'https://cdn.example/a.jpg' }, width: -1, height: 12 }
    ] } }));
    const badResult = await badItems.listImages(source);
    expect(badResult).toMatchObject({ images: [], error: { code: 'empty' } });
    expect(badResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'validation' })]));
    expect(badResult.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'imageUrl', reason: 'invalid-url', itemIndex: 0 }),
      expect.objectContaining({ field: 'width-height', reason: 'invalid-dimensions', itemIndex: 1 })
    ]));
  });

  it('labels a missing image URL and normalizes an aborted timeout as network', async () => {
    const missing = new JsonApiSourceAdapter(async () => response({ data: { items: [{}] } }));
    const missingResult = await missing.listImages(source);
    expect(missingResult.warnings).toEqual([expect.objectContaining({ field: 'imageUrl', reason: 'missing', itemIndex: 0 })]);
    await expect(missing.testConnection(source)).resolves.toMatchObject({ ok: false, warnings: [{ field: 'imageUrl', reason: 'missing' }] });
    const timeoutFetcher = vi.fn(() => new Promise<Response>(() => {}));
    const timeout = new JsonApiSourceAdapter(timeoutFetcher, { timeoutMs: 1 });
    const timeoutResult = await Promise.race([
      timeout.listImages(source),
      new Promise<'not-settled'>((resolve) => setTimeout(() => resolve('not-settled'), 50))
    ]);
    expect(timeoutResult).not.toBe('not-settled');
    expect(timeoutResult).toMatchObject({ images: [], error: { code: 'network' } });
  });

  it('does not follow redirects, cancels rejected HTTP bodies, and aborts on dispose', async () => {
    const cancel = vi.fn();
    const rejected = new Response('', { status: 500 });
    Object.defineProperty(rejected, 'body', { value: { cancel } });
    const fetcher = vi.fn(async () => rejected);
    const adapter = new JsonApiSourceAdapter(fetcher);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: false, images: [], error: { code: 'http' } });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: 'manual' });
    expect(cancel).toHaveBeenCalled();

    let signal!: AbortSignal;
    const pending = new JsonApiSourceAdapter((_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')));
    }));
    const loading = pending.listImages(source);
    pending.dispose();
    await expect(loading).resolves.toMatchObject({ ok: false, images: [], error: { code: 'network' } });
    expect(signal.aborted).toBe(true);
  });

  it('rejects an actual redirect without a second request carrying source headers', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302 }));
    const adapter = new JsonApiSourceAdapter(fetcher);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.example.test');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer very-secret-token');
  });

  it('omits javascript, data, and user-info source pages with typed warnings while retaining images', async () => {
    const adapter = new JsonApiSourceAdapter(async () => response({ data: { items: [
      { image: { url: 'https://cdn.example/a.jpg' }, page: 'javascript:alert(1)' },
      { image: { url: 'https://cdn.example/b.jpg' }, page: 'data:text/html,nope' },
      { image: { url: 'https://cdn.example/c.jpg' }, page: 'https://user:secret@artist.example/a' }
    ] } }));
    const result = await adapter.listImages(source);
    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'sourcePage', reason: 'invalid-url' })]));
    expect(result.ok && result.images).toHaveLength(3);
    expect(result.ok && result.images[0].sourceUrl).toBeUndefined();
  });
});

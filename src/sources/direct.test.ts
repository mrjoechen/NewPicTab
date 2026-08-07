import { describe, expect, it, vi } from 'vitest';

import type { DirectSourceConfig } from '../domain/types';
import { DirectSourceAdapter } from './direct';

const source: DirectSourceConfig = {
  id: 'direct-source', name: 'Direct', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1,
  entries: [
    { id: 'good', url: 'https://images.example/good.jpg', label: 'Good image' },
    { id: 'bad', url: 'https://images.example/bad.jpg' }
  ]
};

describe('DirectSourceAdapter', () => {
  it('maps a full 200-entry list without probing the network', async () => {
    const probe = vi.fn(async () => {});
    const adapter = new DirectSourceAdapter(probe);
    const entries = Array.from({ length: 200 }, (_, index) => ({ id: String(index), url: `https://images.example/${index}.jpg`, label: `Image ${index}` }));

    await expect(adapter.listImages({ ...source, entries })).resolves.toMatchObject({
      ok: true,
      images: expect.arrayContaining([{ id: '199', sourceId: source.id, url: 'https://images.example/199.jpg', description: 'Image 199' }])
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('validates only HTTPS direct URLs without user info', () => {
    const adapter = new DirectSourceAdapter(async () => {});
    expect(adapter.validateConfig(source)).toEqual({ ok: true });
    expect(adapter.validateConfig({ ...source, entries: [{ id: 'x', url: 'http://example.com/a' }] })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(adapter.validateConfig({ ...source, entries: [{ id: 'x', url: 'https://user:secret@example.com/a' }] })).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('keeps all metadata in lists while connection previews report unreachable URLs', async () => {
    const probe = vi.fn(async (url: string) => { if (url.includes('bad')) throw new Error('network internals'); });
    const adapter = new DirectSourceAdapter(probe);
    await expect(adapter.listImages(source)).resolves.toEqual({ ok: true, images: [
      { id: 'good', sourceId: source.id, url: source.entries[0].url, description: 'Good image' },
      { id: 'bad', sourceId: source.id, url: source.entries[1].url }
    ] });
    expect(probe).not.toHaveBeenCalled();
    const connection = await adapter.testConnection(source);
    expect(connection).toMatchObject({ ok: true, entries: [{ id: 'good' }], warnings: [{ code: 'network' }] });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('uses the production GET probe for every configured URL with an image Accept header', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    const adapter = new DirectSourceAdapter({ fetcher });
    const result = await adapter.testConnection({ ...source, entries: Array.from({ length: 7 }, (_, index) => ({ id: String(index), url: `https://images.example/${index}.jpg` })) });
    expect(result).toMatchObject({ ok: true, entries: expect.any(Array) });
    expect(result.ok && result.entries).toHaveLength(7);
    expect(fetcher).toHaveBeenCalledTimes(7);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: 'GET' });
    expect(new Headers(init.headers).get('Accept')).toBe('image/*');
  });

  it('normalizes a default-probe timeout without relying on an Image element', async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('private', 'AbortError')));
    }));
    const adapter = new DirectSourceAdapter({ fetcher, timeoutMs: 1 });
    await expect(adapter.testConnection({ ...source, entries: [source.entries[0]] })).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it('keeps a successful URL when a different URL reaches its own timeout', async () => {
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('slow')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))));
      return Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    });
    const adapter = new DirectSourceAdapter({ fetcher, timeoutMs: 1 });
    const result = await adapter.testConnection({ ...source, entries: [
      { id: 'slow', url: 'https://images.example/slow.jpg' },
      { id: 'fast', url: 'https://images.example/fast.jpg' }
    ] });
    expect(result).toMatchObject({ ok: true, entries: [{ id: 'fast' }], warnings: [{ code: 'network' }] });
  });

  it('rejects an empty direct source before probing', async () => {
    const probe = vi.fn(async () => {});
    const adapter = new DirectSourceAdapter(probe);
    const empty = { ...source, entries: [] };
    expect(adapter.validateConfig(empty)).toMatchObject({ ok: false, error: { code: 'validation' } });
    await expect(adapter.testConnection(empty)).resolves.toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects duplicate direct IDs and a source above the bounded entry cap', () => {
    const adapter = new DirectSourceAdapter(async () => {});
    expect(adapter.validateConfig({ ...source, entries: [source.entries[0], { ...source.entries[0] }] })).toMatchObject({ ok: false });
    expect(adapter.validateConfig({ ...source, entries: Array.from({ length: 201 }, (_, index) => ({ id: String(index), url: `https://images.example/${index}.jpg` })) })).toMatchObject({ ok: false });
  });

  it('does not publish a pending probe after disposal and uses manual redirects', async () => {
    let signal!: AbortSignal;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const adapter = new DirectSourceAdapter({ fetcher });
    const loading = adapter.testConnection({ ...source, entries: [source.entries[0]] });
    adapter.dispose();
    await expect(loading).resolves.toMatchObject({ ok: false, entries: [], error: { code: 'network' } });
    expect(signal.aborted).toBe(true);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('cancels a successful header-only probe body and preserves the first auth failure', async () => {
    const cancel = vi.fn();
    const image = new Response('', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    Object.defineProperty(image, 'body', { value: { cancel } });
    const adapter = new DirectSourceAdapter({ fetcher: vi.fn(async () => image) });
    await expect(adapter.testConnection({ ...source, entries: [source.entries[0]] })).resolves.toMatchObject({ ok: true });
    expect(cancel).toHaveBeenCalled();

    const auth = new DirectSourceAdapter({ fetcher: async () => new Response('', { status: 401, headers: { 'Content-Type': 'image/jpeg' } }) });
    await expect(auth.testConnection({ ...source, entries: [source.entries[0]] })).resolves.toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('aborts a pending source request when deleting that source', async () => {
    let signal!: AbortSignal;
    const adapter = new DirectSourceAdapter({ fetcher: (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')));
    }) });
    const loading = adapter.testConnection({ ...source, entries: [source.entries[0]] });
    await adapter.deleteSource(source.id);
    await expect(loading).resolves.toMatchObject({ ok: false, entries: [], error: { code: 'network' } });
    expect(signal.aborted).toBe(true);
  });

  it('bounds injected probes to six concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const probe = vi.fn(() => new Promise<void>((resolve) => {
      active += 1; peak = Math.max(peak, active);
      setTimeout(() => { active -= 1; resolve(); }, 1);
    }));
    const adapter = new DirectSourceAdapter(probe);
    const entries = Array.from({ length: 12 }, (_, index) => ({ id: String(index), url: `https://images.example/${index}.jpg` }));
    await expect(adapter.testConnection({ ...source, entries })).resolves.toMatchObject({ ok: true });
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('returns a typed empty error when every image probe fails', async () => {
    const adapter = new DirectSourceAdapter(async () => { throw new Error('private DNS diagnostics'); });
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: true, images: [{ id: 'good' }, { id: 'bad' }] });
    await expect(adapter.testConnection(source)).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it('has no remote side effect for deletion and disposal', async () => {
    const adapter = new DirectSourceAdapter(async () => {});
    await expect(adapter.testConnection(source)).resolves.toMatchObject({ ok: true, entries: expect.any(Array) });
    await expect(adapter.deleteSource(source.id)).resolves.toBeUndefined();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});

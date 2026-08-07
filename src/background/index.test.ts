import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, installRuntimeListener } from './index';
import type { ImageEntry, SourceAdapter } from '../sources/adapter';
import type { DirectSourceConfig, TmdbSourceConfig } from '../domain/types';
import { RemoteCache, type CacheBackend, type CacheMetadataRepository, type RemoteCacheMetadata } from '../storage/remoteCache';
import { JsonApiSourceAdapter } from '../sources/jsonApi';
import { WebDavSourceAdapter } from '../sources/webdav';
import { DirectSourceAdapter } from '../sources/direct';
import { MemoryCatalogRepository } from '../storage/catalogRepository';
import { RemoteCacheSession } from '../newtab/sourceClient';
import { MAX_REMOTE_TEXT_LENGTH } from '../sources/text';

const source: DirectSourceConfig = { id: 'remote', name: 'Remote', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };

class IntegrationCache implements CacheBackend {
  values = new Map<string, Response>();
  failPutCountdown = 0;
  failDeleteKey = '';
  async match(key: string) { return this.values.get(key)?.clone(); }
  async put(key: string, response: Response) { this.values.set(key, response.clone()); if (this.failPutCountdown > 0 && --this.failPutCountdown === 0) throw new Error('cache write'); }
  async delete(key: string) { if (key === this.failDeleteKey) throw new Error('cache delete'); return this.values.delete(key); }
  async keys() { return [...this.values.keys()]; }
}
class IntegrationMeta implements CacheMetadataRepository {
  values = new Map<string, RemoteCacheMetadata>();
  failPutCountdown = 0;
  throwBeforePut = false;
  async get(key: string) { return this.values.get(key); }
  async put(value: RemoteCacheMetadata) { if (this.throwBeforePut) throw new Error('metadata write before mutation'); this.values.set(value.cacheKey, structuredClone(value)); if (this.failPutCountdown > 0 && --this.failPutCountdown === 0) throw new Error('metadata write'); }
  async delete(key: string) { this.values.delete(key); }
  async list() { return [...this.values.values()]; }
}

function adapter(): SourceAdapter<DirectSourceConfig> & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = { test: vi.fn(async () => ({ ok: true } as const)), list: vi.fn(async () => ({ ok: true as const, images: [{ id: 'one', sourceId: source.id, url: source.entries[0].url }] })), refresh: vi.fn(async () => {}), remove: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  return { calls, validateConfig: () => ({ ok: true }), testConnection: calls.test, listImages: calls.list as never, refreshMetadata: calls.refresh, getAttribution: async () => undefined, deleteSource: calls.remove, dispose: calls.dispose };
}

describe('background dispatcher', () => {
  it('routes only strict weather messages and returns cloned normalized data', async () => {
    const weatherHandler = vi.fn(async () => ({ ok: true as const, cities: [{ id: 1, name: '上海', label: '上海，中国', latitude: 31.2, longitude: 121.4 }] }));
    const dispatch = createDispatcher({ weatherHandler, senderAllowed: () => true });
    await expect(dispatch({ weather: 'city-search', query: '上海', locale: 'zh-CN' })).resolves.toMatchObject({ ok: true, cities: [{ name: '上海' }] });
    expect(weatherHandler).toHaveBeenCalledWith({ weather: 'city-search', query: '上海', locale: 'zh-CN' });
    await expect(dispatch({ weather: 'current', location: 'X', latitude: Number.NaN, longitude: 0 })).resolves.toMatchObject({ code: 'validation' });
    await expect(dispatch({ weather: 'current', location: 'X', latitude: 0, longitude: 181 })).resolves.toMatchObject({ code: 'validation' });
    expect(weatherHandler).toHaveBeenCalledOnce();
  });
  it('routes test, list and refresh through one reused adapter', async () => {
    const made = vi.fn(adapter); const dispatch = createDispatcher({ factories: { direct: made } });
    await expect(dispatch({ source: 'test', config: source })).resolves.toMatchObject({ ok: true });
    await dispatch({ source: 'list', config: source }); await dispatch({ source: 'refresh', config: source });
    expect(made).toHaveBeenCalledTimes(1);
    expect(made.mock.results[0].value.calls.test).toHaveBeenCalledOnce();
    expect(made.mock.results[0].value.calls.list).toHaveBeenCalledOnce();
    expect(made.mock.results[0].value.calls.refresh).toHaveBeenCalledOnce();
  });

  it('bounds provider-controlled text in cached runtime descriptors', async () => {
    const item = adapter(); const huge = 'x'.repeat(MAX_REMOTE_TEXT_LENGTH + 2_000);
    item.calls.list.mockResolvedValue({ ok: true, images: [{ id: 'one', sourceId: source.id, url: source.entries[0]!.url, description: huge, author: huge, attribution: huge }] });
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher: vi.fn(async () => new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })), senderAllowed: () => true });

    const result = await dispatch({ source: 'list', config: source });

    expect(result).toMatchObject({ ok: true, images: [expect.objectContaining({ description: expect.any(String), author: expect.any(String), attribution: expect.any(String) })] });
    if (!('images' in result) || !result.ok) throw new Error('expected cached images');
    expect(result.images[0]?.description).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(result.images[0]?.author).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(result.images[0]?.attribution).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
  });

  it('re-sanitizes protected connection tests from a malicious injected adapter', async () => {
    const malicious = adapter();
    malicious.calls.test.mockResolvedValueOnce({
      ok: true,
      entries: [{ id: 'https://private.example/secret-path?sig=signed-secret', sourceId: 'json', url: 'https://private.example/secret-path?sig=signed-secret', attribution: 'https://return.example/secret' }],
      imageOrigins: ['http://insecure.example/*', 'https://user:password@private.example/*', 'https://safe.example/path/*', 'https://safe.example/*'],
      count: 1,
      preview: [{ id: 'raw-secret-id', sourceId: 'json', description: 'https://private.example/secret-path' }],
      directories: [
        { id: `dir_${'a'.repeat(64)}`, name: 'Safe child', relativeSegments: ['Safe child'] },
        { id: 'https://private.example/secret-path', name: 'Absolute', relativeSegments: ['Absolute'] },
        { id: `dir_${'b'.repeat(64)}`, name: 'Traversal', relativeSegments: ['..'] },
        { id: `dir_${'c'.repeat(64)}`, name: 'Nested', relativeSegments: ['one', 'two'] },
        { id: `dir_${'d'.repeat(64)}`, name: 'https://private.example', relativeSegments: ['Private'] },
        { id: `dir_${'e'.repeat(64)}`, name: '%2e%2e', relativeSegments: ['%2e%2e'] },
        { id: `dir_${'f'.repeat(64)}`, name: '%252e%252e%252fsecret', relativeSegments: ['%252e%252e%252fsecret'] },
        { id: `dir_${'9'.repeat(64)}`, name: 'Alpha', relativeSegments: ['Alpha'] },
        { id: `dir_${'8'.repeat(64)}`, name: 'Safe child', relativeSegments: ['Safe child'] }
      ],
      warnings: [{ code: 'parse', message: 'signed-secret /private/path' }]
    });
    const config = { id: 'json', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer header-secret' }, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const result = await createDispatcher({ factories: { 'json-api': () => malicious }, senderAllowed: () => true })({ source: 'test', config });

    expect(result).toMatchObject({ ok: true, protected: true, imageOrigins: ['https://safe.example/*'], count: 1, preview: [], directories: [
      { id: `dir_${'9'.repeat(64)}`, name: 'Alpha', relativeSegments: ['Alpha'] },
      { id: `dir_${'a'.repeat(64)}`, name: 'Safe child', relativeSegments: ['Safe child'] }
    ] });
    expect(result).not.toHaveProperty('entries');
    expect(JSON.stringify(result)).not.toMatch(/signed-secret|secret-path|header-secret|password|insecure\.example|\/private\/path/);
  });
  it('maps an invalid protected adapter error code containing secrets to unknown', async () => {
    const malicious = adapter();
    malicious.calls.test.mockResolvedValueOnce({ ok: false, error: { code: 'token-secret/private-path', message: 'signed-secret' }, warnings: [{ code: 'password-secret', message: 'private' }] });
    const config = { id: 'json-code', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const result = await createDispatcher({ factories: { 'json-api': () => malicious }, senderAllowed: () => true })({ source: 'test', config });
    expect(result).toMatchObject({ ok: false, protected: true, error: { code: 'unknown' } });
    expect(JSON.stringify(result)).not.toMatch(/token-secret|password-secret|private-path|signed-secret/);
  });

  it('best-effort deletes adapter, cache, and catalog even when catalog deletion fails', async () => {
    const item = adapter();
    const remoteCache = { deleteSource: vi.fn(async () => ({ ok: true, failedKeys: [] })) } as unknown as RemoteCache;
    const catalogRepository = { get: vi.fn(), put: vi.fn(), clear: vi.fn(), delete: vi.fn(async () => { throw new Error('catalog'); }) };
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, catalogRepository, senderAllowed: () => true });
    await dispatch({ source: 'test', config: source });
    await expect(dispatch({ source: 'delete', sourceId: source.id })).resolves.toMatchObject({ ok: false });
    expect(item.calls.remove).toHaveBeenCalledWith(source.id);
    expect(item.calls.dispose).toHaveBeenCalledOnce();
    expect(remoteCache.deleteSource).toHaveBeenCalledWith(source.id);
  });

  it('cleans catalog best-effort when remote cache is unavailable and reports partial failures', async () => {
    const catalogRepository = { get: vi.fn(), put: vi.fn(), delete: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const dispatch = createDispatcher({ remoteCache: undefined, catalogRepository, senderAllowed: () => true });
    await expect(dispatch({ source: 'clear-source-cache', sourceId: 'orphan' })).resolves.toMatchObject({ ok: false });
    expect(catalogRepository.delete).toHaveBeenCalledWith('orphan');
    await expect(dispatch({ source: 'clear-cache' })).resolves.toMatchObject({ ok: false });
    expect(catalogRepository.clear).toHaveBeenCalledOnce();

    const remoteCache = { clear: vi.fn(async () => ({ ok: true, failedKeys: [] })), deleteSource: vi.fn(async () => ({ ok: true, failedKeys: [] })) } as unknown as RemoteCache;
    const brokenCatalog = { ...catalogRepository, delete: vi.fn(async () => { throw new Error('catalog'); }), clear: vi.fn(async () => { throw new Error('catalog'); }) };
    const partial = createDispatcher({ remoteCache, catalogRepository: brokenCatalog, senderAllowed: () => true });
    await expect(partial({ source: 'clear-source-cache', sourceId: 'orphan' })).resolves.toMatchObject({ ok: false });
    expect(remoteCache.deleteSource).toHaveBeenCalledWith('orphan');
    await expect(partial({ source: 'clear-cache' })).resolves.toMatchObject({ ok: false });
    expect(remoteCache.clear).toHaveBeenCalledOnce();
  });

  it('clears every fresh-worker backend independently and disposes adapter state', async () => {
    const item = adapter();
    const remoteCache = { clear: vi.fn(async () => { throw new Error('private cache failure'); }) } as unknown as RemoteCache;
    const catalogRepository = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), clear: vi.fn(async () => undefined) };
    const weatherService = { searchCities: vi.fn(), current: vi.fn(), clearCache: vi.fn(async () => undefined) };
    const clearAuxiliaryData = vi.fn(async () => undefined);
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, catalogRepository, weatherService, clearAuxiliaryData, senderAllowed: () => true });
    await dispatch({ source: 'test', config: source });

    const result = await dispatch({ system: 'clear-all-data' });

    expect(result).toMatchObject({ ok: false, code: 'unknown', failures: ['remote image cache'] });
    expect(remoteCache.clear).toHaveBeenCalledOnce();
    expect(catalogRepository.clear).toHaveBeenCalledOnce();
    expect(weatherService.clearCache).toHaveBeenCalledOnce();
    expect(clearAuxiliaryData).toHaveBeenCalledOnce();
    expect(item.calls.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private cache failure');
  });

  it('returns dynamic TMDB genres only through the typed metadata request', async () => {
    const tmdb: TmdbSourceConfig = { id: 'tmdb', name: 'Movies', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'private', media: 'movie', feed: 'popular', discoverFilters: {} };
    const item = {
      ...adapter(),
      refreshMetadata: vi.fn(async () => undefined),
      getGenres: vi.fn(() => [{ id: 28, name: 'Action' }])
    };
    const dispatch = createDispatcher({ factories: { tmdb: () => item }, senderAllowed: () => true });

    await expect(dispatch({ source: 'tmdb-metadata', config: tmdb })).resolves.toEqual({ ok: true, genres: [{ id: 28, name: 'Action' }] });
    expect(item.refreshMetadata).toHaveBeenCalledWith(tmdb);
    expect(item.getGenres).toHaveBeenCalledWith(tmdb);
  });

  it('replaces a cached adapter when the source type changes and disposes on delete', async () => {
    const direct = vi.fn(adapter); const json = vi.fn(adapter); const dispatch = createDispatcher({ factories: { direct, 'json-api': json } });
    await dispatch({ source: 'test', config: source });
    await dispatch({ source: 'test', config: { ...source, type: 'json-api' } });
    expect(direct.mock.results[0].value.calls.dispose).toHaveBeenCalledOnce();
    await dispatch({ source: 'delete', sourceId: source.id });
    expect(json.mock.results[0].value.calls.remove).toHaveBeenCalledWith(source.id);
    expect(json.mock.results[0].value.calls.dispose).toHaveBeenCalledOnce();
  });

  it('rejects malformed, local, weather and foreign-sender messages without leaking secrets', async () => {
    const dispatch = createDispatcher({ senderAllowed: (sender) => sender.id === 'self' });
    await expect(dispatch({ source: 'wat' }, { id: 'self' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    await expect(dispatch({ source: 'test', config: { ...source, type: 'local' } }, { id: 'self' })).resolves.toMatchObject({ code: 'unsupported' });
    await expect(dispatch({ weather: 'current', city: 'Shanghai' }, { id: 'self' })).resolves.toMatchObject({ code: 'validation' });
    await expect(dispatch({ source: 'test', config: source }, { id: 'other' })).resolves.toMatchObject({ code: 'permission' });
    const broken = adapter(); broken.calls.test.mockRejectedValueOnce(new Error('Authorization: Bearer super-secret'));
    await expect(createDispatcher({ factories: { direct: () => broken } })({ source: 'test', config: source })).resolves.toMatchObject({ code: 'unknown', message: expect.not.stringContaining('super-secret') });
  });

  it('validates source envelope before adapter lookup and the callback listener returns true synchronously', async () => {
    const made = vi.fn(adapter); const dispatch = createDispatcher({ factories: { direct: made }, senderAllowed: () => true });
    await expect(dispatch({ source: 'test', config: { id: 'x', type: 'unknown' } } as never)).resolves.toMatchObject({ code: 'validation' });
    await expect(dispatch({ source: 'test', config: { type: 'direct' } } as never)).resolves.toMatchObject({ code: 'validation' });
    expect(made).not.toHaveBeenCalled();
    const add = vi.fn(); installRuntimeListener(dispatch, add);
    const listener = add.mock.calls[0][0]; const callback = vi.fn();
    expect(listener({ source: 'test', config: source }, { id: undefined }, callback)).toBe(true);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
  });

  it('installs the production runtime listener through the Chrome event object', () => {
    const dispatch = createDispatcher({ senderAllowed: () => true });
    const original = chrome.runtime.onMessage;
    let registered = false;
    const event = {
      addListener(this: unknown) {
        if (this !== event) throw new Error('addListener was called without its Chrome event receiver.');
        registered = true;
      },
      removeListener: vi.fn(),
      hasListeners: vi.fn()
    };
    Object.assign(chrome.runtime, { onMessage: event });
    try {
      expect(() => installRuntimeListener(dispatch)).not.toThrow();
      expect(registered).toBe(true);
    } finally {
      Object.assign(chrome.runtime, { onMessage: original });
    }
  });

  it('uses the runtime extension id as the default production sender policy', async () => {
    Object.defineProperty(chrome.runtime, 'id', { value: 'self', configurable: true });
    const dispatch = createDispatcher();
    await expect(dispatch({ source: 'test', config: source }, {})).resolves.toMatchObject({ code: 'permission' });
    await expect(dispatch({ source: 'test', config: source }, { id: 'other' })).resolves.toMatchObject({ code: 'permission' });
    Object.defineProperty(chrome.runtime, 'id', { value: undefined, configurable: true });
  });

  it('serializes same-source list and delete so an adapter cannot be revived after disposal', async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const item = adapter(); item.calls.list.mockImplementationOnce(async () => { await pending; return { ok: true, images: [{ id: 'one', sourceId: source.id, url: source.entries[0].url }] }; });
    const dispatch = createDispatcher({ factories: { direct: () => item }, senderAllowed: () => true }); await dispatch({ source: 'test', config: source });
    const listing = dispatch({ source: 'list', config: source }); const deletion = dispatch({ source: 'delete', sourceId: source.id }); release(); await listing; await deletion;
    expect(item.calls.remove).toHaveBeenCalledOnce(); expect(item.calls.dispose).toHaveBeenCalledOnce();
  });
  it('uses cached images while offline and fresh-worker delete always clears cache', async () => {
    const cached = [{ id: 'cached', sourceId: source.id, remoteCacheEntryId: 'cached' }] as const;
    const remoteCache = {
      listSource: vi.fn(async () => cached),
      get: vi.fn(async () => undefined),
      put: vi.fn(),
      deleteSource: vi.fn(async () => ({ ok: true, failedKeys: [] })),
      clear: vi.fn(async () => ({ ok: true, failedKeys: [] }))
    } as unknown as RemoteCache;
    const broken = adapter(); broken.calls.list.mockResolvedValueOnce({ ok: false, images: [], error: { code: 'network', message: 'offline' } });
    const dispatch = createDispatcher({ factories: { direct: () => broken }, remoteCache, senderAllowed: () => true });

    await expect(dispatch({ source: 'list', config: source })).resolves.toMatchObject({ ok: true, images: cached, warnings: [expect.objectContaining({ code: 'network' })] });
    const fresh = createDispatcher({ remoteCache, senderAllowed: () => true });
    await expect(fresh({ source: 'delete', sourceId: source.id })).resolves.toEqual({ ok: true });
    expect(remoteCache.deleteSource).toHaveBeenCalledWith(source.id);
  });

  it('caches only a small requested window while metadata count and later windows keep the 13th and last image reachable', async () => {
    const images = Array.from({ length: 2_000 }, (_, index) => ({ id: String(index), sourceId: 'dav', url: `https://dav.example/${index}.jpg` }));
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images });
    const put = vi.fn(async () => ({ cached: true }));
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put, deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    let active = 0; let maximum = 0;
    const imageFetcher = vi.fn(async (_url: string, init?: RequestInit) => { active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1; return new Response('image', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }); });
    const config = { id: 'dav', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/', username: 'alice', password: 'secret', includeSubdirectories: false };
    const dispatch = createDispatcher({ factories: { webdav: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });

    const first = await dispatch({ source: 'list', config });

    expect(imageFetcher).toHaveBeenCalledTimes(12);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(first).toMatchObject({ ok: true, totalCount: 2_000, offset: 0, consumedCount: 12, nextOffset: 12, hasMore: true, images: expect.not.arrayContaining([expect.objectContaining({ id: '12' })]) });
    await expect(dispatch({ source: 'list', config, offset: 12, limit: 12 })).resolves.toMatchObject({ ok: true, images: [expect.objectContaining({ id: '12' }), ...Array(11).fill(expect.anything())] });
    await expect(dispatch({ source: 'list', config, offset: 1_992, limit: 12 })).resolves.toMatchObject({ ok: true, hasMore: false, images: expect.arrayContaining([expect.objectContaining({ id: '1999' })]) });
    expect(imageFetcher).toHaveBeenCalledTimes(32);
    expect(item.calls.list).toHaveBeenCalledOnce();
    expect(new Headers(imageFetcher.mock.calls[0]?.[1]?.headers).get('Authorization')).toMatch(/^Basic /);
  });

  it('uses the real Direct adapter without probing 200 metadata entries before caching the first window', async () => {
    const config: DirectSourceConfig = {
      ...source,
      id: 'direct-200',
      entries: Array.from({ length: 200 }, (_, index) => ({ id: String(index), url: `https://images.example/${index}.jpg` }))
    };
    const imageFetcher = vi.fn(async () => new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const metadataProbe = vi.fn(async () => { throw new Error('list must not probe'); });
    const dispatch = createDispatcher({ factories: { direct: () => new DirectSourceAdapter({ fetcher: metadataProbe }) }, remoteCache, imageFetcher, senderAllowed: () => true });

    const result = await dispatch({ source: 'list', config });

    expect(result).toMatchObject({ ok: true, totalCount: 200, consumedCount: 12, nextOffset: 12, images: expect.any(Array) });
    expect(metadataProbe).not.toHaveBeenCalled();
    expect(imageFetcher).toHaveBeenCalledTimes(12);
  });

  it('does not expose an old cache namespace after same-ID Direct, WebDAV, or JSON configuration edits', async () => {
    const fingerprints: string[] = [];
    const remoteCache = {
      listSource: vi.fn(async (_sourceId: string, fingerprint?: string) => {
        fingerprints.push(fingerprint ?? '');
        return fingerprint === fingerprints[0] ? [{ id: 'old', sourceId: 'same', remoteCacheEntryId: 'old' }] : [];
      }),
      get: vi.fn(), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn()
    } as unknown as RemoteCache;
    const dispatch = createDispatcher({ factories: { direct: adapter, webdav: adapter, 'json-api': adapter }, remoteCache, senderAllowed: () => true });
    const directA = { ...source, id: 'same' }; const directB = { ...directA, entries: [{ id: 'one', url: 'https://new.example/image.jpg' }] };
    const davA = { id: 'same', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/old/', username: 'alice', password: 'old-password', includeSubdirectories: false };
    const davB = { ...davA, url: 'https://dav.example/new/', password: 'new-password' };
    const jsonA = { id: 'same', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer old-secret' }, authorizedImageOrigins: ['https://cdn.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const jsonB = { ...jsonA, headers: { Authorization: 'Bearer new-secret' } };

    for (const [before, after] of [[directA, directB], [davA, davB], [jsonA, jsonB]] as const) {
      fingerprints.length = 0;
      await expect(dispatch({ source: 'list', config: before, cacheOnly: true })).resolves.toMatchObject({ ok: true, images: [expect.objectContaining({ id: 'old' })] });
      const changed = await dispatch({ source: 'list', config: after, cacheOnly: true });
      expect(changed).toMatchObject({ ok: false, images: [] });
      expect(fingerprints[1]).not.toBe(fingerprints[0]);
      expect(fingerprints[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(changed)).not.toMatch(/old-password|new-password|old-secret|new-secret/);
    }
  });

  it('reuses an ordered persisted catalog after an MV3 worker restart without rescanning the adapter', async () => {
    const records = new Map<string, any>();
    const catalogRepository = {
      get: vi.fn(async (sourceId: string, fingerprint: string) => records.get(`${sourceId}:${fingerprint}`)),
      put: vi.fn(async (record: any) => { records.set(`${record.sourceId}:${record.fingerprint}`, structuredClone(record)); }),
      delete: vi.fn(async (sourceId: string, fingerprint?: string) => { for (const key of [...records.keys()]) if (key.startsWith(`${sourceId}:`) && (!fingerprint || key === `${sourceId}:${fingerprint}`)) records.delete(key); }),
      clear: vi.fn(async () => records.clear())
    };
    const images = Array.from({ length: 25 }, (_, index) => ({ id: `ordered-${index}`, sourceId: source.id, url: `https://images.example/${index}.jpg` })) as [ImageEntry, ...ImageEntry[]];
    const firstAdapter = adapter(); firstAdapter.calls.list.mockResolvedValueOnce({ ok: true, images });
    const cacheEntries = images.map((entry) => ({ id: entry.id, sourceId: entry.sourceId, remoteCacheEntryId: entry.id }));
    const remoteCache = { listSource: vi.fn(async () => cacheEntries), get: vi.fn(async () => new Response('cached')), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const first = createDispatcher({ factories: { direct: () => firstAdapter }, remoteCache, catalogRepository, senderAllowed: () => true });
    await expect(first({ source: 'list', config: source, offset: 0, limit: 12 })).resolves.toMatchObject({ ok: true, nextOffset: 12 });

    const restartedAdapter = adapter();
    const restarted = createDispatcher({ factories: { direct: () => restartedAdapter }, remoteCache, catalogRepository, senderAllowed: () => true });
    await expect(restarted({ source: 'list', config: source, offset: 12, limit: 12 })).resolves.toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ id: 'ordered-12' })]), nextOffset: 24, hasMore: true });
    expect(restartedAdapter.calls.list).not.toHaveBeenCalled();
    expect(records.size).toBe(1);
  });

  it('never persists a protected catalog containing query-bearing signed URLs and rescans after restart', async () => {
    const signedUrl = 'https://cdn.example/private/photo.jpg?X-Amz-Signature=credential-secret';
    const catalogRepository = { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(), clear: vi.fn() };
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => new Response('cached')), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const config = { id: 'signed-json', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: ['https://cdn.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const firstAdapter = adapter(); firstAdapter.calls.list.mockResolvedValueOnce({ ok: true, images: [{ id: 'img_' + 'a'.repeat(64), sourceId: config.id, url: signedUrl }] });
    const first = createDispatcher({ factories: { 'json-api': () => firstAdapter }, remoteCache, catalogRepository, senderAllowed: () => true });
    await first({ source: 'list', config });
    expect(catalogRepository.put).not.toHaveBeenCalled();

    const restartedAdapter = adapter(); restartedAdapter.calls.list.mockResolvedValueOnce({ ok: true, images: [{ id: 'img_' + 'a'.repeat(64), sourceId: config.id, url: signedUrl }] });
    const restarted = createDispatcher({ factories: { 'json-api': () => restartedAdapter }, remoteCache, catalogRepository, senderAllowed: () => true });
    await restarted({ source: 'list', config, offset: 0 });
    expect(restartedAdapter.calls.list).toHaveBeenCalledOnce();
    expect(JSON.stringify(catalogRepository.put.mock.calls)).not.toContain('credential-secret');
  });

  it('advances nextOffset by consumed metadata when some protected images fail to cache', async () => {
    const images = Array.from({ length: 15 }, (_, index) => ({ id: String(index), sourceId: 'dav', url: `https://dav.example/${index}.jpg` }));
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images });
    const remoteCache = {
      listSource: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      put: vi.fn(async (_sourceId: string, entryId: string) => ({ cached: entryId !== '4' && entryId !== '7' })),
      deleteSource: vi.fn(), clear: vi.fn()
    } as unknown as RemoteCache;
    const config = { id: 'dav', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/', username: 'alice', password: 'secret', includeSubdirectories: false };
    const dispatch = createDispatcher({ factories: { webdav: () => item }, remoteCache, imageFetcher: vi.fn(async () => new Response('image')), senderAllowed: () => true });

    const first = await dispatch({ source: 'list', config, offset: 0, limit: 12 });

    expect(first).toMatchObject({ ok: true, offset: 0, consumedCount: 12, nextOffset: 12, hasMore: true });
    expect(first).toHaveProperty('images.length', 10);
    await expect(dispatch({ source: 'list', config, offset: 12, limit: 12 })).resolves.toMatchObject({
      ok: true,
      images: [expect.objectContaining({ id: '12' }), expect.objectContaining({ id: '13' }), expect.objectContaining({ id: '14' })],
      consumedCount: 3,
      nextOffset: 15,
      hasMore: false
    });
  });

  it('refresh invalidates metadata while only an explicit force list bypasses image cache hits', async () => {
    const images = Array.from({ length: 12 }, (_, index) => ({ id: String(index), sourceId: source.id, url: `https://images.example/${index}.jpg` })) as [ImageEntry, ...ImageEntry[]];
    const item = adapter(); item.calls.list.mockResolvedValue({ ok: true, images });
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => new Response('cached')), put: vi.fn(async () => ({ cached: true })), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const imageFetcher = vi.fn(async () => new Response('fresh', { headers: { 'Content-Type': 'image/jpeg' } }));
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });

    await expect(dispatch({ source: 'list', config: source })).resolves.toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ remoteCacheEntryId: '0' })]) });
    await expect(dispatch({ source: 'refresh', config: source })).resolves.toEqual({ ok: true });
    await expect(dispatch({ source: 'list', config: source })).resolves.toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ remoteCacheEntryId: '0' })]) });
    expect(imageFetcher).not.toHaveBeenCalled();
    await expect(dispatch({ source: 'list', config: source, forceRefresh: true })).resolves.toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ remoteCacheEntryId: '0' })]) });

    expect(item.calls.refresh).toHaveBeenCalledOnce();
    expect(item.calls.list).toHaveBeenCalledTimes(2);
    expect(imageFetcher).toHaveBeenCalledTimes(12);
    expect(remoteCache.put).toHaveBeenCalledTimes(12);
  });

  it('protects the full batch during puts, then restores capacity and returns only readable descriptors', async () => {
    const images = Array.from({ length: 12 }, (_, index) => ({ id: String(index), sourceId: source.id, url: `https://images.example/${index}.jpg` })) as [ImageEntry, ...ImageEntry[]];
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images });
    const meta = new IntegrationMeta();
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta, maxBytes: 2 });
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher: vi.fn(async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } })), senderAllowed: () => true });

    const result = await dispatch({ source: 'list', config: source, protectedEntryIds: ['0', '1'] });

    expect(result).toMatchObject({ ok: true, images: [expect.objectContaining({ id: '0', remoteCacheEntryId: '0' }), expect.objectContaining({ id: '1', remoteCacheEntryId: '1' })] });
    expect((await meta.list()).reduce((sum, record) => sum + record.size, 0)).toBeLessThanOrEqual(2);
    if (!('images' in result) || !result.ok) throw new Error('expected cached images');
    for (const entry of result.images) {
      if (!('remoteCacheEntryId' in entry)) throw new Error('expected cache descriptor');
      await expect(remoteCache.get(entry.sourceId, entry.remoteCacheEntryId, entry.remoteCacheFingerprint)).resolves.toBeInstanceOf(Response);
    }
  });

  it('force refresh replaces bytes for the same ID and URL in the real cache', async () => {
    const item = adapter();
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    let version = 'v1';
    const imageFetcher = vi.fn(async () => new Response(version, { headers: { 'Content-Type': 'image/jpeg', 'X-Image-Version': version } }));
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });

    const first = await dispatch({ source: 'list', config: source });
    expect(first).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'one' })] });
    version = 'v2';
    await expect(dispatch({ source: 'refresh', config: source })).resolves.toEqual({ ok: true });
    const refreshed = await dispatch({ source: 'list', config: source, forceRefresh: true });
    expect(refreshed).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'one' })] });
    if (!('images' in refreshed) || !refreshed.ok || !('remoteCacheEntryId' in refreshed.images[0]!)) throw new Error('expected cache descriptor');
    expect((await remoteCache.get(source.id, refreshed.images[0].remoteCacheEntryId, refreshed.images[0].remoteCacheFingerprint))?.headers.get('X-Image-Version')).toBe('v2');
    expect(imageFetcher).toHaveBeenCalledTimes(2);
    await dispatch({ source: 'list', config: source });
    expect(imageFetcher).toHaveBeenCalledTimes(2);
  });

  it('allows an ordinary list between refresh and explicit force without causing a second forced download', async () => {
    const item = adapter();
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const fetchedUrls: string[] = [];
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher: vi.fn(async (url) => { fetchedUrls.push(url); return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }); }), senderAllowed: () => true });

    await dispatch({ source: 'list', config: source });
    fetchedUrls.length = 0;
    await dispatch({ source: 'refresh', config: source });
    await dispatch({ source: 'list', config: source });
    expect(fetchedUrls).toEqual([]);
    await dispatch({ source: 'list', config: source, forceRefresh: true });
    expect(fetchedUrls).toEqual([source.entries[0]!.url]);
    await dispatch({ source: 'list', config: source });
    expect(fetchedUrls).toEqual([source.entries[0]!.url]);
  });

  it('force refresh failure preserves and returns the old cached bytes', async () => {
    const item = adapter();
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const imageFetcher = vi.fn()
      .mockResolvedValueOnce(new Response('v1', { headers: { 'Content-Type': 'image/jpeg', 'X-Image-Version': 'v1' } }))
      .mockRejectedValueOnce(new Error('offline'));
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });

    const first = await dispatch({ source: 'list', config: source });
    await dispatch({ source: 'refresh', config: source });
    const refreshed = await dispatch({ source: 'list', config: source, forceRefresh: true });

    expect(refreshed).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'one' })], warnings: [expect.objectContaining({ code: 'network' })] });
    if (!('images' in first) || !first.ok || !('remoteCacheEntryId' in first.images[0]!)) throw new Error('expected cache descriptor');
    expect((await remoteCache.get(source.id, first.images[0].remoteCacheEntryId, first.images[0].remoteCacheFingerprint))?.headers.get('X-Image-Version')).toBe('v1');
    expect(imageFetcher).toHaveBeenCalledTimes(2);
    await expect(dispatch({ source: 'list', config: source })).resolves.toMatchObject({
      ok: true,
      images: [expect.objectContaining({ remoteCacheEntryId: 'one' })],
      warnings: [expect.objectContaining({ message: expect.stringContaining('Cached images are being used') })]
    });
    expect(imageFetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps v1 readable and marks stale when real same-key v2 cache, metadata, or eviction storage fails', async () => {
    for (const failure of ['cache', 'meta', 'eviction'] as const) {
      const item = adapter(); const cache = new IntegrationCache(); const meta = new IntegrationMeta();
      const remoteCache = new RemoteCache({ cache, meta, maxBytes: failure === 'eviction' ? 5 : 100 });
      if (failure === 'eviction') await remoteCache.put(source.id, 'victim', new Response(new Uint8Array(3), { headers: { 'Content-Type': 'image/jpeg' } }), 'direct', { id: 'victim', sourceId: source.id, url: 'https://images.example/victim.jpg' });
      let version = 'v1';
      const imageFetcher = vi.fn(async () => new Response(version === 'v1' ? new Uint8Array(2) : new Uint8Array(4), { headers: { 'Content-Type': 'image/jpeg', 'X-Image-Version': version } }));
      const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });
      const first = await dispatch({ source: 'list', config: source });
      if (!('images' in first) || !first.ok || !('remoteCacheEntryId' in first.images[0]!)) throw new Error('expected cache descriptor');
      version = 'v2';
      if (failure === 'cache') cache.failPutCountdown = 1;
      if (failure === 'meta') meta.failPutCountdown = 2;
      if (failure === 'eviction') cache.failDeleteKey = (await meta.list()).find((record) => record.entryId === 'victim')!.cacheKey;

      const refreshed = await dispatch({ source: 'list', config: source, forceRefresh: true });

      expect(refreshed, failure).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'one' })], warnings: [expect.objectContaining({ message: expect.stringContaining('Cached images are being used') })] });
      expect((await remoteCache.get(source.id, first.images[0].remoteCacheEntryId, first.images[0].remoteCacheFingerprint))?.headers.get('X-Image-Version'), failure).toBe('v1');
    }
  });

  it('removes both sides instead of exposing mixed state when metadata restoration fails', async () => {
    const item = adapter(); const cache = new IntegrationCache(); const meta = new IntegrationMeta();
    const remoteCache = new RemoteCache({ cache, meta });
    let version = 'v1';
    const imageFetcher = vi.fn(async () => new Response(version, { headers: { 'Content-Type': 'image/jpeg', 'X-Image-Version': version } }));
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });
    const first = await dispatch({ source: 'list', config: source });
    if (!('images' in first) || !first.ok || !('remoteCacheEntryId' in first.images[0]!)) throw new Error('expected cache descriptor');
    version = 'v2'; meta.throwBeforePut = true;

    const refreshed = await dispatch({ source: 'list', config: source, forceRefresh: true });

    expect(refreshed).toMatchObject({ ok: false, images: [], warnings: [expect.objectContaining({ code: 'network' })] });
    expect(JSON.stringify(refreshed)).not.toContain(source.entries[0]!.url);
    await expect(remoteCache.get(source.id, first.images[0].remoteCacheEntryId, first.images[0].remoteCacheFingerprint)).resolves.toBeUndefined();
  });

  it('adds a cached-stale warning as well as permission when forced original or final URLs are unauthorized', async () => {
    const config = { id: 'json-force-permission', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: ['https://cdn.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    for (const unauthorized of ['original', 'final'] as const) {
      const item = adapter();
      item.calls.list.mockResolvedValue({ ok: true, images: [{ id: 'same', sourceId: config.id, url: unauthorized === 'original' ? 'https://evil.example/new.jpg' : 'https://cdn.example/same.jpg' }] });
      const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
      await remoteCache.put(config.id, 'same', new Response('v1', { headers: { 'Content-Type': 'image/jpeg' } }), 'json-api', { id: 'same', sourceId: config.id, url: 'https://cdn.example/same.jpg' }, [], await (await import('../domain/sourceFingerprint')).sourceConfigFingerprint(config));
      const redirected = new Response('v2', { headers: { 'Content-Type': 'image/jpeg' } });
      if (unauthorized === 'final') Object.defineProperty(redirected, 'url', { value: 'https://evil.example/final.jpg' });
      const dispatch = createDispatcher({ factories: { 'json-api': () => item }, remoteCache, imageFetcher: vi.fn(async () => redirected), senderAllowed: () => true });

      const result = await dispatch({ source: 'list', config, forceRefresh: true });

      expect(result).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'same' })], warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'permission' }),
        expect.objectContaining({ message: expect.stringContaining('Cached images are being used') })
      ]) });
    }
  });

  it('honors explicit forceRefresh after a worker dispatcher restart', async () => {
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const catalogRepository = new MemoryCatalogRepository();
    let version = 'v1';
    const imageFetcher = vi.fn(async () => new Response(version, { headers: { 'Content-Type': 'image/jpeg', 'X-Image-Version': version } }));
    const first = createDispatcher({ factories: { direct: adapter }, remoteCache, catalogRepository, imageFetcher, senderAllowed: () => true });
    const initial = await first({ source: 'list', config: source });
    if (!('images' in initial) || !initial.ok || !('remoteCacheEntryId' in initial.images[0]!)) throw new Error('expected cache descriptor');
    version = 'v2';
    const restarted = createDispatcher({ factories: { direct: adapter }, remoteCache, catalogRepository, imageFetcher, senderAllowed: () => true });

    await expect(restarted({ source: 'list', config: source, forceRefresh: true })).resolves.toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'one' })] });

    expect(imageFetcher).toHaveBeenCalledTimes(2);
    expect((await remoteCache.get(source.id, initial.images[0].remoteCacheEntryId, initial.images[0].remoteCacheFingerprint))?.headers.get('X-Image-Version')).toBe('v2');
  });

  it('uses old TMDB cache bytes instead of a raw URL when forced fetching fails', async () => {
    const config: TmdbSourceConfig = { id: 'tmdb-force', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const item = adapter(); item.calls.list.mockResolvedValue({ ok: true, images: [{ id: 'backdrop', sourceId: config.id, url: 'https://image.tmdb.org/t/p/original/backdrop.jpg' }] });
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const imageFetcher = vi.fn().mockResolvedValueOnce(new Response('v1', { headers: { 'Content-Type': 'image/jpeg', 'X-Version': 'v1' } })).mockRejectedValueOnce(new Error('offline'));
    const dispatch = createDispatcher({ factories: { tmdb: () => item }, remoteCache, imageFetcher, senderAllowed: () => true });
    await dispatch({ source: 'list', config });

    const result = await dispatch({ source: 'list', config, forceRefresh: true });

    expect(result).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheEntryId: 'backdrop' })], warnings: [expect.objectContaining({ message: expect.stringContaining('Cached images are being used') })] });
    expect(JSON.stringify(result)).not.toContain('image.tmdb.org');
  });

  it('never forwards JSON endpoint secrets to image hosts and skips newly unapproved origins', async () => {
    const images = [
      { id: 'approved', sourceId: 'json', url: 'https://cdn.example/a.jpg' },
      { id: 'new-origin', sourceId: 'json', url: 'https://other.example/b.jpg' }
    ];
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images });
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put: vi.fn(async () => ({ cached: true })), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const imageFetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('image', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    const config = { id: 'json', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'private' }, authorizedImageOrigins: ['https://cdn.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const dispatch = createDispatcher({ factories: { 'json-api': () => item }, remoteCache, imageFetcher, senderAllowed: () => true });

    const result = await dispatch({ source: 'list', config });

    expect(imageFetcher).toHaveBeenCalledTimes(1);
    const headers = new Headers(imageFetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Accept')).toBe('image/*');
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Api-Key')).toBeNull();
    expect(result).toMatchObject({ ok: true, images: [expect.objectContaining({ id: 'approved' })], warnings: [expect.objectContaining({ code: 'permission' })] });
  });

  it('rejects an unauthorized protected final response URL and never follows WebDAV redirects with Basic auth', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
    const redirected = new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    Object.defineProperty(redirected, 'url', { value: 'https://evil.example/private/credential-secret.jpg?sig=signed-secret' });
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images: [{ id: 'img_' + 'a'.repeat(64), sourceId: 'dav-final', url: 'https://dav.example/photos/safe.jpg' }] });
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const imageFetcher = vi.fn(async (_url: string, _init?: RequestInit) => redirected);
    const config = { id: 'dav-final', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', username: 'alice', password: 'private-password', includeSubdirectories: false };
    const result = await createDispatcher({ factories: { webdav: () => item }, remoteCache, imageFetcher, senderAllowed: () => true })({ source: 'list', config });

    expect(result).toMatchObject({ ok: false, images: [], warnings: [expect.objectContaining({ code: 'permission' })] });
    expect(remoteCache.put).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    const init = imageFetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
    expect(JSON.stringify(result)).not.toMatch(/evil\.example|credential-secret|signed-secret|private-password/);
  });

  it('never returns raw remote URLs when CacheStorage is unavailable', async () => {
    const item = adapter();
    const dav = { id: 'dav', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/', username: 'a', password: 'b', includeSubdirectories: false };
    const json = { id: 'json', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: ['https://images.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const tmdb: TmdbSourceConfig = { id: 'tmdb', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const dispatch = createDispatcher({ factories: { direct: () => item, webdav: () => item, 'json-api': () => item, tmdb: () => item }, senderAllowed: () => true });
    item.calls.list.mockImplementation(async (config: { id: string }) => ({ ok: true, images: [{ id: 'one', sourceId: config.id, url: 'https://images.example/one.jpg' }] }));

    for (const config of [dav, json]) {
      const result = await dispatch({ source: 'list', config });
      expect(result).toMatchObject({ ok: false, images: [], error: { code: 'unknown' } });
      expect(JSON.stringify(result)).not.toContain('images.example/one.jpg');
    }
    for (const config of [source, tmdb]) {
      const result = await dispatch({ source: 'list', config });
      expect(result).toMatchObject({ ok: false, images: [] });
      expect(JSON.stringify(result)).not.toContain('https://images.example/one.jpg');
    }
  });

  it('deeply strips signed protected URLs and return links from test and cached runtime responses', async () => {
    const signedUrl = 'https://cdn.example/private/customer-acme/photo.jpg?X-Amz-Signature=signed-secret';
    const returnUrl = 'https://artist.example/customer-acme?token=return-secret';
    const config = { id: 'json-safe', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer api-secret' }, authorizedImageOrigins: ['https://cdn.example/*'], arrayPath: 'items', fields: { imageUrl: 'url', title: 'title', sourcePage: 'page' }, startingPage: 1 };
    const factory = () => new JsonApiSourceAdapter(async () => new Response(JSON.stringify({ items: [{ url: signedUrl, title: 'Safe title', page: returnUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => new Response('cached')), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const dispatch = createDispatcher({ factories: { 'json-api': factory }, remoteCache, senderAllowed: () => true });

    const tested = await dispatch({ source: 'test', config });
    const listed = await dispatch({ source: 'list', config });
    for (const result of [tested, listed]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('customer-acme');
      expect(serialized).not.toContain('signed-secret');
      expect(serialized).not.toContain('return-secret');
      expect(serialized).not.toContain('api-secret');
    }
  });

  it('materializes all four remote source types through real cache namespaces without leaking into DOM or logs', async () => {
    const remoteCache = new RemoteCache({ cache: new IntegrationCache(), meta: new IntegrationMeta() });
    const catalogRepository = new MemoryCatalogRepository();
    const imageFetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    const urls = { createObjectURL: vi.fn(() => `blob:opaque-${urls.createObjectURL.mock.calls.length}`), revokeObjectURL: vi.fn() };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined); const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const davXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/photos/customer-secret-filename.jpg</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontenttype>image/jpeg</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const generic = adapter(); generic.calls.list.mockImplementation(async (config: { id: string; type: string }) => ({ ok: true, images: [{ id: `entry-${config.type}`, sourceId: config.id, url: `https://images.example/${config.type}/credential-secret.jpg?sig=signed-secret` }] }));
    const configs = [
      { id: 'direct-real', name: 'Direct', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/direct/credential-secret.jpg?sig=signed-secret' }] },
      { id: 'dav-real', name: 'DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', username: 'private-user', password: 'private-password', includeSubdirectories: false },
      { id: 'json-real', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer api-secret' }, authorizedImageOrigins: ['https://images.example/*'], arrayPath: 'items', fields: { imageUrl: 'url', sourcePage: 'page' }, startingPage: 1 },
      { id: 'tmdb-real', name: 'TMDB', type: 'tmdb' as const, enabled: true, createdAt: 1, updatedAt: 1, token: 'tmdb-secret-token', media: 'movie' as const, feed: 'popular' as const, discoverFilters: {} }
    ];
    const dispatch = createDispatcher({
      factories: {
        direct: () => generic,
        webdav: () => new WebDavSourceAdapter(async () => new Response(davXml, { status: 207, headers: { 'Content-Type': 'application/xml' } })),
        'json-api': () => new JsonApiSourceAdapter(async () => new Response(JSON.stringify({ items: [{ url: 'https://images.example/json/private-path.jpg?sig=json-signed-secret', page: 'https://return.example/private' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        tmdb: () => generic
      }, remoteCache, catalogRepository, imageFetcher, senderAllowed: () => true
    });

    for (const config of configs) {
      const response = await dispatch({ source: 'list', config });
      expect(response).toMatchObject({ ok: true, images: [expect.objectContaining({ remoteCacheFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })] });
      if (!('images' in response) || !response.ok) throw new Error('expected cached descriptor');
      const session = new RemoteCacheSession(remoteCache, urls);
      const lease = await session.materialize(response.images);
      expect(lease.entries[0]).toMatchObject({ url: expect.stringMatching(/^blob:opaque-/) });
      const image = document.createElement('img'); image.src = 'url' in lease.entries[0]! && typeof lease.entries[0]!.url === 'string' ? lease.entries[0]!.url : ''; document.body.append(image);
      const exposed = `${JSON.stringify(response)} ${image.outerHTML}`;
      expect(exposed).not.toMatch(/private-password|private-user|api-secret|tmdb-secret-token|signed-secret|credential-secret|customer-secret-filename|private-path|return\.example/);
      lease.release(); image.remove();
    }
    expect([log, warn, error].flatMap((spy) => spy.mock.calls).join(' ')).not.toMatch(/secret|password|credential/i);
  });

  it('keeps permission warnings when an unauthorized refresh falls back to an older cached image', async () => {
    const item = adapter(); item.calls.list.mockResolvedValueOnce({ ok: true, images: [{ id: 'new', sourceId: 'json', url: 'https://new-origin.example/new.jpg' }] });
    const cached = [{ id: 'old', sourceId: 'json', remoteCacheEntryId: 'old' }] as const;
    const remoteCache = { listSource: vi.fn(async () => cached), get: vi.fn(async () => undefined), put: vi.fn(), deleteSource: vi.fn(), clear: vi.fn() } as unknown as RemoteCache;
    const config = { id: 'json', name: 'JSON', type: 'json-api' as const, enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: ['https://old-origin.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const dispatch = createDispatcher({ factories: { 'json-api': () => item }, remoteCache, senderAllowed: () => true });

    await expect(dispatch({ source: 'list', config })).resolves.toMatchObject({ ok: true, images: cached, warnings: [expect.objectContaining({ code: 'permission' })] });
  });

  it('returns typed failures when cache deletion or clearing fails', async () => {
    const remoteCache = { deleteSource: vi.fn(async () => ({ ok: false, failedKeys: ['x'] })), clear: vi.fn(async () => ({ ok: false, failedKeys: ['x'] })) } as unknown as RemoteCache;
    const dispatch = createDispatcher({ remoteCache, senderAllowed: () => true });
    await expect(dispatch({ source: 'delete', sourceId: source.id })).resolves.toMatchObject({ ok: false, code: 'unknown' });
    await expect(dispatch({ source: 'clear-cache' })).resolves.toMatchObject({ ok: false, code: 'unknown' });
  });
  it('serializes source cache clearing after an in-flight list so no completed clear is rewritten', async () => {
    let resolveImage!: (response: Response) => void;
    const fetched = new Promise<Response>((resolve) => { resolveImage = resolve; });
    const keys = new Set<string>();
    const item = adapter();
    const put = vi.fn(async (_sourceId: string, entryId: string) => { keys.add(entryId); return { cached: true }; }); const deleteSource = vi.fn(async () => { keys.clear(); return { ok: true, failedKeys: [] }; });
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put, deleteSource, clear: vi.fn() } as unknown as RemoteCache;
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher: vi.fn(() => fetched), senderAllowed: () => true });
    const listing = dispatch({ source: 'list', config: source }); const clearing = dispatch({ source: 'clear-source-cache', sourceId: source.id });
    resolveImage(new Response('image', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })); await listing; await clearing;
    expect(keys.size).toBe(0); expect(put.mock.invocationCallOrder[0]).toBeLessThan(deleteSource.mock.invocationCallOrder[0]!);
  });
  it('uses a global cache epoch so a list fetch that began before clear can never put afterward', async () => {
    let resolveImage!: (response: Response) => void;
    let markImageFetchStarted!: () => void;
    const fetched = new Promise<Response>((resolve) => { resolveImage = resolve; });
    const imageFetchStarted = new Promise<void>((resolve) => { markImageFetchStarted = resolve; });
    const item = adapter();
    const remoteCache = { listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put: vi.fn(async () => ({ cached: true })), deleteSource: vi.fn(), clear: vi.fn(async () => ({ ok: true, failedKeys: [] })) } as unknown as RemoteCache;
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, imageFetcher: vi.fn(() => { markImageFetchStarted(); return fetched; }), senderAllowed: () => true });
    const listing = dispatch({ source: 'list', config: source }); await imageFetchStarted;
    await expect(dispatch({ source: 'clear-cache' })).resolves.toEqual({ ok: true });
    resolveImage(new Response('image', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })); await listing;
    expect(remoteCache.put).not.toHaveBeenCalled();
  });
  it('does not repopulate memory or persisted catalog when clear wins a deferred adapter list', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    const item = adapter(); item.calls.list.mockImplementation(async () => { entered(); await gate; return { ok: true, images: [{ id: 'late', sourceId: source.id, url: 'https://images.example/late.jpg' }] }; });
    const remoteCache = { clear: vi.fn(async () => ({ ok: true, failedKeys: [] })), listSource: vi.fn(async () => []), get: vi.fn(async () => undefined), put: vi.fn(async () => ({ cached: true })), deleteSource: vi.fn() } as unknown as RemoteCache;
    const catalogRepository = { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(), clear: vi.fn(async () => undefined) };
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, catalogRepository, imageFetcher: vi.fn(async () => new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })), senderAllowed: () => true });
    const pending = dispatch({ source: 'list', config: source }); await started;
    await dispatch({ source: 'clear-cache' }); release(); await pending;
    expect(catalogRepository.put).not.toHaveBeenCalled();
    await dispatch({ source: 'list', config: source });
    expect(item.calls.list).toHaveBeenCalledTimes(2);
  });

  it('discards a deferred catalog read when clear wins and cacheOnly cannot refill memory', async () => {
    let resolveCatalog!: (value: any) => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const oldRecord = { sourceId: source.id, sourceType: 'direct', fingerprint: await (await import('../domain/sourceFingerprint')).sourceConfigFingerprint(source), images: [{ id: 'old', sourceId: source.id, url: 'https://images.example/old.jpg' }], totalCount: 1, fetchedAt: 1 };
    const catalogRepository = { get: vi.fn(() => { entered(); return new Promise<any>((resolve) => { resolveCatalog = resolve; }); }), put: vi.fn(), delete: vi.fn(), clear: vi.fn(async () => undefined) };
    const remoteCache = { clear: vi.fn(async () => ({ ok: true, failedKeys: [] })), listSource: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), deleteSource: vi.fn() } as unknown as RemoteCache;
    const item = adapter();
    const dispatch = createDispatcher({ factories: { direct: () => item }, remoteCache, catalogRepository, senderAllowed: () => true });
    const pending = dispatch({ source: 'list', config: source, cacheOnly: true }); await started;
    await dispatch({ source: 'clear-cache' }); resolveCatalog(oldRecord);
    await expect(pending).resolves.toMatchObject({ ok: false, images: [] });
    catalogRepository.get.mockResolvedValueOnce(undefined);
    await dispatch({ source: 'list', config: source });
    expect(item.calls.list).toHaveBeenCalledOnce();
  });
  it('disposes invalid temporary adapters without caching unbounded invalid source IDs', async () => {
    const dispose = vi.fn(async () => {}); const factory = vi.fn(() => ({ ...adapter(), validateConfig: () => ({ ok: false as const, error: { code: 'validation' as const, message: 'bad' } }), dispose })); const dispatch = createDispatcher({ factories: { direct: factory }, senderAllowed: () => true });
    await Promise.all(Array.from({ length: 20 }, (_, index) => dispatch({ source: 'test', config: { id: `invalid-${index}`, type: 'direct' } } as never)));
    expect(factory).toHaveBeenCalledTimes(20); expect(dispose).toHaveBeenCalledTimes(20);
  });
  it('serializes deferred type replacement with delete so the replacement cannot survive deletion', async () => {
    let release!: () => void; let entered!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    const old = adapter(); old.calls.dispose.mockImplementationOnce(async () => { entered(); await wait; }); const replacement = adapter(); const dispatch = createDispatcher({ factories: { direct: () => old, 'json-api': () => replacement }, senderAllowed: () => true });
    await dispatch({ source: 'test', config: source }); const replacing = dispatch({ source: 'test', config: { ...source, type: 'json-api' } }); await started; const deleting = dispatch({ source: 'delete', sourceId: source.id }); release(); await replacing; await deleting;
    expect(old.calls.dispose).toHaveBeenCalledOnce(); expect(replacement.calls.remove).toHaveBeenCalledWith(source.id); expect(replacement.calls.dispose).toHaveBeenCalledOnce();
  });
});

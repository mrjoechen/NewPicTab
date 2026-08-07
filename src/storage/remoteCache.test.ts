import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbMetadataRepository, RemoteCache, type CacheBackend, type CacheMetadataRepository } from './remoteCache';
import { MAX_REMOTE_TEXT_LENGTH } from '../sources/text';

class MemoryMeta implements CacheMetadataRepository {
  values = new Map<string, any>(); failPut = false; failDeleteCount = 0;
  async get(key: string) { return this.values.get(key); } async put(value: any) { if (this.failPut) throw new Error('meta'); this.values.set(value.cacheKey, value); }
  async delete(key: string) { if (this.failDeleteCount-- > 0) throw new Error('delete'); this.values.delete(key); } async list() { return [...this.values.values()]; }
}
class MemoryCache implements CacheBackend { values = new Map<string, Response>(); failPut = false; failDelete = false; failDeleteCount = 0; async match(key: string) { return this.values.get(key)?.clone(); } async put(key: string, response: Response) { if (this.failPut) throw new Error('put'); this.values.set(key, response.clone()); } async delete(key: string) { if (this.failDelete || this.failDeleteCount-- > 0) throw new Error('delete'); return this.values.delete(key); } async keys() { return [...this.values.keys()]; } }
const image = (bytes = 4, type = 'image/jpeg') => new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(bytes) } });

describe('RemoteCache', () => {
  it('caches safe images under a synthetic secret-free key and touches hits', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, now: (() => { let n = 1; return () => ++n; })() });
    await expect(subject.put('remote', 'https://images.example/a.jpg?token=secret', image(), 'direct')).resolves.toMatchObject({ cached: true });
    const record = (await meta.list())[0]; expect(record.cacheKey).toMatch(/^https:\/\/cache\.pictab\.invalid\//); expect(record.cacheKey).not.toContain('secret');
    await expect(subject.get('remote', 'https://images.example/a.jpg?token=secret')).resolves.toBeInstanceOf(Response);
    expect((await meta.list())[0].lastAccessed).toBeGreaterThan(record.lastAccessed);
  });
  it('rejects non-images and actual oversize content, rolls back metadata on cache failure', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, maxEntryBytes: 3 });
    await expect(subject.put('remote', 'x', image(1, 'image/svg+xml'), 'direct')).resolves.toMatchObject({ cached: false });
    await expect(subject.put('remote', 'x', image(4), 'direct')).resolves.toMatchObject({ cached: false });
    await expect(subject.get('remote', 'x')).resolves.toBeUndefined();
  });
  it('evicts least-recently-used entries but retains protected current and next entries', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, maxBytes: 20 });
    await subject.put('remote', 'old', image(3), 'direct'); await subject.put('remote', 'current', image(3), 'direct'); await subject.put('remote', 'next', image(3), 'direct');
    const outcome = await subject.evict(['current', 'next'], undefined, 6);
    expect(outcome.evicted).toHaveLength(1); expect(await subject.get('remote', 'current')).toBeInstanceOf(Response); expect(await subject.get('remote', 'next')).toBeInstanceOf(Response);
  });
  it('protects the current and next window IDs during production put-triggered eviction', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, maxBytes: 6 });
    await subject.put('remote', 'old', image(3), 'direct'); await subject.put('remote', 'current', image(3), 'direct');
    await expect(subject.put('remote', 'next', image(3), 'direct', undefined, ['current', 'next'])).resolves.toMatchObject({ cached: true });
    expect(await subject.get('remote', 'old')).toBeUndefined(); expect(await subject.get('remote', 'current')).toBeInstanceOf(Response); expect(await subject.get('remote', 'next')).toBeInstanceOf(Response);
  });
  it('removes orphan metadata and all entries for a source', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    await meta.put({ sourceId: 'ghost', entryId: 'a', cacheKey: await RemoteCache.keyFor('ghost', 'a'), size: 1, lastAccessed: 1 });
    await expect(subject.get('ghost', 'a')).resolves.toBeUndefined(); expect(await meta.list()).toHaveLength(0);
    await subject.put('one', 'a', image(), 'direct'); await subject.put('two', 'a', image(), 'direct'); await subject.deleteSource('one');
    expect(await subject.get('one', 'a')).toBeUndefined(); expect(await subject.get('two', 'a')).toBeInstanceOf(Response);
  });
  it('retries one transient metadata deletion failure during source cleanup', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    await subject.put('remote', 'one', image(), 'direct'); meta.failDeleteCount = 1;
    await expect(subject.deleteSource('remote')).resolves.toEqual({ ok: true, failedKeys: [] });
    expect(await meta.list()).toHaveLength(0);
  });
  it('retries one transient CacheStorage deletion failure during source cleanup', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    await subject.put('remote', 'one', image(), 'direct'); cache.failDeleteCount = 1;
    await expect(subject.deleteSource('remote')).resolves.toEqual({ ok: true, failedKeys: [] });
    expect(cache.values.size).toBe(0);
  });
  it('reports deletion failure when CacheStorage returns false and the bytes still exist', async () => {
    class FalseDeleteCache extends MemoryCache {
      override async delete(): Promise<boolean> { return false; }
    }
    const meta = new MemoryMeta(); const cache = new FalseDeleteCache(); const subject = new RemoteCache({ meta, cache });
    await subject.put('remote', 'one', image(), 'direct');

    const result = await subject.deleteSource('remote');

    expect(result).toMatchObject({ ok: false, failedKeys: [expect.any(String)] });
    expect(cache.values.size).toBe(1); expect(await meta.list()).toHaveLength(1);
  });
  it('lists only materializable cached descriptors for one source without exposing cache URLs', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    await subject.put('remote', 'one', image(), 'direct', { id: 'one', sourceId: 'remote', url: 'https://images.example/one.jpg?token=secret', description: 'One' });
    await subject.put('other', 'two', image(), 'direct', { id: 'two', sourceId: 'other', url: 'https://images.example/two.jpg' });

    const beforeList = (await meta.list()).find((record) => record.sourceId === 'remote')!.lastAccessed;
    const listed = await subject.listSource('remote');

    expect(listed).toEqual([{ id: 'one', sourceId: 'remote', remoteCacheEntryId: 'one', remoteCacheFingerprint: '', description: 'One' }]);
    expect(JSON.stringify(listed)).not.toContain('cache.pictab.invalid');
    expect(JSON.stringify(listed)).not.toContain('secret');
    expect((await meta.list()).find((record) => record.sourceId === 'remote')!.lastAccessed).toBe(beforeList);
  });
  it('does not persist or return URL-bearing attribution in protected cached descriptors', async () => {
    const meta = new MemoryMeta(); const subject = new RemoteCache({ meta, cache: new MemoryCache() });
    const secretUrl = 'https://private.example/customer/path.jpg?token=signed-secret';
    await subject.put('remote', 'opaque-id', image(), 'json-api', { id: 'opaque-id', sourceId: 'remote', url: secretUrl, description: 'Safe', author: 'Ada', sourceUrl: secretUrl, attribution: `Ada — ${secretUrl}` });
    const serializedRecords = JSON.stringify(await meta.list());
    const serializedResponse = JSON.stringify(await subject.listSource('remote'));
    expect(serializedRecords).not.toContain('private.example');
    expect(serializedRecords).not.toContain('signed-secret');
    expect(serializedResponse).not.toContain('private.example');
    expect(serializedResponse).not.toContain('signed-secret');
  });
  it('bounds provider-controlled descriptor text stored in metadata', async () => {
    const meta = new MemoryMeta(); const subject = new RemoteCache({ meta, cache: new MemoryCache() });
    const huge = 'x'.repeat(MAX_REMOTE_TEXT_LENGTH + 2_000);
    await subject.put('remote', 'one', image(), 'tmdb', { id: 'one', sourceId: 'remote', url: 'https://image.tmdb.org/t/p/w1280/one.jpg', description: huge, author: huge, attribution: huge });
    const descriptor = (await meta.list())[0]!.descriptor;
    expect(descriptor.description).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(descriptor.author).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
    expect(descriptor.attribution).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
  });
  it('only allows enabled remote providers', () => {
    expect(RemoteCache.canCacheSourceType('direct')).toBe(true); expect(RemoteCache.canCacheSourceType('local')).toBe(false); expect(RemoteCache.canCacheSourceType('unsplash')).toBe(false);
  });
  it('enforces provider policy at runtime as well as the source-type signature', async () => {
    const cache = new MemoryCache(); const subject = new RemoteCache({ cache, meta: new MemoryMeta() });
    await expect(subject.put('remote', 'local', image(), 'local' as never)).resolves.toMatchObject({ cached: false, reason: 'policy' }); expect(cache.values.size).toBe(0);
  });
  it('normalizes failed cache writes and retains metadata if an eviction delete fails', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, maxBytes: 20 });
    cache.failPut = true; await expect(subject.put('remote', 'fail', image(), 'direct')).resolves.toMatchObject({ reason: 'storage' }); expect(await meta.list()).toHaveLength(0);
    cache.failPut = false; await subject.put('remote', 'old', image(3), 'direct'); await subject.put('remote', 'new', image(3), 'direct'); cache.failDelete = true;
    await expect(subject.evict([], undefined, 3)).resolves.toMatchObject({ failedKeys: expect.arrayContaining([expect.any(String)]) }); expect((await meta.list()).map((item) => item.entryId)).toContain('old');
  });
  it('reports a failed implicit eviction instead of claiming the new put is safely cached', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache, maxBytes: 3 });
    await expect(subject.put('remote', 'protected', image(4), 'direct')).resolves.toMatchObject({ cached: true, blockedByProtected: true }); cache.failDelete = true;
    await expect(subject.put('remote', 'new', image(3), 'direct')).resolves.toMatchObject({ cached: false, reason: 'storage', failedKeys: expect.arrayContaining([expect.any(String)]) });
  });
  it('restores same-key bytes and metadata when replacement cache, metadata, or eviction storage fails', async () => {
    class ReplacementCache extends MemoryCache {
      failReplacementPut = false;
      failDeleteKey = '';
      override async put(key: string, response: Response) {
        await super.put(key, response);
        if (this.failReplacementPut) { this.failReplacementPut = false; throw new Error('replacement cache put'); }
      }
      override async delete(key: string) { if (key === this.failDeleteKey) throw new Error('eviction delete'); return super.delete(key); }
    }
    class ReplacementMeta extends MemoryMeta {
      failReplacementPut = false;
      override async put(value: any) {
        await super.put(value);
        if (this.failReplacementPut) { this.failReplacementPut = false; throw new Error('replacement meta put'); }
      }
    }
    for (const failure of ['cache', 'meta', 'eviction'] as const) {
      const cache = new ReplacementCache(); const meta = new ReplacementMeta();
      const subject = new RemoteCache({ cache, meta, maxBytes: failure === 'eviction' ? 6 : 100 });
      if (failure === 'eviction') await subject.put('remote', 'victim', new Response('old', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' } }), 'direct');
      await subject.put('remote', 'same', new Response('v1', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '2', 'X-Version': 'v1' } }), 'direct', { id: 'same', sourceId: 'remote', url: 'https://images.example/same.jpg', description: 'old descriptor' });
      if (failure === 'cache') cache.failReplacementPut = true;
      if (failure === 'meta') meta.failReplacementPut = true;
      if (failure === 'eviction') cache.failDeleteKey = (await meta.list()).find((record) => record.entryId === 'victim')!.cacheKey;

      await expect(subject.put('remote', 'same', new Response('v2xx', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4', 'X-Version': 'v2' } }), 'direct', { id: 'same', sourceId: 'remote', url: 'https://images.example/same.jpg', description: 'new descriptor' })).resolves.toMatchObject({ cached: false, reason: 'storage' });

      expect((await subject.get('remote', 'same'))?.headers.get('X-Version'), failure).toBe('v1');
      expect(await subject.listSource('remote'), failure).toContainEqual(expect.objectContaining({ id: 'same', description: 'old descriptor' }));
    }
  });
  it('deletes both cache and metadata when only one side of same-key restoration succeeds', async () => {
    class RestoreFailMeta extends MemoryMeta {
      replacement = false;
      override async put(value: any) { if (this.replacement) throw new Error('metadata replacement and restore'); await super.put(value); }
    }
    const cache = new MemoryCache(); const meta = new RestoreFailMeta(); const subject = new RemoteCache({ cache, meta });
    await subject.put('remote', 'same', new Response('v1', { headers: { 'Content-Type': 'image/jpeg', 'X-Version': 'v1' } }), 'direct', { id: 'same', sourceId: 'remote', url: 'https://images.example/same.jpg', description: 'old' });
    meta.replacement = true;

    await expect(subject.put('remote', 'same', new Response('v2', { headers: { 'Content-Type': 'image/jpeg', 'X-Version': 'v2' } }), 'direct', { id: 'same', sourceId: 'remote', url: 'https://images.example/same.jpg', description: 'new' })).resolves.toMatchObject({ cached: false, reason: 'storage', fallbackAvailable: false });

    await expect(subject.get('remote', 'same')).resolves.toBeUndefined();
    expect(cache.values.size).toBe(0); expect(await meta.list()).toHaveLength(0);
  });
  it('rolls back cache bytes when metadata fails, and clear removes rollback orphans', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache }); meta.failPut = true;
    await expect(subject.put('remote', 'a', image(), 'direct')).resolves.toMatchObject({ reason: 'storage' });
    expect(cache.values).toHaveLength(0); expect(await meta.list()).toHaveLength(0);
    cache.failDelete = true; await subject.put('remote', 'b', image(), 'direct'); expect(cache.values.size).toBe(1);
    cache.failDelete = false; meta.failPut = false; await expect(subject.clear()).resolves.toMatchObject({ ok: true }); expect(cache.values.size).toBe(0);
  });
  it('rejects opaque and a stream that exceeds a low declared Content-Length', async () => {
    const subject = new RemoteCache({ cache: new MemoryCache(), meta: new MemoryMeta(), maxEntryBytes: 3 });
    const opaque = image(); Object.defineProperty(opaque, 'type', { value: 'opaque' });
    await expect(subject.put('remote', 'opaque', opaque, 'direct')).resolves.toMatchObject({ reason: 'response' });
    let cancelled = false; const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2)); controller.enqueue(new Uint8Array(2)); }, cancel() { cancelled = true; } });
    const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1' } });
    await expect(subject.put('remote', 'large', response, 'direct')).resolves.toMatchObject({ reason: 'too-large' }); expect(cancelled).toBe(true);
  });
  it('cancels the inbound response when reconciliation fails before prepare', async () => {
    class BrokenKeysCache extends MemoryCache { override async keys(): Promise<string[]> { throw new Error('reconcile'); } }
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/jpeg' } });
    const subject = new RemoteCache({ cache: new BrokenKeysCache(), meta: new MemoryMeta() });

    await expect(subject.put('remote', 'entry', response, 'direct')).rejects.toThrow('reconcile');

    expect(cancelled).toBe(true);
  });
  it('serializes concurrent put, eviction, get and source deletion without splitting bytes from metadata', async () => {
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    class BlockingCache extends MemoryCache { override async put(key: string, response: Response) { entered(); await gate; await super.put(key, response); } }
    const meta = new MemoryMeta(); const cache = new BlockingCache(); const subject = new RemoteCache({ meta, cache, maxBytes: 3 });
    const putting = subject.put('remote', 'current', image(3), 'direct'); await started;
    const evicting = subject.evict(['current'], 'remote', 0); const getting = subject.get('remote', 'current'); const deleting = subject.deleteSource('remote');
    release(); await expect(putting).resolves.toMatchObject({ cached: true }); await expect(evicting).resolves.toMatchObject({ evicted: [] }); await expect(getting).resolves.toBeInstanceOf(Response); await deleting;
    expect(await meta.list()).toHaveLength(0); expect(cache.values.size).toBe(0);
  });
  it('serializes cache mutation and reconciliation across RemoteCache instances', async () => {
    const originalLocks = navigator.locks;
    const previous = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, optionsOrCallback: LockOptions | (() => Promise<unknown>), maybeCallback?: () => Promise<unknown>) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const current = (previous.get(name) ?? Promise.resolve()).then(callback);
      previous.set(name, current.then(() => undefined, () => undefined));
      return current;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    class BlockingCache extends MemoryCache { override async put(key: string, response: Response) { await super.put(key, response); entered(); await gate; } }
    const meta = new MemoryMeta(); const cache = new BlockingCache();
    const writer = new RemoteCache({ meta, cache }); const reader = new RemoteCache({ meta, cache });
    try {
      const putting = writer.put('remote', 'one', image(), 'direct', { id: 'one', sourceId: 'remote', url: 'https://images.example/one.jpg' });
      await started;
      let listed = false; const listing = reader.listSource('remote').then((value) => { listed = true; return value; });
      await Promise.resolve(); expect(listed).toBe(false);
      release();
      await expect(putting).resolves.toMatchObject({ cached: true });
      await expect(listing).resolves.toEqual([expect.objectContaining({ id: 'one', remoteCacheEntryId: 'one' })]);
    } finally {
      Object.defineProperty(navigator, 'locks', { value: originalLocks, configurable: true });
    }
  });
  it('reconciles cache-only and metadata-only crash orphans on a fresh worker instance', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const key = await RemoteCache.keyFor('remote', 'meta-only');
    await meta.put({ sourceId: 'remote', entryId: 'meta-only', cacheKey: key, size: 1, lastAccessed: 1 }); await cache.put('https://cache.pictab.invalid/cache-only', image());
    const restarted = new RemoteCache({ meta, cache }); await restarted.touch('remote', 'nothing');
    expect(await meta.list()).toHaveLength(0); expect(cache.values.size).toBe(0);
  });
  it('keeps entries separate for a known FNV-1a collision pair', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    await subject.put('remote', 'entry-179599', image(1), 'direct'); await subject.put('remote', 'entry-362382', image(2), 'direct');
    expect(await RemoteCache.keyFor('remote', 'entry-179599')).not.toBe(await RemoteCache.keyFor('remote', 'entry-362382'));
    expect(await meta.list()).toHaveLength(2); expect(cache.values.size).toBe(2);
  });
  it('namespaces bytes and metadata by opaque configuration fingerprint', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache });
    const firstFingerprint = 'a'.repeat(64); const secondFingerprint = 'b'.repeat(64);
    await subject.put('edited-source', 'same-entry', image(), 'direct', { id: 'same-entry', sourceId: 'edited-source', url: 'https://old.example/customer-secret.jpg', description: 'Old' }, [], firstFingerprint);

    expect(await subject.listSource('edited-source', firstFingerprint)).toHaveLength(1);
    expect(await subject.listSource('edited-source', secondFingerprint)).toEqual([]);
    expect(await subject.get('edited-source', 'same-entry', secondFingerprint)).toBeUndefined();
    expect(JSON.stringify(await meta.list())).not.toContain('customer-secret');
    expect(JSON.stringify(await meta.list())).not.toContain('old.example');
  });
  it('waits for real IndexedDB transaction completion before exposing metadata writes', async () => {
    const repository = new IndexedDbMetadataRepository(); const record = { sourceId: 'idb', fingerprint: '', entryId: 'entry', cacheKey: await RemoteCache.keyFor('idb', 'entry'), size: 1, lastAccessed: 1 };
    await repository.put(record); await expect(repository.get(record.cacheKey)).resolves.toEqual(record);
    await repository.delete(record.cacheKey); await expect(repository.get(record.cacheKey)).resolves.toBeUndefined();
  });
  it('does not settle an IndexedDB put until its transaction complete event fires', async () => {
    const databasePrototype = IDBDatabase.prototype; const original = databasePrototype.transaction; let completed = false;
    databasePrototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) { const transaction = original.apply(this, args); transaction.addEventListener('complete', () => { completed = true; }); return transaction; };
    try { const repository = new IndexedDbMetadataRepository(); await repository.put({ sourceId: 'order', fingerprint: '', entryId: 'entry', cacheKey: await RemoteCache.keyFor('order', 'entry'), size: 1, lastAccessed: 1 }); expect(completed).toBe(true); }
    finally { databasePrototype.transaction = original; }
  });
  it('uses deterministic one-way keys that distinguish token-only URLs without exposing credentials', async () => {
    const first = await RemoteCache.keyFor('remote', 'https://images.example/a.jpg?X-Amz-Signature=alpha-secret'); const second = await RemoteCache.keyFor('remote', 'https://images.example/a.jpg?X-Amz-Signature=beta-secret');
    expect(first).not.toBe(second); expect(await RemoteCache.keyFor('remote', 'https://images.example/a.jpg?X-Amz-Signature=alpha-secret')).toBe(first); expect(first).not.toContain('alpha-secret');
    expect(atob(first.split('/').at(-1)!)).not.toContain('alpha-secret');
  });
  it('automatically reconciles a failed rollback orphan on the next operation', async () => {
    const meta = new MemoryMeta(); const cache = new MemoryCache(); const subject = new RemoteCache({ meta, cache }); await subject.touch('remote', 'warm');
    meta.failPut = true; cache.failDelete = true; await subject.put('remote', 'orphan', image(), 'direct'); expect(cache.values.size).toBe(1);
    meta.failPut = false; cache.failDelete = false; await subject.touch('remote', 'next'); expect(cache.values.size).toBe(0);
  });
});

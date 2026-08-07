export const DEFAULT_REMOTE_CACHE_BYTES = 250 * 1024 * 1024;
/** 16 MiB keeps MV3 service-worker peak memory reasonable while streaming remote images. */
export const DEFAULT_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024;
const CACHE_NAME = 'pictab-remote-images-v1';
export const REMOTE_CACHE_LOCK = 'pictab-remote-cache-storage';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export type CacheableRemoteSourceType = 'direct' | 'json-api' | 'webdav' | 'tmdb';
/** @deprecated Use CacheableRemoteSourceType. */
export type CacheableSourceType = CacheableRemoteSourceType;
import type { ImageEntry, ImageEntryBase } from '../sources/adapter';
import { boundedRemoteText } from '../sources/text';

export interface RemoteCacheMetadata { sourceId: string; fingerprint: string; entryId: string; size: number; lastAccessed: number; cacheKey: string; descriptor?: CachedRemoteDescriptor; }
export type CachedRemoteDescriptor = Pick<ImageEntryBase, 'description' | 'author' | 'attribution' | 'dimensions' | 'previewColor'>;
export interface CacheBackend { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean>; keys(): Promise<string[]>; }
export interface CacheMetadataRepository { get(key: string): Promise<RemoteCacheMetadata | undefined>; put(value: RemoteCacheMetadata): Promise<void>; delete(key: string): Promise<void>; list(): Promise<RemoteCacheMetadata[]>; }
export type CacheKeyDigest = (input: string) => Promise<string>;
export interface RemoteCacheOptions { cache?: CacheBackend; meta?: CacheMetadataRepository; maxBytes?: number; maxEntryBytes?: number; now?: () => number; digest?: CacheKeyDigest; }
export interface EvictionResult { evicted: RemoteCacheMetadata[]; remaining: number; failedKeys: string[]; blockedByProtected: boolean; }
export interface CleanupResult { ok: boolean; failedKeys: string[]; error?: 'storage'; }
export interface PutResult { cached: boolean; reason?: 'policy' | 'response' | 'content-type' | 'too-large' | 'storage'; cacheKey?: string; failedKeys?: string[]; blockedByProtected?: boolean; fallbackAvailable?: boolean; }

/** Cache Storage holds bytes; IndexedDB holds the small LRU index. No credential-bearing request is ever cached. */
export class RemoteCache {
  private readonly cache: CacheBackend;
  private readonly meta: CacheMetadataRepository;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;
  private readonly digest: CacheKeyDigest;
  private queue: Promise<void> = Promise.resolve();
  private reconciled = false;

  constructor(options: RemoteCacheOptions = {}) {
    this.cache = options.cache ?? new BrowserCacheBackend(); this.meta = options.meta ?? new IndexedDbMetadataRepository();
    this.maxBytes = options.maxBytes ?? DEFAULT_REMOTE_CACHE_BYTES; this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_REMOTE_IMAGE_BYTES; this.now = options.now ?? Date.now; this.digest = options.digest ?? sha256;
  }
  static canCacheSourceType(type: string): type is CacheableRemoteSourceType { return type === 'direct' || type === 'json-api' || type === 'webdav' || type === 'tmdb'; }
  /** SHA-256 of the complete identifiers: cache URLs carry no reversible source or credential material. */
  static async keyFor(sourceId: string, entryId: string, fingerprint = ''): Promise<string> { return `https://cache.pictab.invalid/${await sha256(JSON.stringify([sourceId, fingerprint, entryId]))}`; }

  async put(sourceId: string, entryId: string, response: Response, sourceType: CacheableRemoteSourceType, entry?: ImageEntry, protectedEntryIds: readonly string[] = [], fingerprint = ''): Promise<PutResult> {
    try {
      if (!RemoteCache.canCacheSourceType(sourceType)) return { cached: false, reason: 'policy' };
      return await this.serial(async () => {
      await this.reconcileInternal();
      const key = await this.keyFor(sourceId, entryId, fingerprint);
      let previousRecord: RemoteCacheMetadata | undefined; let previousResponse: Response | undefined;
      try { [previousRecord, previousResponse] = await Promise.all([this.meta.get(key), this.cache.match(key)]); }
      catch { return { cached: false, reason: 'storage', fallbackAvailable: false }; }
      const hadPrevious = Boolean(previousRecord && previousResponse);
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try { prepared = await prepare(response, this.maxEntryBytes); } catch { await cancelPrevious(previousResponse); return { cached: false, reason: 'storage', ...(hadPrevious ? { fallbackAvailable: true } : {}) }; }
      if ('reason' in prepared) { await cancelPrevious(previousResponse); return { cached: false, reason: prepared.reason, ...(hadPrevious ? { fallbackAvailable: true } : {}) }; }
      try {
        await this.cache.put(key, prepared.response.clone());
        await this.meta.put({ sourceId, fingerprint, entryId, cacheKey: key, size: prepared.size, lastAccessed: this.now(), ...(entry ? { descriptor: safeDescriptor(entry, sourceType) } : {}) });
      } catch {
        const restored = await this.restorePutTarget(key, previousRecord, previousResponse);
        return { cached: false, reason: 'storage', fallbackAvailable: restored };
      }
      const protectedKeys = new Set([key]);
      for (const protectedId of protectedEntryIds) protectedKeys.add(await this.keyFor(sourceId, protectedId, fingerprint));
      let eviction: EvictionResult;
      try { eviction = await this.evictInternal(protectedKeys); }
      catch {
        const restored = await this.restorePutTarget(key, previousRecord, previousResponse);
        return { cached: false, reason: 'storage', fallbackAvailable: restored };
      }
      if (eviction.failedKeys.length) {
        const restored = await this.restorePutTarget(key, previousRecord, previousResponse);
        return { cached: false, reason: 'storage', failedKeys: eviction.failedKeys, fallbackAvailable: restored };
      }
      await cancelPrevious(previousResponse);
      return { cached: true, cacheKey: key, ...(eviction.blockedByProtected ? { blockedByProtected: true } : {}) };
      });
    } finally { await cancel(response); }
  }

  async get(sourceId: string, entryId: string, fingerprint = ''): Promise<Response | undefined> {
    return this.serial(async () => {
      await this.reconcileInternal();
      const key = await this.keyFor(sourceId, entryId, fingerprint); const [record, response] = await Promise.all([this.meta.get(key), this.cache.match(key)]);
      if (!record || !response) { if (record) await safeMetaDelete(this.meta, key); if (response) await cancel(response); return undefined; }
      try { await this.meta.put({ ...record, lastAccessed: this.now() }); } catch { /* serving a valid cached image still beats a cache miss */ }
      return response;
    });
  }
  async listSource(sourceId: string, fingerprint = ''): Promise<ImageEntry[]> {
    return this.serial(async () => {
      await this.reconcileInternal();
      const records = (await this.meta.list()).filter((record) => record.sourceId === sourceId && (record.fingerprint ?? '') === fingerprint && record.descriptor);
      const entries: ImageEntry[] = [];
      for (const record of records.sort((left, right) => right.lastAccessed - left.lastAccessed || left.entryId.localeCompare(right.entryId))) {
        const response = await this.cache.match(record.cacheKey);
        if (!response) { await safeMetaDelete(this.meta, record.cacheKey); continue; }
        void response.body?.cancel().catch(() => undefined);
        entries.push({ id: record.entryId, sourceId, remoteCacheEntryId: record.entryId, remoteCacheFingerprint: fingerprint, ...record.descriptor });
      }
      return entries;
    });
  }
  async touch(sourceId: string, entryId: string, fingerprint = ''): Promise<void> { await this.serial(async () => { await this.reconcileInternal(); const key = await this.keyFor(sourceId, entryId, fingerprint); const record = await this.meta.get(key); if (record) await this.meta.put({ ...record, lastAccessed: this.now() }); }); }
  async deleteSource(sourceId: string): Promise<CleanupResult> { return this.serial(async () => {
    await this.reconcileInternal();
    const failedKeys: string[] = []; for (const record of await this.meta.list()) if (record.sourceId === sourceId) { if (await checkedDelete(this.cache, record.cacheKey)) { if (!await safeMetaDelete(this.meta, record.cacheKey)) failedKeys.push(record.cacheKey); } else failedKeys.push(record.cacheKey); }
    return { ok: failedKeys.length === 0, failedKeys };
  }); }
  async clear(): Promise<CleanupResult> { return this.serial(async () => {
    let cacheKeys: string[]; try { cacheKeys = await this.cache.keys(); } catch { return { ok: false, failedKeys: [], error: 'storage' }; } const failedKeys: string[] = [];
    for (const key of cacheKeys) if (!await checkedDelete(this.cache, key)) failedKeys.push(key);
    if (failedKeys.length) return { ok: false, failedKeys };
    for (const record of await this.meta.list()) if (!await safeMetaDelete(this.meta, record.cacheKey)) failedKeys.push(record.cacheKey);
    return { ok: failedKeys.length === 0, failedKeys };
  }); }
  async evict(protectedEntryIds: string[] = [], sourceId?: string, targetBytes = this.maxBytes): Promise<EvictionResult> {
    return this.serial(async () => {
      await this.reconcileInternal();
      const wanted = new Set(protectedEntryIds);
      const protectedKeys = new Set((await this.meta.list()).filter((record) => wanted.has(record.entryId) && (sourceId === undefined || record.sourceId === sourceId)).map((record) => record.cacheKey));
      return this.evictInternal(protectedKeys, targetBytes);
    });
  }

  private async evictInternal(protectedKeys: Set<string>, targetBytes = this.maxBytes): Promise<EvictionResult> {
    const records = (await this.meta.list()).sort((a, b) => a.lastAccessed - b.lastAccessed || a.cacheKey.localeCompare(b.cacheKey));
    let remaining = records.reduce((sum, record) => sum + record.size, 0); const evicted: RemoteCacheMetadata[] = []; const failedKeys: string[] = [];
    for (const record of records) {
      if (remaining <= targetBytes || protectedKeys.has(record.cacheKey)) continue;
      if (!await checkedDelete(this.cache, record.cacheKey)) { failedKeys.push(record.cacheKey); continue; }
      if (!await safeMetaDelete(this.meta, record.cacheKey)) { failedKeys.push(record.cacheKey); continue; }
      remaining -= record.size; evicted.push(record);
    }
    const blockedByProtected = remaining > targetBytes && failedKeys.length === 0 && records.filter((record) => !protectedKeys.has(record.cacheKey)).every((record) => evicted.includes(record));
    return { evicted, remaining, failedKeys, blockedByProtected };
  }
  private async reconcileInternal(): Promise<void> {
    if (this.reconciled) return;
    const [cacheKeys, records] = await Promise.all([this.cache.keys(), this.meta.list()]); const indexed = new Set(records.map((record) => record.cacheKey)); let complete = true;
    for (const key of cacheKeys) if (!indexed.has(key) && !await checkedDelete(this.cache, key)) complete = false;
    const actual = new Set(cacheKeys);
    for (const record of records) if (!actual.has(record.cacheKey) && !await safeMetaDelete(this.meta, record.cacheKey)) complete = false;
    this.reconciled = complete;
  }
  private async restorePutTarget(key: string, previousRecord: RemoteCacheMetadata | undefined, previousResponse: Response | undefined): Promise<boolean> {
    if (previousRecord && previousResponse) {
      let bytesRestored = false; let metadataRestored = false;
      try { await this.cache.put(key, previousResponse.clone()); bytesRestored = true; } catch { /* restoration status is reported to the caller */ }
      try { await this.meta.put(previousRecord); metadataRestored = true; } catch { /* restoration status is reported to the caller */ }
      await cancelPrevious(previousResponse);
      if (bytesRestored && metadataRestored) return true;
      this.reconciled = false;
      await checkedDelete(this.cache, key);
      await safeMetaDelete(this.meta, key);
      return false;
    }
    await cancelPrevious(previousResponse);
    const bytesRemoved = await checkedDelete(this.cache, key);
    const metadataRemoved = await safeMetaDelete(this.meta, key);
    if (!bytesRemoved || !metadataRemoved) this.reconciled = false;
    return false;
  }
  private async keyFor(sourceId: string, entryId: string, fingerprint = ''): Promise<string> { return `https://cache.pictab.invalid/${await this.digest(JSON.stringify([sourceId, fingerprint, entryId]))}`; }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => {
      const locks = globalThis.navigator?.locks;
      return locks ? locks.request(REMOTE_CACHE_LOCK, { mode: 'exclusive' }, operation) : operation();
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function safeDescriptor(entry: ImageEntry, sourceType: CacheableRemoteSourceType): CachedRemoteDescriptor {
  return {
    ...(sourceType !== 'webdav' && safeText(entry.description) ? { description: safeText(entry.description)! } : {}),
    ...(sourceType !== 'webdav' && safeText(entry.author) ? { author: safeText(entry.author)! } : {}),
    ...(sourceType !== 'webdav' && safeText(entry.attribution) ? { attribution: safeText(entry.attribution)! } : {}),
    ...(entry.dimensions ? { dimensions: { ...entry.dimensions } } : {}),
    ...(entry.previewColor ? { previewColor: entry.previewColor } : {})
  };
}

function safeText(value: string | undefined): string | undefined { return value && !/(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/)/i.test(value) ? boundedRemoteText(value) : undefined; }

async function prepare(response: Response, limit: number): Promise<{ response: Response; size: number } | { reason: PutResult['reason'] }> {
  if (!response.ok || response.type === 'opaque') { await cancel(response); return { reason: 'response' }; }
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (!contentType || !ALLOWED_TYPES.has(contentType)) { await cancel(response); return { reason: 'content-type' }; }
  const declared = Number(response.headers.get('Content-Length')); if (Number.isFinite(declared) && declared > limit) { await cancel(response); return { reason: 'too-large' }; }
  const body = await readLimited(response, limit); if (!body) return { reason: 'too-large' };
  return { response: new Response(body.blob, { status: response.status, statusText: response.statusText, headers: response.headers }), size: body.size };
}
async function readLimited(response: Response, limit: number): Promise<{ blob: Blob; size: number } | undefined> {
  const body = response.body; if (!body) return { blob: new Blob(), size: 0 }; const reader = body.getReader(); const chunks: BlobPart[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > limit) { await reader.cancel(); return undefined; } const bytes = item.value; chunks.push(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer as ArrayBuffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); } }
  finally { reader.releaseLock(); }
  return { blob: new Blob(chunks), size };
}
async function cancel(response: Response): Promise<void> { try { await response.body?.cancel(); } catch { /* intentionally ignore cleanup failure */ } }
function cancelPrevious(response: Response | undefined): void { if (response) void cancel(response); }
async function checkedDelete(cache: CacheBackend, key: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (await cache.delete(key)) return true;
      const remaining = await cache.match(key);
      if (!remaining) return true;
      void cancel(remaining);
    } catch { /* retry one transient CacheStorage failure */ }
  }
  return false;
}
async function safeMetaDelete(meta: CacheMetadataRepository, key: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await meta.delete(key); return true; } catch { /* retry one transient metadata failure */ }
  }
  return false;
}
async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class BrowserCacheBackend implements CacheBackend {
  private async target(): Promise<Cache> { return caches.open(CACHE_NAME); }
  async match(key: string): Promise<Response | undefined> { return (await this.target()).match(key); }
  async put(key: string, response: Response): Promise<void> { await (await this.target()).put(key, response); }
  async delete(key: string): Promise<boolean> { return (await this.target()).delete(key); }
  async keys(): Promise<string[]> { return (await this.target()).keys().then((requests) => requests.map((request) => request.url)); }
}
export class IndexedDbMetadataRepository implements CacheMetadataRepository {
  private readonly db = new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pictab-remote-cache', 1); request.onupgradeneeded = () => request.result.createObjectStore('metadata', { keyPath: 'cacheKey' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  async get(key: string): Promise<RemoteCacheMetadata | undefined> { return this.request('readonly', (store) => store.get(key)); }
  async put(value: RemoteCacheMetadata): Promise<void> { await this.request('readwrite', (store) => store.put(value)); }
  async delete(key: string): Promise<void> { await this.request('readwrite', (store) => store.delete(key)); }
  async list(): Promise<RemoteCacheMetadata[]> { return (await this.request('readonly', (store) => store.getAll())) as RemoteCacheMetadata[]; }
  private async request(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<any> {
    const db = await this.db; return new Promise((resolve, reject) => {
      const transaction = db.transaction('metadata', mode); let value: unknown; let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(transaction.error ?? new DOMException('IndexedDB transaction failed.', 'AbortError')); } };
      transaction.oncomplete = () => { if (!settled) { settled = true; resolve(value); } }; transaction.onabort = fail; transaction.onerror = fail;
      let request: IDBRequest; try { request = operation(transaction.objectStore('metadata')); } catch (error) { transaction.abort(); reject(error); return; }
      request.onsuccess = () => { value = request.result; }; request.onerror = () => { /* transaction abort/error determines durable failure */ };
    });
  }
}

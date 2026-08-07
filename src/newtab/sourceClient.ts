import type { SourceConfig, TmdbSourceConfig } from '../domain/types';
import { runWithOriginPermissions } from '../lib/permissions';
import type { BackgroundRequest, BackgroundResponse } from '../background/messages';
import type { ConnectionTestResult, ListImagesResult } from '../sources/adapter';
import type { ImageEntry } from '../sources/adapter';
import { LocalSourceAdapter } from '../sources/local';
import { RemoteCache } from '../storage/remoteCache';
import { clearPendingLocalImport, deleteLocal, listLocal, listPendingLocalCleanups, markPendingLocalDeletion, markPendingLocalImport, reorderLocal } from '../storage/imageDb';
import { loadInsideDataMaintenance as loadSettings } from '../storage/settingsStore';
import type { SourceOperations, TmdbMetadataResult } from './settings/SourcesPanel';
import { withPicTabDataMutationLock } from '../storage/maintenance';
import { withChromeCallbackDeadline } from '../lib/chromeCallback';

export const RUNTIME_MESSAGE_CALLBACK_DEADLINE_MS = 30_000;

export function sendBackgroundRequest(request: BackgroundRequest): Promise<BackgroundResponse> {
  const unavailable: BackgroundResponse = { ok: false, code: 'network', message: '图片源后台服务暂不可用。' };
  return withChromeCallbackDeadline<BackgroundResponse>((complete) => {
    chrome.runtime.sendMessage(request, (response: BackgroundResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      complete(runtimeError || !response ? unavailable : response);
    });
  }, unavailable, RUNTIME_MESSAGE_CALLBACK_DEADLINE_MS);
}

export async function listSource(source: SourceConfig, localAdapter: LocalSourceAdapter, options: { offset?: number; limit?: number; cacheOnly?: boolean; protectedEntryIds?: string[] } = {}): Promise<ListImagesResult> {
  if (source.type === 'local') return localAdapter.listImages(source);
  const response = await sendBackgroundRequest({ source: 'list', config: source, ...options });
  if ('images' in response) return response;
  return { ok: false, images: [], error: { code: failureCode(response), message: failureMessage(response) } };
}

const LOCAL_MAINTENANCE_LOCK = 'pictab-local-source-maintenance';
let fallbackLocalLockTail: Promise<void> = Promise.resolve();

async function acquireExtensionLocalLock(): Promise<() => void> {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return new Promise<() => void>((resolve, reject) => {
      let started = false;
      const request = locks.request(LOCAL_MAINTENANCE_LOCK, { mode: 'exclusive' }, async () => {
        started = true;
        let unlock!: () => void;
        const held = new Promise<void>((done) => { unlock = done; });
        resolve(once(unlock));
        await held;
      });
      void Promise.resolve(request).catch((error) => { if (!started) reject(error); });
    });
  }

  const previous = fallbackLocalLockTail;
  let unlock!: () => void;
  const held = new Promise<void>((done) => { unlock = done; });
  fallbackLocalLockTail = previous.then(() => held, () => held);
  await previous.catch(() => undefined);
  return once(unlock);
}

export async function withLocalMaintenanceLock<T>(operation: () => Promise<T>, options: { insideDataMaintenance?: boolean } = {}): Promise<T> {
  if (!options.insideDataMaintenance) return withPicTabDataMutationLock(() => withLocalMaintenanceLock(operation, { insideDataMaintenance: true }));
  const release = await acquireExtensionLocalLock();
  try { return await operation(); } finally { release(); }
}

function once(operation: () => void): () => void {
  let called = false;
  return () => { if (!called) { called = true; operation(); } };
}

export function createSourceOperations(localAdapter: LocalSourceAdapter): SourceOperations {
  const previewSession = new RemoteCacheSession(undefined, URL, 36, createPreviewThumbnail);
  const uncommittedLeases = new Map<string, () => void>();
  let localMaintenance = Promise.resolve();
  const serializeLocalMaintenance = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = localMaintenance.then(operation, operation);
    localMaintenance = result.then(() => undefined, () => undefined);
    return result;
  };
  const recoverPendingLocalImports = async (): Promise<void> => {
    const settings = await loadSettings();
    const configuredLocalIds = new Set(settings.sources.filter((source) => source.type === 'local').map((source) => source.id));
    let failed = false;
    for (const { sourceId } of await listPendingLocalCleanups()) {
      try {
        if (!configuredLocalIds.has(sourceId)) await localAdapter.deleteSource(sourceId);
        await clearPendingLocalImport(sourceId);
      }
      catch { failed = true; }
    }
    if (failed) throw new Error('无法清理未完成的本地导入。');
  };
  const recoverLocalImports = () => serializeLocalMaintenance(() => withLocalMaintenanceLock(recoverPendingLocalImports));
  void recoverLocalImports().catch(() => undefined);
  return {
    async test(source): Promise<ConnectionTestResult> {
      if (source.type === 'local') return localAdapter.testConnection(source);
      const response = await sendBackgroundRequest({ source: 'test', config: source });
      if ('error' in response || response.ok && ('entries' in response || !('images' in response) && !('genres' in response))) return response as ConnectionTestResult;
      return { ok: false, error: { code: failureCode(response), message: failureMessage(response) } };
    },
    importLocal: (sourceId, files, options) => serializeLocalMaintenance(async () => {
      if (!options?.uncommitted) return withLocalMaintenanceLock(async () => { await recoverPendingLocalImports(); return localAdapter.importFiles(sourceId, files); });
      if (uncommittedLeases.has(sourceId)) throw new Error('本地导入仍在等待保存。');
      let release: (() => void) | undefined;
      try {
        const result = await withPicTabDataMutationLock(async () => {
          release = await acquireExtensionLocalLock();
          await recoverPendingLocalImports();
          await markPendingLocalImport(sourceId);
          return localAdapter.importFiles(sourceId, files);
        });
        uncommittedLeases.set(sourceId, release!);
        return result;
      } catch (error) { release?.(); throw error; }
    }),
    async delete(source) {
      if (source.type === 'local') await serializeLocalMaintenance(async () => {
        const heldRelease = uncommittedLeases.get(source.id);
        const cleanup = async () => { await localAdapter.deleteSource(source.id); await clearPendingLocalImport(source.id); };
        if (!heldRelease) { await withLocalMaintenanceLock(cleanup); return; }
        try { await cleanup(); }
        finally { uncommittedLeases.delete(source.id); heldRelease(); }
      });
      else ensureOk(await sendBackgroundRequest({ source: 'delete', sourceId: source.id }), '无法删除图片源。');
    },
    deleteCommittedLocal: (source, removeConfig) => serializeLocalMaintenance(() => withLocalMaintenanceLock(async () => {
      await markPendingLocalDeletion(source.id);
      try { await removeConfig(); }
      catch (error) { await clearPendingLocalImport(source.id); throw error; }
      try { await localAdapter.deleteSource(source.id); await clearPendingLocalImport(source.id); }
      catch { /* settings are committed; durable marker owns retrying blob cleanup */ }
    })),
    completeLocalImport: (sourceId) => serializeLocalMaintenance(async () => {
      const heldRelease = uncommittedLeases.get(sourceId);
      if (!heldRelease) { await withLocalMaintenanceLock(() => clearPendingLocalImport(sourceId)); return; }
      try { await clearPendingLocalImport(sourceId); }
      finally { uncommittedLeases.delete(sourceId); heldRelease(); }
    }),
    recoverLocalImports,
    abandonLocalImports: () => {
      for (const release of uncommittedLeases.values()) release();
      uncommittedLeases.clear();
    },
    async loadTmdbMetadata(source: TmdbSourceConfig): Promise<TmdbMetadataResult> {
      const response = await sendBackgroundRequest({ source: 'tmdb-metadata', config: source });
      return response.ok && 'genres' in response
        ? { ok: true, genres: response.genres.map(({ id, name }) => ({ id, name })) }
        : { ok: false, error: { message: failureMessage(response) } };
    },
    withOriginPermissions: runWithOriginPermissions,
    list: (source, options = {}) => listSource(source, localAdapter, { limit: 6, ...options }),
    materializePreview: (entries) => previewSession.materialize(entries),
    listLocalFiles: (sourceId) => listLocal(sourceId),
    deleteLocalImage: (sourceId, imageId) => serializeLocalMaintenance(() => withLocalMaintenanceLock(() => deleteLocal(sourceId, imageId))),
    reorderLocalImages: (sourceId, ids) => serializeLocalMaintenance(() => withLocalMaintenanceLock(() => reorderLocal(sourceId, ids))),
    refresh: async (source) => {
      if (source.type === 'local') { await localAdapter.refreshMetadata(source); ensureListOk(await localAdapter.listImages(source), '无法刷新图片源。'); }
      else {
        ensureOk(await sendBackgroundRequest({ source: 'refresh', config: source }), '无法刷新图片源。');
        const listed = await sendBackgroundRequest({ source: 'list', config: source, offset: 0, limit: 12, forceRefresh: true });
        if (!('images' in listed) || !listed.ok) throw new Error('无法刷新图片源。');
      }
    },
    clearCache: async (source) => {
      if (source.type !== 'local') ensureOk(await sendBackgroundRequest({ source: 'clear-source-cache', sourceId: source.id }), '无法清除缓存。');
    }
  };
}

function ensureOk(response: BackgroundResponse, message: string): void { if (!response.ok) throw new Error(message); }
function ensureListOk(response: ListImagesResult, message: string): void { if (!response.ok) throw new Error(message); }

interface CacheReader { get(sourceId: string, entryId: string, fingerprint: string): Promise<Response | undefined>; }
interface SessionUrlApi { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void; }
type BlobTransform = (blob: Blob) => Promise<Blob>;

/** Materializes synthetic CacheStorage entries; cache keys never become browser-loadable URLs. */
export class RemoteCacheSession {
  private readonly active = new Set<RemoteCacheLease>();
  private cache: CacheReader | undefined;
  private allocatedUrls = 0;
  private disposed = false;
  constructor(
    cache?: CacheReader,
    private readonly urlApi: SessionUrlApi = URL,
    private readonly maxOwnedUrls = 36,
    private readonly transformBlob?: BlobTransform
  ) { this.cache = cache; }

  async materialize(entries: readonly ImageEntry[]): Promise<RemoteCacheLease> {
    return withPicTabDataMutationLock(() => this.materializeInsideDataMaintenance(entries));
  }

  private async materializeInsideDataMaintenance(entries: readonly ImageEntry[]): Promise<RemoteCacheLease> {
    const nextUrls = new Set<string>();
    const output: ImageEntry[] = [];
    try {
      for (const entry of entries) {
        if (!('remoteCacheEntryId' in entry)) { output.push(entry); continue; }
        if (this.allocatedUrls >= this.urlLimit()) continue;
        this.allocatedUrls += 1;
        let added = false;
        try {
          const response = await this.reader().get(entry.sourceId, entry.remoteCacheEntryId, entry.remoteCacheFingerprint);
          if (!response) { this.allocatedUrls -= 1; continue; }
          const sourceBlob = await response.blob();
          const displayBlob = this.transformBlob ? await this.transformBlob(sourceBlob) : sourceBlob;
          const url = this.urlApi.createObjectURL(displayBlob);
          nextUrls.add(url);
          added = true;
          const { remoteCacheEntryId: _cacheId, remoteCacheFingerprint: _fingerprint, ...base } = entry;
          output.push({ ...base, url });
        } catch (error) {
          if (!added) this.allocatedUrls -= 1;
          throw error;
        }
      }
    } catch (error) {
      for (const url of nextUrls) { try { this.urlApi.revokeObjectURL(url); } catch { /* best-effort failed lease cleanup */ } }
      this.allocatedUrls = Math.max(0, this.allocatedUrls - nextUrls.size);
      throw error;
    }
    const allocatedByLease = nextUrls.size;
    return new RemoteCacheLease(output, nextUrls, this.urlApi, (lease) => {
      this.active.delete(lease);
      this.allocatedUrls = Math.max(0, this.allocatedUrls - allocatedByLease);
    });
  }

  commit(lease: RemoteCacheLease): boolean {
    if (this.disposed) { lease.release(); return false; }
    if (!lease.entries.length || lease.released) { lease.release(); return false; }
    if (lease.urlCount === 0) return true;
    if (this.active.has(lease)) return true;
    const ownedUrls = [...this.active].reduce((count, activeLease) => count + activeLease.urlCount, 0);
    if (ownedUrls + lease.urlCount > this.maxOwnedUrls) { lease.release(); return false; }
    this.active.add(lease);
    return true;
  }

  release(lease: RemoteCacheLease): boolean {
    if (!this.active.has(lease)) return false;
    lease.release();
    return true;
  }

  clear(): void {
    for (const lease of [...this.active]) lease.release();
    this.active.clear();
  }
  activate(): void { this.disposed = false; }
  dispose(): void { this.disposed = true; this.clear(); }

  private urlLimit(): number {
    return Number.isSafeInteger(this.maxOwnedUrls) ? Math.min(36, Math.max(0, this.maxOwnedUrls)) : 36;
  }

  private reader(): CacheReader { return this.cache ??= new RemoteCache(); }
}

export class RemoteCacheLease {
  private readonly urls: Set<string>;
  released = false;
  constructor(readonly entries: ImageEntry[], urls: Set<string>, private readonly urlApi: SessionUrlApi, private readonly onRelease?: (lease: RemoteCacheLease) => void) { this.urls = urls; }
  get urlCount(): number { return this.urls.size; }
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const url of this.urls) { try { this.urlApi.revokeObjectURL(url); } catch { /* best-effort lease cleanup */ } }
    this.urls.clear();
    this.onRelease?.(this);
  }
}

async function createPreviewThumbnail(blob: Blob): Promise<Blob> {
  if (!globalThis.createImageBitmap || typeof OffscreenCanvas === 'undefined') return blob;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 480 / bitmap.width, 300 / bitmap.height);
    if (scale >= 1) return blob;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.78 });
  } catch {
    return blob;
  } finally {
    bitmap?.close();
  }
}

function failureMessage(response: BackgroundResponse): string {
  if (!response.ok && 'message' in response) return response.message;
  if (!response.ok && 'error' in response) return response.error.message;
  return '图片源返回了无效结果。';
}

function failureCode(response: BackgroundResponse): 'validation' | 'permission' | 'auth' | 'network' | 'http' | 'rate-limit' | 'empty' | 'parse' | 'decode' | 'unknown' {
  if (!response.ok && 'error' in response) return response.error.code;
  if (!response.ok && 'code' in response && response.code !== 'unsupported') return response.code;
  return 'unknown';
}

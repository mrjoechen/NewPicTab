import type { SourceConfig, SourceType } from '../domain/types';
import type { ImageEntry, SourceAdapter, SourceError } from '../sources/adapter';
import { DirectSourceAdapter } from '../sources/direct';
import { JsonApiSourceAdapter } from '../sources/jsonApi';
import { WebDavSourceAdapter } from '../sources/webdav';
import { TmdbSourceAdapter, type TmdbMetadata } from '../sources/tmdb';
import { RemoteCache } from '../storage/remoteCache';
import { isBackgroundRequest, type BackgroundFailure, type BackgroundRequest, type BackgroundResponse } from './messages';
import { sourceConfigFingerprint } from '../domain/sourceFingerprint';
import { IndexedDbCatalogRepository, isPersistableCatalog, type CatalogRecord, type CatalogRepository } from '../storage/catalogRepository';
import { OpenMeteoService, WeatherServiceError, reverseGeocodeLocation } from '../weather/openMeteo';
import { getAllLocal, removeLocal } from '../lib/chrome';
import { AUXILIARY_STORAGE_MAINTENANCE_LOCK, withPicTabDataMutationLock } from '../storage/maintenance';
import { boundedRemoteText } from '../sources/text';

type RemoteSourceType = Exclude<SourceType, 'local'>;
type AnyAdapter = SourceAdapter<any> & { getMetadata?: (config: any) => TmdbMetadata };
export type AdapterFactory = () => AnyAdapter;
export interface DispatcherOptions {
  factories?: Partial<Record<RemoteSourceType, AdapterFactory>>;
  senderAllowed?: (sender: chrome.runtime.MessageSender) => boolean;
  weatherHandler?: (request: Extract<BackgroundRequest, { weather: string }>) => Promise<BackgroundResponse>;
  remoteCache?: RemoteCache;
  imageFetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  catalogRepository?: CatalogRepository;
  weatherService?: Pick<OpenMeteoService, 'searchCities' | 'current' | 'clearCache'>;
  reverseGeocode?: typeof reverseGeocodeLocation;
  clearAuxiliaryData?: () => Promise<void>;
}

const CACHE_FETCH_CONCURRENCY = 4;
const DEFAULT_WINDOW_SIZE = 12;

const defaultFactories: Record<RemoteSourceType, AdapterFactory> = {
  direct: () => new DirectSourceAdapter() as unknown as AnyAdapter,
  'json-api': () => new JsonApiSourceAdapter() as unknown as AnyAdapter,
  webdav: () => new WebDavSourceAdapter() as unknown as AnyAdapter,
  tmdb: () => new TmdbSourceAdapter() as unknown as AnyAdapter,
};

/** Pure dispatcher: callback-compatible browser listener glue is deliberately kept below. */
export function createDispatcher(options: DispatcherOptions = {}): (message: unknown, sender?: chrome.runtime.MessageSender) => Promise<BackgroundResponse> {
  const factories = { ...defaultFactories, ...options.factories };
  const instances = new Map<string, { type: RemoteSourceType; adapter: AnyAdapter }>();
  const metadataLists = new Map<string, CatalogRecord>();
  const sourceQueues = new Map<string, Promise<void>>();
  let cacheEpoch = 0;
  let clearingAllData = false;
  const remoteCache = options.remoteCache ?? (globalThis.caches && globalThis.indexedDB ? new RemoteCache() : undefined);
  const catalogRepository = options.catalogRepository ?? (globalThis.indexedDB ? new IndexedDbCatalogRepository() : undefined);
  const imageFetcher = options.imageFetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const weatherService = options.weatherService ?? new OpenMeteoService();
  const reverseGeocode = options.reverseGeocode ?? reverseGeocodeLocation;
  const clearAuxiliaryData = options.clearAuxiliaryData ?? clearAuxiliaryStorage;
  // Chrome supplies runtime.id in production; a missing id is accepted only in test shims where
  // runtime.id is also absent (or via the injected sender policy).
  const allowed = options.senderAllowed ?? ((sender) => sender.id === chrome.runtime.id);
  return async (message, sender = {} as chrome.runtime.MessageSender) => {
    try {
      if (!allowed(sender)) return failure('permission', 'Messages must originate from this extension.');
      if (!isBackgroundRequest(message)) return failure('validation', 'Invalid background request.');
      if ('system' in message) {
        if (clearingAllData) return failure('unknown', 'PicTab data clearing is already in progress.');
        clearingAllData = true;
        cacheEpoch += 1;
        metadataLists.clear();
        try {
          await Promise.allSettled([...sourceQueues.values()]);
          const adapters = [...instances.values()];
          instances.clear();
          const tasks: { name: string; run: () => Promise<unknown> }[] = [
            { name: 'source adapters', run: async () => { const results = await Promise.allSettled(adapters.map(({ adapter }) => adapter.dispose())); if (results.some((result) => result.status === 'rejected')) throw new Error('adapter cleanup failed'); } },
            { name: 'remote image cache', run: async () => { if (!remoteCache) throw new Error('cache unavailable'); const result = await remoteCache.clear(); if (!result.ok) throw new Error('cache cleanup failed'); } },
            { name: 'remote image catalog', run: async () => { if (catalogRepository) await catalogRepository.clear(); } },
            { name: 'weather cache', run: () => weatherService.clearCache() },
            { name: 'browser journals and cursors', run: clearAuxiliaryData }
          ];
          const settled = await Promise.allSettled(tasks.map(({ run }) => run()));
          const failures = settled.flatMap((result, index) => result.status === 'rejected' ? [tasks[index]!.name] : []);
          return failures.length ? { ok: false, code: 'unknown', message: 'Some PicTab data could not be cleared.', failures } : { ok: true };
        } finally { clearingAllData = false; }
      }
      return await withPicTabDataMutationLock(async () => {
      if (clearingAllData) return failure('unknown', 'PicTab data clearing is in progress.');
      if ('weather' in message) return safeClone(await (options.weatherHandler ? options.weatherHandler(message) : handleWeatherRequest(weatherService, reverseGeocode, message)));
      if (message.source === 'clear-cache') {
        cacheEpoch += 1;
        metadataLists.clear();
        const [cacheCleared, catalogCleared] = await Promise.all([
          remoteCache ? remoteCache.clear().then((result) => result.ok, () => false) : Promise.resolve(false),
          catalogRepository ? catalogRepository.clear().then(() => true, () => false) : Promise.resolve(true)
        ]);
        return cacheCleared && catalogCleared ? { ok: true } : failure('unknown', 'Could not clear all cached source data.');
      }
      if (message.source === 'clear-source-cache') {
        return await runForSource(message.sourceId, sourceQueues, async () => {
          metadataLists.delete(message.sourceId);
          const [cacheCleared, catalogCleared] = await Promise.all([
            remoteCache ? remoteCache.deleteSource(message.sourceId).then((result) => result.ok, () => false) : Promise.resolve(false),
            catalogRepository ? catalogRepository.delete(message.sourceId).then(() => true, () => false) : Promise.resolve(true)
          ]);
          return cacheCleared && catalogCleared ? { ok: true } : failure('unknown', 'Could not clear all cached data for this source.');
        });
      }
      if (message.source === 'delete') return await runForSource(message.sourceId, sourceQueues, async () => {
        const cached = instances.get(message.sourceId);
        metadataLists.delete(message.sourceId);
        const adapterCleanup = async (): Promise<boolean> => {
          if (!cached) return true;
          let ok = true;
          try { await cached.adapter.deleteSource(message.sourceId); } catch { ok = false; }
          try { await cached.adapter.dispose(); } catch { ok = false; }
          instances.delete(message.sourceId);
          return ok;
        };
        const [adapterCleaned, catalogCleaned, cacheCleaned] = await Promise.all([
          adapterCleanup(),
          catalogRepository ? catalogRepository.delete(message.sourceId).then(() => true, () => false) : Promise.resolve(true),
          remoteCache ? remoteCache.deleteSource(message.sourceId).then((result) => result.ok, () => false) : Promise.resolve(true)
        ]);
        return adapterCleaned && catalogCleaned && cacheCleaned ? { ok: true } : failure('unknown', 'Could not remove all cached source data.');
      });
      const config = message.config;
      if (config.type === 'local') return failure('unsupported', 'Local sources do not run in the background worker.');
      return await runForSource(config.id, sourceQueues, async () => {
        const acquired = await acquireValidated(config, instances, factories);
        if ('error' in acquired) return safeClone({ ok: false, ...acquired.error });
        const adapter = acquired.adapter;
        if (message.source === 'tmdb-metadata') {
          if (config.type !== 'tmdb' || !adapter.getMetadata) return failure('validation', 'TMDB metadata requires a TMDB source.');
          await adapter.refreshMetadata(config);
          const metadata = adapter.getMetadata(config);
          return safeClone({ ok: true, genres: [...metadata.genres], languages: [...metadata.languages], regions: [...metadata.regions] });
        }
        if (message.source === 'test') {
          const tested = await adapter.testConnection(config);
          return safeClone(config.type === 'webdav' || config.type === 'json-api' ? sanitizeProtectedConnection(tested, config.id) : tested);
        }
        if (message.source === 'list') {
          const listEpoch = cacheEpoch;
          const offset = boundedInteger(message.offset, 0, 0, 1_000_000);
          const limit = boundedInteger(message.limit, DEFAULT_WINDOW_SIZE, 1, 24);
          const fingerprint = await sourceConfigFingerprint(config);
          let knownMetadata = metadataLists.get(config.id);
          if (knownMetadata?.fingerprint !== fingerprint) knownMetadata = undefined;
          if (!knownMetadata && catalogRepository) {
            const loaded = await catalogRepository.get(config.id, fingerprint);
            if (listEpoch === cacheEpoch && loaded) { knownMetadata = loaded; metadataLists.set(config.id, loaded); }
          }
          if (message.cacheOnly) {
            if (!remoteCache) return safeClone({ ok: false, images: [], error: { code: 'unknown', message: 'The local image cache is unavailable.' } });
            const cachedImages = orderedCached(await remoteCache.listSource(config.id, fingerprint), knownMetadata?.images);
            const window = cachedImages.slice(offset, offset + limit);
            const totalCount = knownMetadata?.images.length ?? cachedImages.length;
            return window.length
              ? safeClone({ ok: true, images: window as [ImageEntry, ...ImageEntry[]], totalCount, offset, consumedCount: window.length, nextOffset: offset + window.length, hasMore: offset + window.length < totalCount })
              : safeClone({ ok: false, images: [], error: { code: 'empty', message: 'No cached images are available for this source.' } });
          }
          const forceRefresh = message.forceRefresh === true;
          let listed = knownMetadata?.fingerprint === fingerprint
            ? { ok: true as const, images: knownMetadata.images, ...(knownMetadata.warnings ? { warnings: knownMetadata.warnings } : {}) }
            : await adapter.listImages(config);
          if (!listed.ok) {
            const cachedImages = orderedCached(await remoteCache?.listSource(config.id, fingerprint) ?? [], knownMetadata?.images);
            const staleWarning: SourceError = { code: listed.error.code, message: 'Cached images are being used because the source could not be refreshed.', retryable: listed.error.retryable };
            const window = cachedImages.slice(offset, offset + limit);
            return window.length ? safeClone({ ok: true, images: window as [ImageEntry, ...ImageEntry[]], totalCount: cachedImages.length, offset, consumedCount: window.length, nextOffset: offset + window.length, hasMore: offset + window.length < cachedImages.length, warnings: [...(listed.warnings ?? []), staleWarning] }) : safeClone(listed);
          }
          if (knownMetadata?.fingerprint !== fingerprint) {
            const record: CatalogRecord = { sourceId: config.id, sourceType: config.type, fingerprint, images: listed.images, totalCount: listed.images.length, fetchedAt: Date.now(), ...(listed.warnings ? { warnings: listed.warnings } : {}) };
            if (listEpoch === cacheEpoch) {
              if (isPersistableCatalog(record) && catalogRepository) {
                await catalogRepository.put(record);
                if (listEpoch !== cacheEpoch) await catalogRepository.delete(config.id, fingerprint).catch(() => undefined);
              }
              if (listEpoch === cacheEpoch) metadataLists.set(config.id, record);
            }
          }
          const totalCount = listed.images.length;
          const metadataWindow = listed.images.slice(offset, offset + limit);
          const consumedCount = metadataWindow.length;
          const nextOffset = offset + consumedCount;
          if (!metadataWindow.length) return safeClone({ ok: false, images: [], error: { code: 'empty', message: 'No images exist in this window.' } });
          if (!remoteCache) return safeClone({ ok: false, images: [], error: { code: 'unknown', message: 'Remote images require the local image cache.' } });
          const protectedIds = [...new Set([...(message.protectedEntryIds ?? []).slice(0, 2), ...metadataWindow.map((entry) => entry.id)])];
          const preferred = await preferCachedImages(config, fingerprint, metadataWindow, remoteCache, imageFetcher, () => listEpoch === cacheEpoch, protectedIds, forceRefresh);
          const finalized = await finalizeCacheWindow(remoteCache, config.id, fingerprint, preferred.images, (message.protectedEntryIds ?? []).slice(0, 2));
          const warnings = [...(listed.warnings ?? []), ...preferred.warnings, ...finalized.warnings];
          if (forceRefresh && preferred.warnings.some(isStaleCacheWarning) && listEpoch === cacheEpoch) {
            const currentRecord = metadataLists.get(config.id);
            if (currentRecord?.fingerprint === fingerprint) {
              const staleRecord: CatalogRecord = { ...currentRecord, warnings };
              metadataLists.set(config.id, staleRecord);
              if (isPersistableCatalog(staleRecord) && catalogRepository) await catalogRepository.put(staleRecord);
            }
          }
          if (finalized.images.length) return safeClone({ ...listed, images: finalized.images as [ImageEntry, ...ImageEntry[]], totalCount, offset, consumedCount, nextOffset, hasMore: nextOffset < totalCount, ...(warnings.length ? { warnings } : {}) });
          const cachedImages = orderedCached(await remoteCache.listSource(config.id, fingerprint), listed.images);
          const cachedWindow = cachedImages.slice(offset, offset + limit);
          return cachedWindow.length
            ? safeClone({ ok: true, images: cachedWindow as [ImageEntry, ...ImageEntry[]], totalCount, offset, consumedCount, nextOffset, hasMore: nextOffset < totalCount, ...(warnings.length ? { warnings } : {}) })
            : safeClone({ ok: false, images: [], error: { code: 'network', message: 'No remote images could be cached for display.', retryable: true }, ...(warnings.length ? { warnings } : {}) });
        }
        await adapter.refreshMetadata(config);
        const fingerprint = await sourceConfigFingerprint(config);
        metadataLists.delete(config.id);
        await catalogRepository?.delete(config.id, fingerprint);
        return { ok: true };
      });
      });
    } catch (error) { return failure('unknown', safeErrorMessage(error, message)); }
  };
}

/** Cache one requested metadata window while keeping network pressure bounded. */
async function preferCachedImages(
  config: Exclude<SourceConfig, { type: 'local' }>,
  fingerprint: string,
  images: readonly ImageEntry[],
  cache: RemoteCache,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  canWrite: () => boolean,
  protectedEntryIds: readonly string[],
  forceRefresh = false
): Promise<{ images: ImageEntry[]; warnings: SourceError[] }> {
  const output: (ImageEntry | null)[] = new Array(images.length).fill(null);
  const warnings: SourceError[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < images.length) {
      const index = cursor++;
      const entry = images[index]!;
      const hit = await cache.get(config.id, entry.id, fingerprint);
      const hadCachedImage = Boolean(hit);
      if (hit) void hit.body?.cancel().catch(() => undefined);
      if (hadCachedImage && !forceRefresh) {
        output[index] = cachedEntry(entry, fingerprint, config.type);
        continue;
      }
      if (!('url' in entry) || !entry.url) { output[index] = entry; continue; }
      if (!isAuthorizedImageUrl(config, entry.url)) {
        warnings.push({ code: 'permission', message: 'An image from an unapproved origin was skipped.' });
        if (hadCachedImage && await hasReadableCacheFallback(cache, config.id, entry.id, fingerprint)) {
          output[index] = cachedEntry(entry, fingerprint, config.type);
          warnings.push(staleCachedWarning('authorized'));
        }
        continue;
      }
    try {
      const response = await fetchWithDeadline(fetcher, entry.url, { method: 'GET', headers: imageHeaders(config), redirect: 'manual' }, 15_000);
        if ((config.type === 'webdav' || config.type === 'json-api') && response.url && !isAuthorizedImageUrl(config, response.url)) {
          try { await response.body?.cancel(); } catch { /* best-effort redirect body cleanup */ }
          warnings.push({ code: 'permission', message: 'An image redirected to an unapproved origin and was skipped.' });
          if (hadCachedImage && await hasReadableCacheFallback(cache, config.id, entry.id, fingerprint)) {
            output[index] = cachedEntry(entry, fingerprint, config.type);
            warnings.push(staleCachedWarning('authorized'));
          }
          continue;
        }
        if (!canWrite()) { void response.body?.cancel().catch(() => undefined); continue; }
      const stored = await cache.put(config.id, entry.id, response, config.type, entry, protectedEntryIds, fingerprint);
        const canUseFallback = !stored.cached && hadCachedImage && await hasReadableCacheFallback(cache, config.id, entry.id, fingerprint);
        output[index] = stored.cached || canUseFallback ? cachedEntry(entry, fingerprint, config.type) : null;
        if (!stored.cached) warnings.push(canUseFallback ? staleCachedWarning('stored') : { code: 'network', message: 'A remote image could not be cached.', retryable: true });
      } catch {
        const canUseFallback = hadCachedImage && await hasReadableCacheFallback(cache, config.id, entry.id, fingerprint);
        output[index] = canUseFallback ? cachedEntry(entry, fingerprint, config.type) : null;
        warnings.push(canUseFallback ? staleCachedWarning('fetched') : { code: 'network', message: 'A remote image could not be cached.', retryable: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CACHE_FETCH_CONCURRENCY, images.length) }, worker));
  return { images: output.filter((entry): entry is ImageEntry => Boolean(entry)), warnings };
}

async function hasReadableCacheFallback(cache: RemoteCache, sourceId: string, entryId: string, fingerprint: string): Promise<boolean> {
  const response = await cache.get(sourceId, entryId, fingerprint);
  if (!response) return false;
  void response.body?.cancel().catch(() => undefined);
  return true;
}
function staleCachedWarning(reason: 'authorized' | 'stored' | 'fetched'): SourceError {
  const detail = reason === 'authorized' ? 'the refreshed URL was not authorized' : reason === 'stored' ? 'refreshed bytes could not be stored' : 'refreshed bytes could not be fetched';
  return { code: reason === 'authorized' ? 'permission' : 'network', message: `Cached images are being used because ${detail}.`, retryable: reason !== 'authorized' };
}

function isStaleCacheWarning(warning: SourceError): boolean { return warning.message.startsWith('Cached images are being used'); }

async function finalizeCacheWindow(cache: RemoteCache, sourceId: string, fingerprint: string, images: readonly ImageEntry[], protectedEntryIds: readonly string[]): Promise<{ images: ImageEntry[]; warnings: SourceError[] }> {
  if (typeof cache.evict !== 'function') return { images: [...images], warnings: [] };
  const warnings: SourceError[] = [];
  try {
    const eviction = await cache.evict([...protectedEntryIds], sourceId);
    if (eviction.failedKeys.length) warnings.push({ code: 'network', message: 'Some cached images could not be evicted safely.', retryable: true });
  } catch { warnings.push({ code: 'network', message: 'The image cache could not restore its storage limit.', retryable: true }); }
  const readable: ImageEntry[] = [];
  for (const entry of images) {
    if (!('remoteCacheEntryId' in entry)) { readable.push(entry); continue; }
    if (await hasReadableCacheFallback(cache, sourceId, entry.remoteCacheEntryId, fingerprint)) readable.push(entry);
  }
  return { images: readable, warnings };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback; }
function orderedCached(cached: readonly ImageEntry[], catalog?: readonly ImageEntry[]): ImageEntry[] {
  if (!catalog) return [...cached];
  const byId = new Map(cached.map((entry) => [entry.id, entry]));
  const ordered = catalog.flatMap((entry) => { const cachedEntry = byId.get(entry.id); if (!cachedEntry) return []; byId.delete(entry.id); return [cachedEntry]; });
  return [...ordered, ...cached.filter((entry) => byId.has(entry.id))];
}

async function fetchWithDeadline(fetcher: (url: string, init?: RequestInit) => Promise<Response>, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function isAuthorizedImageUrl(config: Exclude<SourceConfig, { type: 'local' }>, value: string): boolean {
  if (config.type !== 'json-api' && config.type !== 'webdav') return true;
  try {
    const originPattern = `${new URL(value).origin}/*`;
    if (config.type === 'json-api') return config.authorizedImageOrigins.includes(originPattern);
    return new URL(value).origin === new URL(config.url).origin;
  } catch { return false; }
}

function cachedEntry(entry: ImageEntry, fingerprint: string, sourceType: RemoteSourceType): ImageEntry {
  return {
    id: entry.id,
    sourceId: entry.sourceId,
    remoteCacheEntryId: entry.id,
    remoteCacheFingerprint: fingerprint,
    ...(sourceType !== 'webdav' && safeText(entry.description) ? { description: safeText(entry.description)! } : {}),
    ...(sourceType !== 'webdav' && safeText(entry.author) ? { author: safeText(entry.author)! } : {}),
    ...(sourceType !== 'webdav' && safeText(entry.attribution) ? { attribution: safeText(entry.attribution)! } : {}),
    ...(entry.dimensions ? { dimensions: entry.dimensions } : {}),
    ...(entry.previewColor ? { previewColor: entry.previewColor } : {})
  };
}

function safeText(value: string | undefined): string | undefined { return value && !/(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/)/i.test(value) ? boundedRemoteText(value) : undefined; }

function sanitizeProtectedConnection(result: import('../sources/adapter').ConnectionTestResult, sourceId: string): import('../sources/adapter').ProtectedConnectionTestResult {
  const raw = result as unknown as Record<string, unknown>;
  const imageOrigins = Array.isArray(raw.imageOrigins) ? [...new Set(raw.imageOrigins.filter(exactHttpsOriginPattern))] : [];
  const count = typeof raw.count === 'number' && Number.isSafeInteger(raw.count) && raw.count >= 0 ? Math.min(raw.count, 1_000_000) : 0;
  const preview = Array.isArray(raw.preview) ? raw.preview.flatMap((value) => safeProtectedPreview(value, sourceId)) : [];
  const directories = Array.isArray(raw.directories) ? safeWebDavDirectories(raw.directories) : undefined;
  const warnings = Array.isArray(raw.warnings) && raw.warnings.length ? raw.warnings.slice(0, 100).map((): SourceError => ({ code: 'parse', message: 'A source item was skipped.' })) : undefined;
  const base = { protected: true as const, imageOrigins, count, preview, ...(directories ? { directories } : {}), ...(warnings ? { warnings } : {}) };
  if (result.ok) return { ok: true, ...base };
  const code = isSourceErrorCode(result.error?.code) ? result.error.code : 'unknown';
  return { ok: false, ...base, error: { code, message: 'The protected source connection test failed.' } };
}

function safeWebDavDirectories(values: unknown[]): import('../sources/adapter').SafeWebDavDirectory[] {
  const unique = new Map<string, import('../sources/adapter').SafeWebDavDirectory>();
  for (const value of values) {
    const directory = safeWebDavDirectory(value)[0];
    if (directory && !unique.has(directory.name)) unique.set(directory.name, directory);
  }
  return [...unique.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).slice(0, 200);
}

function safeWebDavDirectory(value: unknown): import('../sources/adapter').SafeWebDavDirectory[] {
  if (!value || typeof value !== 'object') return [];
  const directory = value as Record<string, unknown>;
  if (typeof directory.id !== 'string' || !/^dir_[0-9a-f]{64}$/.test(directory.id)) return [];
  if (typeof directory.name !== 'string' || directory.name.length === 0 || directory.name.length > 120 || !safeDirectorySegment(directory.name)) return [];
  if (!Array.isArray(directory.relativeSegments) || directory.relativeSegments.length !== 1 || directory.relativeSegments[0] !== directory.name) return [];
  return [{ id: directory.id, name: directory.name, relativeSegments: [directory.name] }];
}

function safeDirectorySegment(value: string): boolean {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded) || /(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/)/i.test(decoded)) return false;
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return false; }
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

function isSourceErrorCode(value: unknown): value is SourceError['code'] { return typeof value === 'string' && ['validation', 'permission', 'auth', 'network', 'http', 'rate-limit', 'empty', 'parse', 'decode', 'unknown'].includes(value); }

function exactHttpsOriginPattern(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('/*')) return false;
  try { const url = new URL(value.slice(0, -1)); return url.protocol === 'https:' && !url.username && !url.password && value === `${url.origin}/*`; } catch { return false; }
}

function safeProtectedPreview(value: unknown, sourceId: string): import('../sources/adapter').SafeImagePreview[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !/^img_[0-9a-f]{64}$/.test(item.id) || item.sourceId !== sourceId) return [];
  const dimensions = item.dimensions && typeof item.dimensions === 'object' && Number.isFinite((item.dimensions as any).width) && Number.isFinite((item.dimensions as any).height)
    ? { width: (item.dimensions as any).width as number, height: (item.dimensions as any).height as number } : undefined;
  const safePlainText = (text: unknown) => typeof text === 'string' && text.length <= 300 && !/[\\/?#\u0000-\u001f]/.test(text) && !/(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/)/i.test(text) ? text : undefined;
  return [{ id: item.id, sourceId, ...(safePlainText(item.description) ? { description: safePlainText(item.description)! } : {}), ...(safePlainText(item.author) ? { author: safePlainText(item.author)! } : {}), ...(dimensions ? { dimensions } : {}) }];
}

function imageHeaders(config: Exclude<SourceConfig, { type: 'local' }>): Headers {
  if (config.type === 'webdav') return new Headers({ Accept: 'image/*', Authorization: utf8Basic(config.username, config.password) });
  return new Headers({ Accept: 'image/*' });
}

function utf8Basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return `Basic ${btoa(value)}`;
}

async function acquireValidated(config: Exclude<SourceConfig, { type: 'local' }>, instances: Map<string, { type: RemoteSourceType; adapter: AnyAdapter }>, factories: Record<RemoteSourceType, AdapterFactory>): Promise<{ adapter: AnyAdapter } | { error: { code: BackgroundFailure['code']; message: string } }> {
  const existing = instances.get(config.id);
  if (existing?.type === config.type) { const validation = existing.adapter.validateConfig(config); return validation.ok ? { adapter: existing.adapter } : { error: validation.error }; }
  const factory = factories[config.type];
  if (!factory) throw new Error('Unsupported source adapter.');
  const adapter = factory();
  try {
    const validation = adapter.validateConfig(config);
    if (!validation.ok) return { error: validation.error };
    if (existing) { await existing.adapter.dispose(); instances.delete(config.id); }
    instances.set(config.id, { type: config.type, adapter }); return { adapter };
  } finally {
    if (!instances.get(config.id)?.adapter || instances.get(config.id)?.adapter !== adapter) await adapter.dispose();
  }
}

function runForSource<T>(sourceId: string, queues: Map<string, Promise<void>>, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(sourceId) ?? Promise.resolve(); const next = prior.then(operation, operation); const tail = next.then(() => undefined, () => undefined); queues.set(sourceId, tail);
  void tail.finally(() => { if (queues.get(sourceId) === tail) queues.delete(sourceId); }); return next;
}

function failure(code: BackgroundFailure['code'], message: string): BackgroundFailure { return { ok: false, code, message }; }
function safeClone<T extends BackgroundResponse>(response: T): T { try { return structuredClone(response); } catch { return JSON.parse(JSON.stringify(response)) as T; } }
function safeErrorMessage(error: unknown, request: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  const secrets = collectSecrets(request);
  const scrubbed = secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), raw)
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
  // Adapter errors already provide deliberately safe user messages.  Unknown exceptions may be a
  // response body (or an Error containing one), so even a redacted fragment is not exposed.
  void scrubbed;
  return 'Background request failed.';
}
function collectSecrets(value: unknown, output: string[] = []): string[] {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|password|secret|authorization|api[-_ ]?key)/i.test(key) && typeof child === 'string' && child) output.push(child);
    else collectSecrets(child, output);
  }
  return output;
}

async function handleWeatherRequest(service: Pick<OpenMeteoService, 'searchCities' | 'current'>, reverseGeocode: typeof reverseGeocodeLocation, request: Extract<BackgroundRequest, { weather: string }>): Promise<BackgroundResponse> {
  try {
    if (request.weather === 'city-search') return { ok: true, cities: await service.searchCities(request.query, request.locale) };
    if (request.weather === 'reverse-geocode') return { ok: true, location: await reverseGeocode(request.latitude, request.longitude, request.locale) };
    return { ok: true, weather: await service.current({ location: request.location, latitude: request.latitude, longitude: request.longitude }) };
  } catch (error) {
    if (error instanceof WeatherServiceError) return failure(error.code, error.message);
    return failure('network', '天气服务暂不可用。');
  }
}

async function clearAuxiliaryStorage(): Promise<void> {
  const clear = async () => {
    const values = await getAllLocal();
    const keys = Object.keys(values).filter((key) => key.startsWith('pictab-background-cursor:') || key === 'pictab-first-run-dismissed-v1');
    const results = await Promise.allSettled(keys.map((key) => removeLocal(key)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('Auxiliary storage cleanup failed.');
  };
  const locks = globalThis.navigator?.locks;
  if (locks) await locks.request(AUXILIARY_STORAGE_MAINTENANCE_LOCK, { mode: 'exclusive' }, clear);
  else await clear();
}

export type RuntimeListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: BackgroundResponse) => void) => boolean;
export function installRuntimeListener(dispatcher: ReturnType<typeof createDispatcher>, addListener?: (listener: RuntimeListener) => void): void {
  const listener: RuntimeListener = (message, sender, sendResponse) => { void dispatcher(message, sender).then(sendResponse, () => sendResponse(failure('unknown', 'Background request failed.'))); return true; };
  if (addListener) addListener(listener);
  else chrome.runtime.onMessage.addListener(listener);
}
installRuntimeListener(createDispatcher());

import type { ImageEntry, SourceError } from '../sources/adapter';
import type { SourceType } from '../domain/types';
import { hasBoundedRemoteText } from '../sources/text';

const DATABASE_NAME = 'pictab-remote-catalog';
const STORE_NAME = 'catalogs';

export interface CatalogRecord {
  sourceId: string;
  sourceType: Exclude<SourceType, 'local'>;
  fingerprint: string;
  images: [ImageEntry, ...ImageEntry[]];
  totalCount: number;
  warnings?: SourceError[];
  fetchedAt: number;
}

export interface CatalogRepository {
  get(sourceId: string, fingerprint: string): Promise<CatalogRecord | undefined>;
  put(record: CatalogRecord): Promise<void>;
  /** Omit fingerprint to remove every namespace for a source. */
  delete(sourceId: string, fingerprint?: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryCatalogRepository implements CatalogRepository {
  private readonly records = new Map<string, CatalogRecord>();
  async get(sourceId: string, fingerprint: string): Promise<CatalogRecord | undefined> { const recordKey = key(sourceId, fingerprint); const value = this.records.get(recordKey); if (value && !isPersistableCatalog(value)) { this.records.delete(recordKey); return undefined; } return value ? structuredClone(value) : undefined; }
  async put(record: CatalogRecord): Promise<void> { assertPersistableCatalog(record); this.records.set(key(record.sourceId, record.fingerprint), structuredClone(record)); }
  async delete(sourceId: string, fingerprint?: string): Promise<void> { for (const [recordKey, record] of this.records) if (record.sourceId === sourceId && (fingerprint === undefined || record.fingerprint === fingerprint)) this.records.delete(recordKey); }
  async clear(): Promise<void> { this.records.clear(); }
}

export class IndexedDbCatalogRepository implements CatalogRepository {
  private readonly database = openDatabase();
  async get(sourceId: string, fingerprint: string): Promise<CatalogRecord | undefined> { const value = await this.request('readonly', (store) => store.get([sourceId, fingerprint])); if (value && !isPersistableCatalog(value)) { await this.delete(sourceId, fingerprint); return undefined; } return value; }
  async put(record: CatalogRecord): Promise<void> { assertPersistableCatalog(record); await this.request('readwrite', (store) => store.put(record)); }
  async delete(sourceId: string, fingerprint?: string): Promise<void> {
    if (fingerprint !== undefined) { await this.request('readwrite', (store) => store.delete([sourceId, fingerprint])); return; }
    await this.request('readwrite', (store) => store.delete(IDBKeyRange.bound([sourceId, ''], [sourceId, '\uffff'])));
  }
  async clear(): Promise<void> { await this.request('readwrite', (store) => store.clear()); }
  private async request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.database;
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode); let value: T; let request: IDBRequest<T>;
      try { request = operation(transaction.objectStore(STORE_NAME)); } catch (error) { reject(error); return; }
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      const fail = () => reject(transaction.error ?? request.error ?? new Error('Catalog transaction failed.'));
      transaction.onabort = fail; transaction.onerror = fail;
    });
  }
}

function key(sourceId: string, fingerprint: string): string { return JSON.stringify([sourceId, fingerprint]); }
export function isPersistableCatalog(record: CatalogRecord): boolean {
  if (record.sourceType === 'webdav' || record.sourceType === 'json-api') return false;
  return record.images.every((entry) =>
    hasBoundedRemoteText(entry.description)
    && hasBoundedRemoteText(entry.author)
    && hasBoundedRemoteText(entry.attribution)
    && urlBearingValues(entry).every(safePersistedUrl)
  );
}
function assertPersistableCatalog(record: CatalogRecord): void { if (!isPersistableCatalog(record)) throw new TypeError('Protected catalogs with credential-bearing URLs cannot be persisted.'); }
function urlBearingValues(entry: ImageEntry): string[] {
  const values = [
    'url' in entry && typeof entry.url === 'string' ? entry.url : undefined,
    entry.sourceUrl,
    entry.authorUrl
  ].filter((value): value is string => Boolean(value));
  if (entry.attribution) values.push(...entry.attribution.match(/https?:\/\/[^\s]+/gi) ?? []);
  return values;
}
function safePersistedUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: ['sourceId', 'fingerprint'] }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open catalog database.'));
  });
}

const DATABASE_NAME = 'newpictab';
const DATABASE_VERSION = 2;
const LOCAL_IMAGES_STORE = 'localImages';
const SOURCE_METADATA_STORE = 'sourceMetadata';

export interface LocalImageRecord {
  sourceId: string;
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  createdAt: number;
  position?: number;
}

export type LocalImageInput = LocalImageRecord;

interface SourceMetadataRecord {
  sourceId: string;
  pendingLocalImport?: boolean;
  pendingLocalCleanup?: PendingLocalCleanupKind;
  [key: string]: unknown;
}

export type PendingLocalCleanupKind = 'import' | 'deletion';
export interface PendingLocalCleanup { sourceId: string; kind: PendingLocalCleanupKind; }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      let images: IDBObjectStore;
      if (!database.objectStoreNames.contains(LOCAL_IMAGES_STORE)) {
        images = database.createObjectStore(LOCAL_IMAGES_STORE, { keyPath: ['sourceId', 'id'] });
        images.createIndex('bySource', 'sourceId', { unique: false });
      } else {
        images = request.transaction!.objectStore(LOCAL_IMAGES_STORE);
        if (!images.indexNames.contains('bySource')) images.createIndex('bySource', 'sourceId', { unique: false });
      }
      if (!database.objectStoreNames.contains(SOURCE_METADATA_STORE)) {
        database.createObjectStore(SOURCE_METADATA_STORE, { keyPath: 'sourceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open image database'));
  });
}

function assertLocalImage(record: LocalImageInput): void {
  if (!record || typeof record.sourceId !== 'string' || record.sourceId.trim().length === 0) throw new TypeError('A local image needs a sourceId');
  if (typeof record.id !== 'string' || record.id.trim().length === 0) throw new TypeError('A local image needs an id');
  if (!isBlob(record.blob)) throw new TypeError('A local image needs a Blob');
  if (typeof record.name !== 'string' || typeof record.type !== 'string') throw new TypeError('A local image needs name and type');
  if (!Number.isFinite(record.size) || record.size < 0 || !Number.isFinite(record.createdAt)) throw new TypeError('A local image needs valid size and createdAt');
  if (record.position !== undefined && (!Number.isSafeInteger(record.position) || record.position < 0)) throw new TypeError('A local image needs a valid position');
  if (record.type !== record.blob.type || record.size !== record.blob.size) throw new TypeError('A local image type and size must match its Blob');
}

function isBlob(value: unknown): value is Blob {
  if (value === null || typeof value !== 'object') return false;
  try {
    const slice = Blob.prototype.slice.call(value, 0, 0);
    return slice instanceof Blob;
  } catch { return false; }
}

async function withStoreTransaction<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const done = transactionDone(transaction);
    try {
      const result = await operation(transaction.objectStore(storeName));
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* completed transactions cannot abort */ }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

function withTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return withStoreTransaction(LOCAL_IMAGES_STORE, mode, operation);
}

export async function putLocal(record: LocalImageInput): Promise<void> {
  assertLocalImage(record);
  await withTransaction('readwrite', async (store) => {
    await requestResult(store.put(record));
  });
}

export async function listLocal(sourceId?: string): Promise<LocalImageRecord[]> {
  if (sourceId !== undefined && sourceId.trim().length === 0) return [];
  const records = await withTransaction('readonly', async (store) => {
    if (sourceId === undefined) return requestResult(store.getAll()) as Promise<LocalImageRecord[]>;
    return requestResult(store.index('bySource').getAll(sourceId)) as Promise<LocalImageRecord[]>;
  });
  return records.sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt || compareCodeUnits(left.id, right.id) || compareCodeUnits(left.sourceId, right.sourceId));
}

export async function reorderLocal(sourceId: string, orderedIds: readonly string[]): Promise<void> {
  if (!sourceId.trim()) return;
  await withTransaction('readwrite', async (store) => {
    const records = await requestResult(store.index('bySource').getAll(sourceId)) as LocalImageRecord[];
    const byId = new Map(records.map((record) => [record.id, record]));
    const seen = new Set<string>();
    const ordered = [...orderedIds, ...records.map((record) => record.id)].filter((id) => byId.has(id) && !seen.has(id) && seen.add(id));
    await Promise.all(ordered.map((id, position) => requestResult(store.put({ ...byId.get(id)!, position }))));
  });
}

export async function deleteLocal(sourceId: string, id: string): Promise<void> {
  if (sourceId.trim().length === 0 || id.trim().length === 0) return;
  await withTransaction('readwrite', async (store) => {
    await requestResult(store.delete([sourceId, id]));
  });
}

export async function deleteSource(sourceId: string): Promise<void> {
  if (sourceId.trim().length === 0) return;
  await withTransaction('readwrite', async (store) => {
    const index = store.index('bySource');
    await deleteCursor(index.openCursor(IDBKeyRange.only(sourceId)));
  });
}

export async function clearAllLocalData(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([LOCAL_IMAGES_STORE, SOURCE_METADATA_STORE], 'readwrite');
    const done = transactionDone(transaction);
    try {
      await Promise.all([
        requestResult(transaction.objectStore(LOCAL_IMAGES_STORE).clear()),
        requestResult(transaction.objectStore(SOURCE_METADATA_STORE).clear())
      ]);
      await done;
    } catch (error) {
      try { transaction.abort(); } catch { /* completed transactions cannot abort */ }
      await done.catch(() => undefined);
      throw error;
    }
  } finally { database.close(); }
}

export async function markPendingLocalImport(sourceId: string): Promise<void> {
  if (!sourceId.trim()) throw new TypeError('A pending local import needs a sourceId');
  await withStoreTransaction(SOURCE_METADATA_STORE, 'readwrite', async (store) => {
    const existing = await requestResult(store.get(sourceId)) as SourceMetadataRecord | undefined;
    await requestResult(store.put({ ...existing, sourceId, pendingLocalCleanup: 'import', pendingLocalImport: undefined } satisfies SourceMetadataRecord));
  });
}

export async function markPendingLocalDeletion(sourceId: string): Promise<void> {
  if (!sourceId.trim()) throw new TypeError('A pending local deletion needs a sourceId');
  await withStoreTransaction(SOURCE_METADATA_STORE, 'readwrite', async (store) => {
    const existing = await requestResult(store.get(sourceId)) as SourceMetadataRecord | undefined;
    await requestResult(store.put({ ...existing, sourceId, pendingLocalCleanup: 'deletion', pendingLocalImport: undefined } satisfies SourceMetadataRecord));
  });
}

export async function clearPendingLocalImport(sourceId: string): Promise<void> {
  if (!sourceId.trim()) return;
  await withStoreTransaction(SOURCE_METADATA_STORE, 'readwrite', async (store) => {
    const existing = await requestResult(store.get(sourceId)) as SourceMetadataRecord | undefined;
    if (!existing?.pendingLocalImport && !existing?.pendingLocalCleanup) return;
    const next = { ...existing }; delete next.pendingLocalImport; delete next.pendingLocalCleanup;
    if (Object.keys(next).some((key) => key !== 'sourceId')) await requestResult(store.put(next));
    else await requestResult(store.delete(sourceId));
  });
}

export async function listPendingLocalImports(): Promise<string[]> {
  return (await listPendingLocalCleanups()).filter((record) => record.kind === 'import').map((record) => record.sourceId);
}

export async function listPendingLocalCleanups(): Promise<PendingLocalCleanup[]> {
  const records = await withStoreTransaction(SOURCE_METADATA_STORE, 'readonly', async (store) => requestResult(store.getAll()) as Promise<SourceMetadataRecord[]>);
  return records.flatMap((record): PendingLocalCleanup[] => {
    if (typeof record.sourceId !== 'string' || !record.sourceId.trim()) return [];
    const kind = record.pendingLocalCleanup ?? (record.pendingLocalImport === true ? 'import' : undefined);
    return kind ? [{ sourceId: record.sourceId, kind }] : [];
  }).sort((left, right) => compareCodeUnits(left.sourceId, right.sourceId));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deleteCursor(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('Unable to delete local images'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const deletion = cursor.delete();
      deletion.onerror = () => reject(deletion.error ?? new Error('Unable to delete local image'));
      deletion.onsuccess = () => cursor.continue();
    };
  });
}

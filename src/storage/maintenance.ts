import { getLocal, removeLocal, setLocal } from '../lib/chrome';

export const AUXILIARY_STORAGE_MAINTENANCE_LOCK = 'pictab-auxiliary-storage';
export const DATA_MAINTENANCE_LOCK = 'pictab-all-data';
export const DATA_CLEAR_MARKER_KEY = 'pictab-clear-in-progress';
const CLEAR_MARKER_MAX_AGE_MS = 5 * 60_000;

interface ClearMarker { startedAt: number; owner: string; }

export class PicTabDataClearingError extends Error {
  constructor() { super('PicTab data is being cleared.'); this.name = 'PicTabDataClearingError'; }
}

export function withPicTabDataMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return operation();
  return locks.request(DATA_MAINTENANCE_LOCK, { mode: 'shared' }, async () => {
    if (isFreshMarker(await getLocal<unknown>(DATA_CLEAR_MARKER_KEY))) throw new PicTabDataClearingError();
    return operation();
  });
}

export async function withPicTabDataClearLock<T>(operation: () => Promise<T>): Promise<T> {
  const marker: ClearMarker = { startedAt: Date.now(), owner: createMarkerOwner() };
  await setLocal(DATA_CLEAR_MARKER_KEY, marker);
  try {
    const locks = globalThis.navigator?.locks;
    const result = locks ? await locks.request(DATA_MAINTENANCE_LOCK, { mode: 'exclusive' }, operation) : await operation();
    // Let already-queued shared callbacks observe the marker before it is removed.
    if (locks) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    const current = await getLocal<unknown>(DATA_CLEAR_MARKER_KEY);
    if (isClearMarker(current) && current.owner === marker.owner) await removeLocal(DATA_CLEAR_MARKER_KEY);
  }
}

export function withAuxiliaryStorageWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  return withPicTabDataMutationLock(() => {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(AUXILIARY_STORAGE_MAINTENANCE_LOCK, { mode: 'shared' }, operation);
    return operation();
  });
}

function isFreshMarker(value: unknown): value is ClearMarker {
  return isClearMarker(value) && Date.now() - value.startedAt < CLEAR_MARKER_MAX_AGE_MS;
}

function isClearMarker(value: unknown): value is ClearMarker {
  return !!value && typeof value === 'object'
    && typeof (value as ClearMarker).startedAt === 'number'
    && Number.isFinite((value as ClearMarker).startedAt)
    && typeof (value as ClearMarker).owner === 'string';
}

function createMarkerOwner(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

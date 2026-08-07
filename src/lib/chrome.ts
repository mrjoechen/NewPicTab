type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

const fallbackStorage = new Map<string, unknown>();

function localArea(): chrome.storage.StorageArea | undefined {
  return globalThis.chrome?.storage?.local;
}

export async function getLocal<T>(key: string): Promise<T | undefined> {
  const area = localArea();
  if (!area) return fallbackStorage.get(key) as T | undefined;
  const value = await area.get(key);
  return value?.[key] as T | undefined;
}

export async function setLocal<T>(key: string, value: T): Promise<void> {
  const area = localArea();
  if (!area) {
    fallbackStorage.set(key, value);
    return;
  }
  await area.set({ [key]: value });
}

export async function removeLocal(key: string | string[]): Promise<void> {
  const keys = Array.isArray(key) ? key : [key];
  const area = localArea();
  if (!area) {
    for (const item of keys) fallbackStorage.delete(item);
    return;
  }
  await area.remove(key);
}

export async function getAllLocal(): Promise<Record<string, unknown>> {
  const area = localArea();
  if (!area) return Object.fromEntries(fallbackStorage);
  return await area.get(null) as Record<string, unknown>;
}

export function onStorageChanged(listener: ChangeListener): () => void {
  const changes = globalThis.chrome?.storage?.onChanged;
  if (!changes) return () => undefined;
  changes.addListener(listener as Parameters<typeof changes.addListener>[0]);
  return () => changes.removeListener(listener as Parameters<typeof changes.removeListener>[0]);
}

import { migrateSettings } from '../domain/migrate';
import { createDefaultSettings } from '../domain/defaults';
import type { NewPicTabSettings } from '../domain/types';
import { getLocal, onStorageChanged, removeLocal, setLocal } from '../lib/chrome';
import { withNewPicTabDataClearLock, withNewPicTabDataMutationLock } from './maintenance';

const SETTINGS_KEY = 'newpictab';
export const SETTINGS_BACKUP_KEY = 'newpictab-settings-backup-v1';
const SETTINGS_LOCK = 'newpictab-settings-write';

let queuedWrite: Promise<void> = Promise.resolve();

function queueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = queuedWrite.then(operation, operation);
  queuedWrite = next.then(() => undefined, () => undefined);
  return next;
}

function withSettingsWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(SETTINGS_LOCK, () => operation());
  return queueWrite(operation);
}

export async function load(): Promise<NewPicTabSettings> {
  const stored = await getLocal<unknown>(SETTINGS_KEY);
  const migrated = migrateSettings(stored);
  if (stored === undefined || sameJsonValue(stored, migrated)) return migrated;
  return withNewPicTabDataMutationLock(() => withSettingsWriteLock(loadInsideSettingsLock));
}

/** Use only when the caller already owns the extension-wide data-maintenance lock. */
export async function loadInsideDataMaintenance(): Promise<NewPicTabSettings> {
  const stored = await getLocal<unknown>(SETTINGS_KEY);
  const migrated = migrateSettings(stored);
  if (stored === undefined || sameJsonValue(stored, migrated)) return migrated;
  return withSettingsWriteLock(loadInsideSettingsLock);
}

async function loadInsideSettingsLock(): Promise<NewPicTabSettings> {
  const stored = await getLocal<unknown>(SETTINGS_KEY);
  const migrated = migrateSettings(stored);
  if (stored !== undefined && !sameJsonValue(stored, migrated)) {
    await setLocal(SETTINGS_BACKUP_KEY, stored);
    await setLocal(SETTINGS_KEY, migrated);
  }
  return migrated;
}

async function persist(settings: unknown): Promise<NewPicTabSettings> {
  const migrated = migrateSettings(settings);
  await setLocal(SETTINGS_KEY, migrated);
  return migrated;
}

export async function save(settings: unknown): Promise<NewPicTabSettings> {
  return withNewPicTabDataMutationLock(() => withSettingsWriteLock(() => persist(settings)));
}

export async function update(updater: (current: NewPicTabSettings) => unknown): Promise<NewPicTabSettings> {
  return withNewPicTabDataMutationLock(() => withSettingsWriteLock(async () => persist(updater(await loadInsideSettingsLock()))));
}

export async function clear(): Promise<NewPicTabSettings> {
  return withNewPicTabDataClearLock(clearInsideDataMaintenance);
}

export async function clearInsideDataMaintenance(): Promise<NewPicTabSettings> {
  return withSettingsWriteLock(async () => {
    await removeLocal([SETTINGS_KEY, SETTINGS_BACKUP_KEY]);
    return createDefaultSettings();
  });
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try { return stableJson(left) === stableJson(right); }
  catch { return false; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function subscribe(callback: (settings: NewPicTabSettings) => void): () => void {
  return onStorageChanged((changes, areaName) => {
    if (areaName === 'local' && SETTINGS_KEY in changes) {
      callback(migrateSettings(changes[SETTINGS_KEY]?.newValue));
    }
  });
}

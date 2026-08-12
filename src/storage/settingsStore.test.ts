import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../domain/defaults';
import { SETTINGS_BACKUP_KEY, clear, load, save, subscribe, update } from './settingsStore';

type StorageChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

describe('settingsStore', () => {
  let changeListener: StorageChangeListener | undefined;
  let localData: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    localData = {};
    changeListener = undefined;
    const local = chrome.storage.local as unknown as {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    local.get = vi.fn(async (key: string) => ({ [key]: localData[key] }));
    local.set = vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(localData, value);
    });
    (local as typeof local & { remove: ReturnType<typeof vi.fn> }).remove = vi.fn(async (key: string | string[]) => { for (const item of Array.isArray(key) ? key : [key]) delete localData[item]; });
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
      addListener: vi.fn((listener: StorageChangeListener) => {
        changeListener = listener;
      }),
      removeListener: vi.fn((listener: StorageChangeListener) => {
        if (changeListener === listener) changeListener = undefined;
      }),
      hasListener: vi.fn()
    };
  });

  it('loads a complete default settings object from missing storage', async () => {
    await expect(load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('loads the active source id when it references a valid persisted source', async () => {
    localData.newpictab = {
      activeSourceId: 'local-1',
      sources: [{
        id: 'local-1', name: 'Photos', type: 'local', enabled: true,
        createdAt: 1, updatedAt: 1, includeSubdirectories: false
      }]
    };

    await expect(load()).resolves.toMatchObject({ activeSourceId: 'local-1' });
  });

  it('backs up partially invalid persisted settings before storing and returning the migrated result', async () => {
    const original = { version: 0, appearance: { transition: 'spin', transitionMs: 999_999 }, unknown: 'preserve in backup' };
    localData.newpictab = structuredClone(original);

    const result = await load();

    expect(localData[SETTINGS_BACKUP_KEY]).toEqual(original);
    expect(localData.newpictab).toEqual(result);
    expect(result).toMatchObject({ version: 1, appearance: { transition: 'fade' } });
    const writes = vi.mocked(chrome.storage.local.set).mock.calls.map(([value]) => value);
    expect(writes).toEqual([{ [SETTINGS_BACKUP_KEY]: original }, { newpictab: result }]);
  });

  it('saves migrated settings only to chrome.storage.local under newpictab', async () => {
    await save({ appearance: { transition: 'spin' } });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      newpictab: expect.objectContaining({ appearance: expect.objectContaining({ transition: 'fade' }) })
    });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('updates from the current persisted settings without losing nested fields', async () => {
    localData.newpictab = {
      appearance: { transition: 'slide', transitionMs: 700 },
      widgets: { clock: { enabled: false } }
    };

    const result = await update((current) => ({
      ...current,
      appearance: { ...current.appearance, transitionMs: 900 }
    }));

    expect(result.appearance).toMatchObject({ transition: 'slide', transitionMs: 900 });
    expect(result.widgets.clock.enabled).toBe(false);
    expect(localData.newpictab).toEqual(result);
  });

  it('serializes a public save behind an in-flight update so it cannot overwrite an old snapshot', async () => {
    const initial = { appearance: { transition: 'fade' }, widgets: { clock: { enabled: true } } };
    let resolveRead: ((value: { newpictab: typeof initial }) => void) | undefined;
    const local = chrome.storage.local as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    local.get = vi.fn((key: string) => key === 'newpictab'
      ? new Promise<{ newpictab: typeof initial }>((resolve) => { resolveRead = resolve; })
      : Promise.resolve({ [key]: localData[key] }));
    const originalLocks = navigator.locks;
    const previous = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, optionsOrCallback: LockOptions | (() => Promise<unknown>), maybeCallback?: () => Promise<unknown>) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const current = (previous.get(name) ?? Promise.resolve()).then(callback);
      previous.set(name, current.then(() => undefined, () => undefined));
      return current;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });

    try {
      const updating = update((current) => ({
        ...current,
        widgets: { ...current.widgets, clock: { ...current.widgets.clock, enabled: false } }
      }));
      await vi.waitFor(() => expect(local.get).toHaveBeenCalledWith('newpictab'));
      const saving = save({ appearance: { transition: 'slide' }, widgets: { date: { enabled: false } } });
      await Promise.resolve();
      const writesBeforeReadCompletes = local.set.mock.calls.length;

      resolveRead?.({ newpictab: initial });
      await Promise.all([updating, saving]);

      expect(writesBeforeReadCompletes).toBe(0);
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      Object.defineProperty(navigator, 'locks', { value: originalLocks, configurable: true });
    }

    expect(localData.newpictab).toEqual(expect.objectContaining({
      appearance: expect.objectContaining({ transition: 'slide' }),
      widgets: expect.objectContaining({
        clock: expect.objectContaining({ enabled: true }),
        date: expect.objectContaining({ enabled: false })
      })
    }));
  });

  it('serializes interleaved updates so each updater observes the previous write', async () => {
    localData.newpictab = { appearance: { transition: 'fade' }, widgets: { clock: { enabled: true } } };
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });

    try {
      await Promise.all([
        update((current) => ({ ...current, appearance: { ...current.appearance, transition: 'slide' } })),
        update((current) => ({ ...current, widgets: { ...current.widgets, clock: { ...current.widgets.clock, enabled: false } } }))
      ]);
    } finally {
      Object.defineProperty(navigator, 'locks', { value: originalLocks, configurable: true });
    }

    expect(localData.newpictab).toEqual(expect.objectContaining({
      appearance: expect.objectContaining({ transition: 'slide' }),
      widgets: expect.objectContaining({ clock: expect.objectContaining({ enabled: false }) })
    }));
  });

  it('uses the browser lock to serialize interleaved settings writes when available', async () => {
    const previous = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, optionsOrCallback: LockOptions | (() => Promise<unknown>), maybeCallback?: () => Promise<unknown>) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const current = (previous.get(name) ?? Promise.resolve()).then(callback);
      previous.set(name, current.then(() => undefined, () => undefined));
      return current;
    });
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    localData.newpictab = { appearance: { transition: 'fade' }, widgets: { clock: { enabled: true } } };

    try {
      await Promise.all([
        update((current) => ({ ...current, appearance: { ...current.appearance, transition: 'slide' } })),
        update((current) => ({ ...current, widgets: { ...current.widgets, clock: { ...current.widgets.clock, enabled: false } } }))
      ]);
    } finally {
      Object.defineProperty(navigator, 'locks', { value: originalLocks, configurable: true });
    }

    expect(request).toHaveBeenCalledWith('newpictab-settings-write', expect.any(Function));
    expect(localData.newpictab).toEqual(expect.objectContaining({
      appearance: expect.objectContaining({ transition: 'slide' }),
      widgets: expect.objectContaining({ clock: expect.objectContaining({ enabled: false }) })
    }));
  });

  it('keeps WebDAV, JSON API, and TMDB credentials in the local-only persisted payload', async () => {
    await save({
      sources: [{
        id: 'dav', name: 'DAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1,
        url: 'https://dav.example.test/photos', username: 'ada', password: 'webdav-secret', includeSubdirectories: true
      }, {
        id: 'api', name: 'API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1,
        endpoint: 'https://api.example.test/photos', headers: { Authorization: 'Bearer json-secret' },
        arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1
      }, {
        id: 'tmdb', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1,
        token: 'tmdb-secret', media: 'movie', feed: 'popular', discoverFilters: {}
      }]
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      newpictab: expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({ password: 'webdav-secret' }),
          expect.objectContaining({ headers: { Authorization: 'Bearer json-secret' } }),
          expect.objectContaining({ token: 'tmdb-secret' })
        ])
      })
    });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('notifies for local newpictab changes, migrates the value, and unsubscribes', () => {
    const callback = vi.fn();
    const unsubscribe = subscribe(callback);

    changeListener?.({ newpictab: { newValue: { appearance: { transition: 'spin' } } } }, 'sync');
    changeListener?.({ other: { newValue: {} } }, 'local');
    expect(callback).not.toHaveBeenCalled();

    changeListener?.({ newpictab: { newValue: { appearance: { transition: 'spin' } } } }, 'local');
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      appearance: expect.objectContaining({ transition: 'fade' })
    }));

    unsubscribe();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });

  it('clears credentials under the settings write lock and returns defaults', async () => {
    localData.newpictab = {
      sources: [{ id: 'dav', name: 'DAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example', username: 'ada', password: 'private', includeSubdirectories: false }]
    };
    localData[SETTINGS_BACKUP_KEY] = { password: 'old-private' };

    await expect(clear()).resolves.toEqual(DEFAULT_SETTINGS);

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(['newpictab', SETTINGS_BACKUP_KEY]);
    expect(localData).not.toHaveProperty('newpictab'); expect(localData).not.toHaveProperty(SETTINGS_BACKUP_KEY);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import type { DirectSourceConfig, LocalSourceConfig } from '../domain/types';
import { createDefaultSettings } from '../domain/defaults';
import { LocalSourceAdapter } from '../sources/local';
import { listLocal, listPendingLocalImports, markPendingLocalImport, putLocal } from '../storage/imageDb';
import { createSourceOperations, listSource, RemoteCacheSession, sendBackgroundRequest } from './sourceClient';
import { clearAllPicTabData } from './dataClear';

const direct: DirectSourceConfig = { id: 'remote', name: 'Remote', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };
const local: LocalSourceConfig = { id: 'local', name: 'Local', type: 'local', enabled: true, createdAt: 1, updatedAt: 1, includeSubdirectories: false };

const localStorageGet = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;

function installExclusiveLockManager(): () => void {
  const original = navigator.locks;
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, optionsOrCallback: LockOptions | ((lock: Lock | null) => unknown), maybeCallback?: (lock: Lock | null) => unknown) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const current = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' } as Lock));
    tails.set(name, current.then(() => undefined, () => undefined));
    return current;
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  return () => Object.defineProperty(navigator, 'locks', { configurable: true, value: original });
}

beforeEach(() => {
  vi.mocked(chrome.runtime.sendMessage).mockReset();
  localStorageGet.mockReset();
  localStorageGet.mockResolvedValue({});
});

describe('new-tab source client', () => {
  it('bridges Chrome callback messages without exposing worker details to the UI', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
      const callback = args.find((item): item is (value: unknown) => void => typeof item === 'function');
      callback?.({ ok: true, images: [{ id: 'one', sourceId: direct.id, url: direct.entries[0].url }] });
    }) as typeof chrome.runtime.sendMessage);

    await expect(sendBackgroundRequest({ source: 'list', config: direct })).resolves.toMatchObject({ ok: true });
    await expect(listSource(direct, {} as never)).resolves.toMatchObject({ ok: true, images: [{ id: 'one' }] });
  });

  it('returns a safe network failure when the runtime callback never fires', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(chrome.runtime.sendMessage).mockImplementation((() => undefined) as unknown as typeof chrome.runtime.sendMessage);
      let result: unknown = 'pending';
      void sendBackgroundRequest({ source: 'list', config: direct }).then((value) => { result = value; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(25_000);

      expect(result).toEqual({ ok: false, code: 'network', message: '图片源后台服务暂不可用。' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps local import and deletion in the long-lived local adapter', async () => {
    const adapter = {
      testConnection: vi.fn(async () => ({ ok: true as const })),
      listImages: vi.fn(),
      importFiles: vi.fn(async () => ({ imported: 1, failures: [] })),
      deleteSource: vi.fn(async () => undefined)
    };
    const operations = createSourceOperations(adapter as never);
    const file = new File(['x'], 'one.jpg', { type: 'image/jpeg' });

    await expect(operations.importLocal(local.id, [file])).resolves.toMatchObject({ imported: 1 });
    await operations.delete(local);
    expect(adapter.importFiles).toHaveBeenCalledWith(local.id, [file]);
    expect(adapter.deleteSource).toHaveBeenCalledWith(local.id);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reconciles a committed pending import against durable settings without deleting its blob', async () => {
    const committed = { ...local, id: 'committed-journal' };
    const blob = new Blob(['committed'], { type: 'image/png' });
    await putLocal({ sourceId: committed.id, id: 'one', name: 'one.png', type: blob.type, size: blob.size, blob, createdAt: 1 });
    await markPendingLocalImport(committed.id);
    localStorageGet.mockResolvedValue({ pictab: { sources: [committed], activeSourceId: committed.id } });

    const operations = createSourceOperations(new LocalSourceAdapter());
    await operations.recoverLocalImports?.();

    expect(await listLocal(committed.id)).toHaveLength(1);
    expect(await listPendingLocalImports()).not.toContain(committed.id);
  });

  it('persists a committed deletion failure and removes the orphan on restart', async () => {
    const removed = { ...local, id: 'pending-deletion' };
    const blob = new Blob(['removed'], { type: 'image/png' });
    await putLocal({ sourceId: removed.id, id: 'one', name: 'one.png', type: blob.type, size: blob.size, blob, createdAt: 1 });
    localStorageGet.mockResolvedValue({ pictab: { sources: [], activeSourceId: null } });
    const failing = new LocalSourceAdapter({}, { listLocal, putLocal, deleteSource: vi.fn(async () => { throw new Error('private delete failure'); }) });
    const firstOperations = createSourceOperations(failing);

    await expect(firstOperations.deleteCommittedLocal?.(removed, async () => undefined)).resolves.toBeUndefined();
    expect(await listLocal(removed.id)).toHaveLength(1);

    const restarted = createSourceOperations(new LocalSourceAdapter());
    await restarted.recoverLocalImports?.();
    expect(await listLocal(removed.id)).toEqual([]);
  });

  it('holds the extension-wide lock from pending import through commit so another tab cannot recover it', async () => {
    const restoreLocks = installExclusiveLockManager();
    const pending = { ...local, id: 'cross-tab-commit' };
    let durableSources: LocalSourceConfig[] = [];
    localStorageGet.mockImplementation(async () => ({ pictab: { sources: durableSources, activeSourceId: durableSources[0]?.id ?? null } }));
    try {
      const tabA = createSourceOperations(new LocalSourceAdapter());
      await tabA.importLocal(pending.id, [new File(['valid'], 'valid.jpg', { type: 'image/jpeg' })], { uncommitted: true });
      const tabB = createSourceOperations(new LocalSourceAdapter());
      let recovered = false;
      const recovery = tabB.recoverLocalImports!().then(() => { recovered = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(recovered).toBe(false);
      expect(await listLocal(pending.id)).toHaveLength(1);

      durableSources = [pending];
      await tabA.completeLocalImport!(pending.id);
      await recovery;
      expect(await listLocal(pending.id)).toHaveLength(1);
    } finally { restoreLocks(); }
  });

  it('lets global clear finish while an imported source is waiting for its settings commit', async () => {
    const restoreLocks = installExclusiveLockManager();
    const pending = { ...local, id: 'clear-during-commit' };
    const values: Record<string, unknown> = {};
    localStorageGet.mockImplementation(async (key) => ({ [key as string]: values[key as string] }));
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => { Object.assign(values, items); });
    vi.mocked(chrome.storage.local.remove).mockImplementation(async (key) => { for (const name of Array.isArray(key) ? key : [key]) delete values[name]; });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((_message: unknown, callback: (response: unknown) => void) => callback({ ok: true })) as typeof chrome.runtime.sendMessage);
    const operations = createSourceOperations(new LocalSourceAdapter());
    try {
      await operations.importLocal(pending.id, [new File(['pending'], 'pending.jpg', { type: 'image/jpeg' })], { uncommitted: true });
      let completed = false;
      const clearing = clearAllPicTabData().then((result) => { completed = true; return result; });
      let clearedBeforeLeaseRelease = false;
      try {
        await vi.waitFor(() => expect(completed).toBe(true), { timeout: 300 });
        clearedBeforeLeaseRelease = true;
      } finally {
        await operations.completeLocalImport?.(pending.id);
      }
      await expect(clearing).resolves.toMatchObject({ ok: true });
      expect(clearedBeforeLeaseRelease).toBe(true);
      expect(await listLocal(pending.id)).toEqual([]);
    } finally { operations.abandonLocalImports?.(); restoreLocks(); }
  });

  it('keeps a deferred new-tab cache touch ahead of global clear so metadata cannot be restored afterward', async () => {
    const restoreLocks = installExclusiveLockManager();
    const storage: Record<string, unknown> = {};
    localStorageGet.mockImplementation(async (key) => ({ [key as string]: storage[key as string] }));
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => { Object.assign(storage, items); });
    vi.mocked(chrome.storage.local.remove).mockImplementation(async (key) => { for (const name of Array.isArray(key) ? key : [key]) delete storage[name]; });
    let releaseGet!: () => void; let enterGet!: () => void;
    const getHold = new Promise<void>((resolve) => { releaseGet = resolve; });
    const getEntered = new Promise<void>((resolve) => { enterGet = resolve; });
    const metadata: { sourceId: string }[] = [{ sourceId: 'old' }];
    const cache = { get: vi.fn(async () => { enterGet(); await getHold; metadata.push({ sourceId: 'remote' }); return new Response(new Blob(['image'], { type: 'image/jpeg' })); }) };
    const session = new RemoteCacheSession(cache);
    try {
      const materializing = session.materialize([{ id: 'one', sourceId: 'remote', remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }]);
      await getEntered;
      let clearCompleted = false;
      const clearing = clearAllPicTabData({
        clearSettings: async () => createDefaultSettings(),
        clearLocal: async () => undefined,
        clearWorker: async () => { metadata.splice(0); return { ok: true }; }
      }).then((result) => { clearCompleted = true; return result; });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const clearCompletedBeforeTouch = clearCompleted;
      releaseGet();
      const lease = await materializing; lease.release();
      await expect(clearing).resolves.toMatchObject({ ok: true });

      expect(clearCompletedBeforeTouch).toBe(false);
      expect(metadata).toEqual([]);
    } finally { releaseGet(); restoreLocks(); }
  });

  it('lets a waiting tab recover an orphan only after the importing tab crashes and releases its lease', async () => {
    const restoreLocks = installExclusiveLockManager();
    const pending = { ...local, id: 'cross-tab-crash' };
    localStorageGet.mockResolvedValue({ pictab: { sources: [], activeSourceId: null } });
    try {
      const tabA = createSourceOperations(new LocalSourceAdapter());
      await tabA.importLocal(pending.id, [new File(['orphan'], 'orphan.jpg', { type: 'image/jpeg' })], { uncommitted: true });
      const tabB = createSourceOperations(new LocalSourceAdapter());
      let recovered = false;
      const recovery = tabB.recoverLocalImports!().then(() => { recovered = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(recovered).toBe(false); expect(await listLocal(pending.id)).toHaveLength(1);

      tabA.abandonLocalImports?.();
      await recovery;
      expect(await listLocal(pending.id)).toEqual([]);
    } finally { restoreLocks(); }
  });

  it('serializes committed deletion and existing import across operations instances', async () => {
    const restoreLocks = installExclusiveLockManager();
    const deleting = { ...local, id: 'cross-tab-delete' };
    const importing = { ...local, id: 'cross-tab-existing-import' };
    localStorageGet.mockResolvedValue({ pictab: { sources: [deleting, importing], activeSourceId: deleting.id } });
    let finishSettings!: () => void;
    const settingsPending = new Promise<void>((resolve) => { finishSettings = resolve; });
    try {
      const tabA = createSourceOperations(new LocalSourceAdapter());
      const tabB = createSourceOperations(new LocalSourceAdapter());
      const deletion = tabA.deleteCommittedLocal!(deleting, () => settingsPending);
      let imported = false;
      const importPromise = tabB.importLocal(importing.id, [new File(['existing'], 'existing.jpg', { type: 'image/jpeg' })]).then(() => { imported = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(imported).toBe(false);
      finishSettings(); await deletion; await importPromise;
      expect(imported).toBe(true);
    } finally { restoreLocks(); }
  });

  it('makes explicit remote refresh invalidate metadata and successfully relist its first window', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
      const message = args.find((item): item is { source: string } => typeof item === 'object' && item !== null && 'source' in item);
      const callback = args.find((item): item is (value: unknown) => void => typeof item === 'function');
      callback?.(message?.source === 'refresh' ? { ok: true } : { ok: true, images: [{ id: 'one', sourceId: direct.id, url: direct.entries[0]!.url }], totalCount: 1 });
    }) as typeof chrome.runtime.sendMessage);
    const operations = createSourceOperations({} as never);
    await expect(operations.refresh?.(direct)).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(1, { source: 'refresh', config: direct }, expect.any(Function));
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(2, { source: 'list', config: direct, offset: 0, limit: 12, forceRefresh: true }, expect.any(Function));
  });

  it('waits for forced first-window results for both active and non-active sources', async () => {
    const active = { ...direct, id: 'active' };
    const nonActive = { ...direct, id: 'non-active' };
    const pending = new Map<string, (value: unknown) => void>();
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
      const message = args.find((item): item is { source: string; config: DirectSourceConfig; forceRefresh?: boolean } => typeof item === 'object' && item !== null && 'source' in item);
      const callback = args.find((item): item is (value: unknown) => void => typeof item === 'function');
      if (message?.source === 'refresh') callback?.({ ok: true });
      else if (message?.source === 'list' && callback) pending.set(message.config.id, callback);
    }) as typeof chrome.runtime.sendMessage);
    const operations = createSourceOperations({} as never);
    let activeDone = false; let nonActiveDone = false;
    const activeRefresh = operations.refresh!(active).then(() => { activeDone = true; });
    const nonActiveRefresh = operations.refresh!(nonActive).then(() => { nonActiveDone = true; });
    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(['active', 'non-active']));
    expect(activeDone).toBe(false); expect(nonActiveDone).toBe(false);
    const window = (sourceId: string) => ({ ok: true, images: [{ id: 'one', sourceId, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });

    pending.get('non-active')!(window('non-active'));
    await nonActiveRefresh;
    expect(nonActiveDone).toBe(true); expect(activeDone).toBe(false);
    pending.get('active')!(window('active'));
    await activeRefresh;
    expect(activeDone).toBe(true);
    const listMessages = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]) => message).filter((message: any) => message.source === 'list');
    expect(listMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ config: expect.objectContaining({ id: 'active' }), forceRefresh: true, offset: 0, limit: 12 }),
      expect.objectContaining({ config: expect.objectContaining({ id: 'non-active' }), forceRefresh: true, offset: 0, limit: 12 })
    ]));
  });

  it('materializes transformed thumbnail blobs for preview sessions', async () => {
    const original = new Blob(['full-resolution-image'], { type: 'image/jpeg' });
    const thumbnail = new Blob(['thumbnail'], { type: 'image/webp' });
    const cache = { get: vi.fn(async () => new Response(original)) };
    const urls = { createObjectURL: vi.fn(() => 'blob:thumbnail'), revokeObjectURL: vi.fn() };
    const transform = vi.fn(async (_blob: Blob) => thumbnail);
    const session = new RemoteCacheSession(cache, urls, 36, transform);

    const lease = await session.materialize([{ id: 'one', sourceId: 'remote', remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }]);

    expect(transform).toHaveBeenCalledOnce();
    expect(transform.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(urls.createObjectURL).toHaveBeenCalledWith(thumbnail);
    expect(lease.entries).toEqual([{ id: 'one', sourceId: 'remote', url: 'blob:thumbnail' }]);
  });

  it('owns multiple committed leases until each is explicitly released or the session is disposed', async () => {
    const cache = { get: vi.fn(async () => new Response(new Blob(['image'], { type: 'image/jpeg' }))) };
    const urls = { createObjectURL: vi.fn(() => `blob:cached-${urls.createObjectURL.mock.calls.length}`), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(cache, urls);

    const first = await session.materialize([{ id: 'one', sourceId: 'remote', remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint-one' }]);
    expect(first.entries).toEqual([{ id: 'one', sourceId: 'remote', url: 'blob:cached-1' }]);
    expect(session.commit(first)).toBe(true);
    expect(cache.get).toHaveBeenCalledWith('remote', 'one', 'fingerprint-one');
    const second = await session.materialize([{ id: 'two', sourceId: 'remote', remoteCacheEntryId: 'two', remoteCacheFingerprint: 'fingerprint-two' }]);
    expect(session.commit(second)).toBe(true);
    expect(urls.revokeObjectURL).not.toHaveBeenCalled();

    expect(session.release(first)).toBe(true);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:cached-1');
    expect(urls.revokeObjectURL).not.toHaveBeenCalledWith('blob:cached-2');
    session.dispose();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:cached-2');
  });

  it('rejects ownership that would exceed the materialized blob limit', async () => {
    const cache = { get: vi.fn(async () => new Response(new Blob(['image']))) };
    const urls = { createObjectURL: vi.fn(() => `blob:${urls.createObjectURL.mock.calls.length}`), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(cache, urls, 2);
    const first = await session.materialize([
      { id: 'one', sourceId: 'remote', remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' },
      { id: 'two', sourceId: 'remote', remoteCacheEntryId: 'two', remoteCacheFingerprint: 'fingerprint' }
    ]);
    const overflow = await session.materialize([{ id: 'three', sourceId: 'remote', remoteCacheEntryId: 'three', remoteCacheFingerprint: 'fingerprint' }]);

    expect(session.commit(first)).toBe(true);
    expect(session.commit(overflow)).toBe(false);
    expect(overflow.released).toBe(true);
    expect(first.released).toBe(false);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(2);

    expect(session.release(first)).toBe(true);
    const recovered = await session.materialize([{ id: 'three', sourceId: 'remote', remoteCacheEntryId: 'three', remoteCacheFingerprint: 'fingerprint' }]);
    expect(session.commit(recovered)).toBe(true);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(3);
  });

  it('hard-caps public session URL allocation at 36 even when constructed with a larger limit', async () => {
    const cache = { get: vi.fn(async () => new Response(new Blob(['image']))) };
    const urls = { createObjectURL: vi.fn(() => `blob:${urls.createObjectURL.mock.calls.length}`), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(cache, urls, 999);
    const lease = await session.materialize(Array.from({ length: 37 }, (_, index) => ({
      id: String(index), sourceId: 'remote', remoteCacheEntryId: String(index), remoteCacheFingerprint: 'fingerprint'
    })));

    expect(lease.entries).toHaveLength(36);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(36);
  });

  it('does not own zero-blob public leases across repeated refreshes', async () => {
    const urls = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(undefined, urls);
    const leases = await Promise.all(Array.from({ length: 100 }, (_, index) => session.materialize([
      { id: String(index), sourceId: 'remote', url: `https://images.example/${index}.jpg` }
    ])));

    for (const lease of leases) expect(session.commit(lease)).toBe(true);
    for (const lease of leases) expect(session.release(lease)).toBe(false);
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects and revokes a delayed materialization committed after disposal', async () => {
    let resolve!: (response: Response) => void;
    const cache = { get: vi.fn(() => new Promise<Response>((done) => { resolve = done; })) };
    const urls = { createObjectURL: vi.fn(() => 'blob:late'), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(cache, urls);
    const materializing = session.materialize([{ id: 'late', sourceId: 'remote', remoteCacheEntryId: 'late', remoteCacheFingerprint: 'fingerprint' }]);
    await vi.waitFor(() => expect(cache.get).toHaveBeenCalled());

    session.dispose();
    resolve(new Response(new Blob(['late'])));
    const lease = await materializing;

    expect(session.commit(lease)).toBe(false);
    expect(lease.released).toBe(true);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:late');
  });

  it('lets a stale materialization release only its own URL without breaking the active lease', async () => {
    let resolveStale!: (response: Response) => void;
    const cache = { get: vi.fn(async (_sourceId: string, entryId: string) => entryId === 'stale' ? new Promise<Response>((resolve) => { resolveStale = resolve; }) : new Response(new Blob([entryId]))) };
    const urls = { createObjectURL: vi.fn(() => `blob:${urls.createObjectURL.mock.calls.length}`), revokeObjectURL: vi.fn() };
    const session = new RemoteCacheSession(cache, urls);
    const stalePending = session.materialize([{ id: 'stale', sourceId: 'remote', remoteCacheEntryId: 'stale', remoteCacheFingerprint: 'fingerprint' }]);
    const current = await session.materialize([{ id: 'current', sourceId: 'remote', remoteCacheEntryId: 'current', remoteCacheFingerprint: 'fingerprint' }]);
    session.commit(current);
    resolveStale(new Response(new Blob(['stale'])));
    const stale = await stalePending;
    stale.release();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith(stale.entries[0] && 'url' in stale.entries[0] ? stale.entries[0].url : '');
    expect(urls.revokeObjectURL).not.toHaveBeenCalledWith(current.entries[0] && 'url' in current.entries[0] ? current.entries[0].url : '');
  });
});

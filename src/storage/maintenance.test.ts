import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_CLEAR_MARKER_KEY, DATA_MAINTENANCE_LOCK, PicTabDataClearingError, withPicTabDataClearLock, withPicTabDataMutationLock } from './maintenance';

const originalLocks = navigator.locks;

afterEach(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks }));

describe('extension-wide data maintenance', () => {
  let values: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    values = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => ({ [key as string]: values[key as string] }));
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => { Object.assign(values, items); });
    vi.mocked(chrome.storage.local.remove).mockImplementation(async (key) => { for (const name of Array.isArray(key) ? key : [key]) delete values[name]; });
  });

  it('keeps a marker around an exclusive clear so a cross-tab write queued behind it cannot repopulate data', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((name: string, options: LockOptions, callback: () => Promise<unknown>) => {
      const current = tail.then(() => callback());
      tail = current.then(() => undefined, () => undefined);
      return current;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    let releaseClear!: () => void;
    const holdClear = new Promise<void>((resolve) => { releaseClear = resolve; });
    let enteredClear!: () => void;
    const clearEntered = new Promise<void>((resolve) => { enteredClear = resolve; });

    const clearing = withPicTabDataClearLock(async () => { enteredClear(); await holdClear; });
    await clearEntered;
    const mutation = vi.fn(async () => undefined);
    const queuedWrite = withPicTabDataMutationLock(mutation);
    releaseClear();

    await expect(queuedWrite).rejects.toBeInstanceOf(PicTabDataClearingError);
    await clearing;
    expect(mutation).not.toHaveBeenCalled();
    expect(values).not.toHaveProperty(DATA_CLEAR_MARKER_KEY);
    expect(request).toHaveBeenCalledWith(DATA_MAINTENANCE_LOCK, { mode: 'exclusive' }, expect.any(Function));
    expect(request).toHaveBeenCalledWith(DATA_MAINTENANCE_LOCK, { mode: 'shared' }, expect.any(Function));
  });

  it('always removes the marker when clear work fails', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(withPicTabDataClearLock(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(values).not.toHaveProperty(DATA_CLEAR_MARKER_KEY);
  });

  it('does not let an earlier overlapping clear remove the marker owned by a later clear', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, _options: LockOptions, callback: () => Promise<unknown>) => {
      const current = tail.then(() => callback());
      tail = current.then(() => undefined, () => undefined);
      return current;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    let releaseFirst!: () => void; let releaseSecond!: () => void; let enterSecond!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve; });

    const first = withPicTabDataClearLock(() => firstHold);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const second = withPicTabDataClearLock(async () => { enterSecond(); await secondHold; });
    releaseFirst();
    await secondEntered;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(values).toHaveProperty(DATA_CLEAR_MARKER_KEY);

    const mutation = vi.fn(async () => undefined);
    const queuedWrite = withPicTabDataMutationLock(mutation);
    releaseSecond();
    await expect(queuedWrite).rejects.toBeInstanceOf(PicTabDataClearingError);
    await Promise.all([first, second]);
    expect(mutation).not.toHaveBeenCalled();
  });
});

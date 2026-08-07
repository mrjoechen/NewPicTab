import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChromeRotationCursorStore } from './backgroundCursor';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.clearAllMocks());

describe('Chrome rotation cursor store', () => {
  it('atomically advances a source-generation claim in local extension storage', async () => {
    const values: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
      const name = key as string;
      return { [name]: values[name] };
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      Object.assign(values, items);
    });
    const store = createChromeRotationCursorStore();

    await expect(store.claim('source-a:generation-1', ['one', 'two', 'three'])).resolves.toBe('one');
    await expect(store.claim('source-a:generation-1', ['one', 'two', 'three'])).resolves.toBe('two');
    await expect(store.claim('source-a:generation-2', ['one', 'two', 'three'])).resolves.toBe('one');
  });

  it('serializes competing claims without holding the lock for consumer work', async () => {
    const values: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
      const name = key as string;
      return { [name]: values[name] };
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      await Promise.resolve();
      Object.assign(values, items);
    });
    const store = createChromeRotationCursorStore();

    const [first, second] = await Promise.all([
      store.claim('same-scope', ['one', 'two', 'three']),
      store.claim('same-scope', ['one', 'two', 'three'])
    ]);

    expect(new Set([first, second])).toEqual(new Set(['one', 'two']));
  });

  it('returns null without touching storage when there are no candidates', async () => {
    const store = createChromeRotationCursorStore();

    await expect(store.claim('scope', [])).resolves.toBeNull();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('updates the latest successful local image under the same short lock', async () => {
    const values: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
      const name = key as string;
      return { [name]: values[name] };
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      Object.assign(values, items);
    });
    const store = createChromeRotationCursorStore();

    await store.updateLatest('scope', 'two');

    await expect(store.claim('scope', ['one', 'two', 'three'])).resolves.toBe('three');
  });

  it('holds the shared cursor-maintenance lock while mutating cursor storage', async () => {
    const original = navigator.locks;
    const request = vi.fn(async (_name: string, optionsOrCallback: LockOptions | (() => Promise<unknown>), maybeCallback?: () => Promise<unknown>) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      return callback();
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
      vi.mocked(chrome.storage.local.set).mockResolvedValue();
      await createChromeRotationCursorStore().claim('scope', ['one']);
      expect(request).toHaveBeenCalledWith('pictab-auxiliary-storage', { mode: 'shared' }, expect.any(Function));
    } finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: original }); }
  });
});

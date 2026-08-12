import { describe, expect, it, vi } from 'vitest';

import { clearAllNewPicTabData } from './dataClear';

describe('clearAllNewPicTabData', () => {
  it('attempts settings, local images, and fresh-worker data independently and aggregates only safe backend names', async () => {
    const clearSettings = vi.fn(async () => { throw new Error('password=private-settings-secret'); });
    const clearLocal = vi.fn(async () => undefined);
    const clearWorker = vi.fn(async () => ({ ok: false as const, code: 'unknown' as const, message: 'private worker detail', failures: ['weather cache'] }));

    const result = await clearAllNewPicTabData({ clearSettings, clearLocal, clearWorker });

    expect(clearSettings).toHaveBeenCalledOnce();
    expect(clearLocal).toHaveBeenCalledOnce();
    expect(clearWorker).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false, failures: ['settings and credentials', 'weather cache'] });
    expect(JSON.stringify(result)).not.toMatch(/private-settings-secret|private worker detail/);
  });

  it('returns defaults when every backend is durably cleared', async () => {
    const settings = { version: 1, activeSourceId: null, sources: [] } as never;
    await expect(clearAllNewPicTabData({
      clearSettings: vi.fn(async () => settings),
      clearLocal: vi.fn(async () => undefined),
      clearWorker: vi.fn(async () => ({ ok: true as const }))
    })).resolves.toEqual({ ok: true, settings });
  });

  it('does not trust failure labels returned by the worker', async () => {
    const result = await clearAllNewPicTabData({
      clearSettings: vi.fn(async () => ({ version: 1 } as never)),
      clearLocal: vi.fn(async () => undefined),
      clearWorker: vi.fn(async () => ({ ok: false as const, code: 'unknown' as const, message: 'hidden', failures: ['token=worker-secret'] }))
    });

    expect(result).toEqual({ ok: false, failures: ['remote cache, catalog, weather, and cursors'] });
    expect(JSON.stringify(result)).not.toContain('worker-secret');
  });

  it('holds the exclusive extension-wide data lock until every backend settles', async () => {
    const original = navigator.locks;
    let releaseLocal!: () => void;
    const localPending = new Promise<void>((resolve) => { releaseLocal = resolve; });
    const request = vi.fn(async (_name: string, options: LockOptions, callback: () => Promise<unknown>) => callback());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const clearing = clearAllNewPicTabData({
        clearSettings: vi.fn(async () => ({ version: 1 } as never)),
        clearLocal: vi.fn(() => localPending),
        clearWorker: vi.fn(async () => ({ ok: true as const }))
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('newpictab-all-data', { mode: 'exclusive' }, expect.any(Function)));
      expect(request.mock.results[0]?.value).toBeInstanceOf(Promise);
      releaseLocal();
      await clearing;
    } finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: original }); }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { hasOriginPermission, requestOriginPermission, requestOriginPermissions, runWithOriginPermission, runWithOriginPermissions } from './permissions';

const callbackRequest = (granted: boolean) => vi.fn((_permissions: chrome.permissions.Permissions, callback: (value: boolean) => void) => { callback(granted); });
const callbackContains = (contains: boolean) => vi.fn((_permissions: chrome.permissions.Permissions, callback: (value: boolean) => void) => { callback(contains); });

describe('requestOriginPermission', () => {
  it('requests exactly the configured HTTPS origin, preserving its port', async () => {
    const request = callbackRequest(true);
    Object.assign(chrome.permissions, { request });
    await expect(requestOriginPermission('https://dav.example.test:8443/photos/a')).resolves.toEqual({ ok: true, origin: 'https://dav.example.test:8443/*' });
    expect(request).toHaveBeenCalledWith({ origins: ['https://dav.example.test:8443/*'] }, expect.any(Function));
  });

  it.each(['http://dav.example.test/photos', 'https://ada:secret@dav.example.test/photos', 'not a URL'])('rejects unsafe input without requesting a permission: %s', async (input) => {
    const request = vi.fn();
    Object.assign(chrome.permissions, { request });
    await expect(requestOriginPermission(input)).resolves.toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns a typed denial for a denied request, lastError, or a rejected API call', async () => {
    const request = callbackRequest(false);
    Object.assign(chrome.permissions, { request, contains: callbackContains(false) });
    await expect(requestOriginPermission('https://dav.example.test/photos')).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } });

    request.mockImplementationOnce((_permissions, callback) => callback(true));
    Object.assign(chrome.runtime, { lastError: { message: 'Nope' } });
    await expect(requestOriginPermission('https://dav.example.test/photos')).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    Object.assign(chrome.runtime, { lastError: undefined });

    request.mockImplementationOnce(() => { throw new Error('Nope'); });
    await expect(requestOriginPermission('https://dav.example.test/photos')).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  });

  it('runs an operation only after the exact origin permission is granted', async () => {
    const request = callbackRequest(false);
    const operation = vi.fn().mockResolvedValue('listed');
    Object.assign(chrome.permissions, { request, contains: callbackContains(false) });
    await expect(runWithOriginPermission('https://dav.example.test/photos', operation)).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(operation).not.toHaveBeenCalled();

    request.mockImplementationOnce((_permissions, callback) => callback(true));
    await expect(runWithOriginPermission('https://dav.example.test/photos', operation)).resolves.toEqual({ ok: true, value: 'listed' });
    expect(operation).toHaveBeenCalledOnce();

    request.mockImplementationOnce(() => { throw new Error('rejected'); });
    await expect(runWithOriginPermission('https://dav.example.test/photos', operation)).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('runWithOriginPermissions', () => {
  it('deduplicates exact HTTPS origins into one synchronous permissions request', async () => {
    const request = callbackRequest(true);
    const operation = vi.fn(async () => 'ok');
    Object.assign(chrome.permissions, { request });

    await expect(runWithOriginPermissions(['https://one.example/a.jpg', 'https://two.example/b.jpg', 'https://one.example/c.jpg'], operation)).resolves.toEqual({ ok: true, value: 'ok' });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ origins: ['https://one.example/*', 'https://two.example/*'] }, expect.any(Function));
  });

  it('supports callback-only request and contains APIs that return undefined', async () => {
    const request = callbackRequest(true);
    const contains = vi.fn((_permissions: chrome.permissions.Permissions, callback: (value: boolean) => void) => { callback(true); });
    Object.assign(chrome.permissions, { request, contains });

    await expect(requestOriginPermission('https://old-chrome.example/path')).resolves.toMatchObject({ ok: true });
    await expect(hasOriginPermission('https://old-chrome.example/path')).resolves.toBe(true);
    expect(request.mock.results[0]?.value).toBeUndefined();
    expect(contains.mock.results[0]?.value).toBeUndefined();
  });

  it('accepts origins that are already covered by required host permissions when optional request is rejected', async () => {
    const contains = vi.fn((_permissions: chrome.permissions.Permissions, callback: (value: boolean) => void) => { callback(true); });
    const request = vi.fn(() => { throw new Error('required permissions cannot be requested again'); });
    Object.assign(chrome.permissions, { contains, request });

    await expect(requestOriginPermissions(['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'])).resolves.toEqual({
      ok: true,
      origins: ['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*']
    });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'] }, expect.any(Function));
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'] }, expect.any(Function));
  });

  it('accepts required host permissions when Chrome reports an optional request as not granted', async () => {
    const request = callbackRequest(false);
    const contains = callbackContains(true);
    Object.assign(chrome.permissions, { request, contains });

    await expect(requestOriginPermissions(['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'])).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'] }, expect.any(Function));
  });

  it('times out a missing human permission callback quickly enough to keep connection tests retryable', async () => {
    vi.useFakeTimers();
    try {
      Object.assign(chrome.permissions, { request: vi.fn(), contains: callbackContains(false) });
      let requestResult: unknown = 'pending';
      void requestOriginPermission('https://stalled.example/path').then((value) => { requestResult = value; });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(requestResult).toBe('pending');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(requestResult).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds permission lookup quickly and ignores a callback that arrives after timeout', async () => {
    vi.useFakeTimers();
    try {
      let callback!: (value: boolean) => void;
      Object.assign(chrome.permissions, { contains: vi.fn((_permissions: chrome.permissions.Permissions, complete: (value: boolean) => void) => { callback = complete; }) });
      let containsResult: unknown = 'pending';
      void hasOriginPermission('https://stalled.example/path').then((value) => { containsResult = value; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(containsResult).toBe(false);
      callback(true);
      await Promise.resolve();

      expect(containsResult).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

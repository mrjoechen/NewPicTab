import 'fake-indexeddb/auto';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../domain/defaults';
import { RemoteCache } from '../storage/remoteCache';
import App from './App';
import { chromeRotationCursorStore } from './backgroundCursor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  const local = chrome.storage.local as unknown as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  local.get = vi.fn(async () => ({}));
  local.set = vi.fn(async () => undefined);
  vi.mocked(chrome.runtime.sendMessage).mockReset();
  (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
    addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn()
  };
});

describe('App', () => {
  it('never includes source credentials or private URLs in rotation cursor storage', async () => {
    const source = { id: 'dav-safe-scope', name: 'Private DAV', type: 'webdav' as const, enabled: true, createdAt: 1, updatedAt: 42, url: 'https://dav.example/private-album', username: 'ada', password: 'super-secret-password', includeSubdirectories: true };
    const settings = { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => key === 'newpictab' ? { newpictab: settings } : { [key as string]: undefined });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((_message: unknown, callback: (value: unknown) => void) => callback({ ok: true, images: [{ id: 'one', sourceId: source.id, url: 'blob:cached-image' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false })) as typeof chrome.runtime.sendMessage);
    const claim = vi.spyOn(chromeRotationCursorStore, 'claim');
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); }
    vi.stubGlobal('Image', DecodedImage);

    render(<App />);

    await waitFor(() => expect(claim.mock.calls.some(([scope]) => scope.includes(source.id))).toBe(true));
    const cursorWrites = vi.mocked(chrome.storage.local.set).mock.calls.flatMap(([items]) => Object.entries(items).filter(([key]) => key.startsWith('newpictab-background-cursor:')));
    expect(cursorWrites.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(cursorWrites);
    expect(serialized).not.toContain(source.password);
    expect(serialized).not.toContain(source.username);
    expect(serialized).not.toContain(source.url);
    expect(serialized).toContain(source.id);
  });

  it('renders configured search and shortcuts independently on the resting page', async () => {
    const settings = createDefaultSettings();
    settings.widgets.search = { enabled: true, engine: 'duckduckgo' };
    settings.widgets.shortcuts.enabled = true;
    settings.shortcuts = [{ id: 'docs', title: 'Docs', url: 'https://docs.example/' }];
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: settings }));

    render(<App />);

    expect(await screen.findByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '快捷网址' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开 Docs' })).toHaveAttribute('href', 'https://docs.example/');
  });

  it('uses English throughout the resting page when English is selected', async () => {
    const settings = createDefaultSettings(); settings.interfaceLanguage = 'en-US';
    settings.widgets.shortcuts.enabled = true;
    settings.shortcuts = [{ id: 'docs', title: 'Docs', url: 'https://docs.example/' }];
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: settings }));

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Open settings' })).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'Get started with NewPicTab' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Shortcuts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Docs' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('lang', 'en-US');
  });

  it('renders an accessible fallback and connects new-tab rotation to local persistence', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'NewPicTab' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'A calm gradient background' })).toHaveAttribute(
      'src',
      '/assets/fallback.svg'
    );
    expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'fade');
    expect(screen.getByRole('button', { name: '打开设置' })).toBeInTheDocument();
    await waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
  });

  it('places image change and settings in independent corner reveal regions', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: '切换图片' }).closest('.corner-control'))
      .toHaveClass('corner-control--left');
    expect(screen.getByRole('button', { name: '打开设置' }).closest('.corner-control'))
      .toHaveClass('corner-control--right');
  });

  it('hides both initially visible corner controls after five seconds even when the pointer moves while visible', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const left = screen.getByRole('button', { name: '切换图片' }).closest('.corner-control')!;
      const right = screen.getByRole('button', { name: '打开设置' }).closest('.corner-control')!;

      expect(left).toHaveAttribute('data-visible', 'true');
      expect(right).toHaveAttribute('data-visible', 'true');
      act(() => { vi.advanceTimersByTime(4_000); });
      fireEvent.pointerMove(left);
      act(() => { vi.advanceTimersByTime(1_000); });

      expect(left).toHaveAttribute('data-visible', 'false');
      expect(right).toHaveAttribute('data-visible', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals only the hidden corner that receives pointer movement and hides it again five seconds later', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const left = screen.getByRole('button', { name: '切换图片' }).closest('.corner-control')!;
      const right = screen.getByRole('button', { name: '打开设置' }).closest('.corner-control')!;
      act(() => { vi.advanceTimersByTime(5_000); });

      fireEvent.pointerMove(left);

      expect(left).toHaveAttribute('data-visible', 'true');
      expect(right).toHaveAttribute('data-visible', 'false');
      act(() => { vi.advanceTimersByTime(4_999); });
      expect(left).toHaveAttribute('data-visible', 'true');
      act(() => { vi.advanceTimersByTime(1); });
      expect(left).toHaveAttribute('data-visible', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the first-run invitation only after settings load and opens Sources without covering the resting page with a modal', async () => {
    render(<App />);

    const invitation = await screen.findByRole('complementary', { name: '开始使用 NewPicTab' });
    expect(invitation).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加图片源' }));
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '图片源' })).toBeInTheDocument();
  });

  it('does not show first-run for an existing disabled source', async () => {
    const disabled = { id: 'disabled', name: 'Disabled', type: 'direct' as const, enabled: false, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), sources: [disabled], activeSourceId: null } }));
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: '打开设置' })).toBeInTheDocument());
    await waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'A calm gradient background' })).toBeInTheDocument();
  });

  it('loads an active source through the worker and binds persisted appearance to the stage', async () => {
    const source = { id: 'remote', name: 'Remote', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };
    const settings = { ...createDefaultSettings(), activeSourceId: source.id, sources: [source], appearance: { ...createDefaultSettings().appearance, transition: 'slide' as const } };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: settings }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((_message: unknown, callback: (value: unknown) => void) => callback({ ok: true, images: [{ id: 'one', sourceId: source.id, url: source.entries[0].url }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false })) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); }
    vi.stubGlobal('Image', DecodedImage);

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'slide'));
    await waitFor(() => expect(screen.getByTestId('background-current')).toHaveStyle({ backgroundImage: `url(${JSON.stringify(source.entries[0].url)})` }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ source: 'list', config: source, offset: 0, limit: 12 }, expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('does not publish the bundled image into the stage before active-source settings load', async () => {
    const source = { id: 'remote-pending', name: 'Remote Pending', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };
    let resolveSettings!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get).mockImplementation(() => new Promise((resolve) => { resolveSettings = resolve; }));
    const assigned: string[] = [];
    class DecodedImage {
      private value = '';
      decode = vi.fn(async () => undefined);
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      get src() { return this.value; }
      set src(value: string) { this.value = value; assigned.push(value); }
    }
    vi.stubGlobal('Image', DecodedImage);

    render(<App />);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

    expect(assigned).not.toContain('/assets/fallback.svg');
    expect(screen.getByTestId('background-current').style.backgroundImage).not.toContain('/assets/fallback.svg');
    resolveSettings({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } });
  });

  it('does not let a slower initial load overwrite a newer storage subscription value', async () => {
    let resolveLoad!: (value: Record<string, unknown>) => void;
    let listener!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    vi.mocked(chrome.storage.local.get).mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
      addListener: vi.fn((value) => { listener = value; }), removeListener: vi.fn(), hasListener: vi.fn()
    };
    render(<App />);
    const newer = { ...createDefaultSettings(), appearance: { ...createDefaultSettings().appearance, transition: 'slide' as const } };
    listener({ newpictab: { newValue: newer } }, 'local');
    await waitFor(() => expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'slide'));

    resolveLoad({ newpictab: createDefaultSettings() });

    await Promise.resolve();
    expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'slide');
  });

  it('never carries visible weather across a configured location change', async () => {
    let listener!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = { addListener: vi.fn((value) => { listener = value; }), removeListener: vi.fn(), hasListener: vi.fn() };
    const shanghai = createDefaultSettings();
    shanghai.widgets.weather = { enabled: true, mode: 'city', city: '上海', latitude: 31.2, longitude: 121.4, animated: false };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: shanghai }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { weather?: string; location?: string }, callback: (value: unknown) => void) => {
      if (message.weather === 'current' && message.location === '上海') callback({ ok: true, weather: { location: '上海', temperature: 22, temperatureUnit: '°C', weatherCode: 0, isDay: true, fetchedAt: 1, stale: false } });
      else callback({ ok: false, code: 'network', message: 'offline' });
    }) as typeof chrome.runtime.sendMessage);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('weather')).toHaveTextContent('上海'));

    const beijing = structuredClone(shanghai); beijing.widgets.weather = { ...beijing.widgets.weather, city: '北京', latitude: 39.9, longitude: 116.4 };
    listener({ newpictab: { newValue: beijing } }, 'local');

    await waitFor(() => expect(screen.queryByTestId('weather')).not.toBeInTheDocument());
  });

  it('loads remote metadata in overlapping windows without skipping 10 or 11 and reaches the final image', async () => {
    const source = { id: 'windowed', name: 'Windowed', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source], appearance: { ...createDefaultSettings().appearance, order: 'sequential' as const } } }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { source: string; offset?: number; cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.cacheOnly) { callback({ ok: false, images: [], error: { code: 'empty', message: 'none' } }); return; }
      const offset = message.offset ?? 0; const totalCount = 25; const images = Array.from({ length: Math.min(12, totalCount - offset) }, (_, index) => ({ id: String(offset + index), sourceId: source.id, url: `https://images.example/${offset + index}.jpg` }));
      callback({ ok: true, images, totalCount, offset, consumedCount: images.length, nextOffset: offset + images.length, hasMore: offset + images.length < totalCount });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<App />); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('/0.jpg'));
    for (let id = 1; id <= 9; id += 1) { fireEvent.keyDown(window, { key: 'ArrowRight' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/${id}.jpg`)); }
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'list', offset: 12, limit: 12 }), expect.any(Function)));
    for (let id = 10; id <= 12; id += 1) { fireEvent.keyDown(window, { key: 'ArrowRight' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/${id}.jpg`)); }
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('/11.jpg'));
    fireEvent.keyDown(window, { key: 'ArrowRight' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('/12.jpg'));
    for (let id = 13; id <= 21; id += 1) { fireEvent.keyDown(window, { key: 'ArrowRight' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/${id}.jpg`)); }
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ offset: 24 }), expect.any(Function)));
    for (let id = 22; id <= 24; id += 1) { fireEvent.keyDown(window, { key: 'ArrowRight' }); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/${id}.jpg`)); }
    vi.unstubAllGlobals();
  });

  it('uses the worker metadata cursor rather than the number of displayable images for the next request', async () => {
    const source = { id: 'partial', name: 'Partial', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { offset?: number; cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.cacheOnly) { callback({ ok: false, images: [], error: { code: 'empty', message: 'none' } }); return; }
      const offset = message.offset ?? 0;
      const ids = offset === 0 ? Array.from({ length: 10 }, (_, index) => index) : Array.from({ length: 8 }, (_, index) => 12 + index);
      callback({
        ok: true,
        images: ids.map((id) => ({ id: String(id), sourceId: source.id, url: `https://images.example/${id}.jpg` })),
        totalCount: 20,
        offset,
        consumedCount: offset === 0 ? 12 : 8,
        nextOffset: offset === 0 ? 12 : 20,
        hasMore: offset === 0
      });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('images.example'));
    for (let step = 0; step < 10 && !vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([request]) => (request as { offset?: number }).offset === 12); step += 1) {
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('images.example'));
    }

    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'list', offset: 12, limit: 12 }),
      expect.any(Function)
    ));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 10 }), expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('keeps the previous source visible with a loading indicator until the target cache is ready', async () => {
    const a = { id: 'a', name: 'A', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const b = { id: 'b', name: 'B', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    let listener!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = { addListener: vi.fn((value) => { listener = value; }), removeListener: vi.fn(), hasListener: vi.fn() };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: a.id, sources: [a, b] } }));
    let resolveBCache!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { config: { id: string }; cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.config.id === 'a') { callback(message.cacheOnly ? { ok: false, images: [], error: { code: 'empty', message: 'none' } } : { ok: true, images: [{ id: 'a1', sourceId: 'a', url: 'https://a.example/one.jpg' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false }); return; }
      if (message.cacheOnly) { void new Promise((resolve) => { resolveBCache = (value) => { callback(value); resolve(undefined); }; }); return; }
      callback({ ok: false, images: [], error: { code: 'network', message: 'offline' } });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<StrictMode><App /></StrictMode>); await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('a.example'));
    listener({ newpictab: { newValue: { ...createDefaultSettings(), activeSourceId: b.id, sources: [a, b] } } }, 'local');

    await waitFor(() => expect(screen.getByRole('status', { name: '正在准备图片' })).toBeInTheDocument());
    expect(screen.getByTestId('background-current').style.backgroundImage).toContain('a.example');
    resolveBCache({ ok: true, images: [{ id: 'b-cache', sourceId: 'b', url: 'https://b.example/cached.jpg' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('b.example'));
    expect(screen.getByTestId('background-current').style.backgroundImage).not.toContain('a.example');
    await waitFor(() => expect(screen.queryByRole('status', { name: '正在准备图片' })).not.toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('does not keep the page in loading when the active source already has a visible image', async () => {
    const source = { id: 'visible-source', name: 'Visible', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    let listener!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = { addListener: vi.fn((value) => { listener = value; }), removeListener: vi.fn(), hasListener: vi.fn() };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    let hangAfterInitialLoad = false;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.cacheOnly) { callback({ ok: false, images: [], error: { code: 'empty', message: 'none' } }); return; }
      if (hangAfterInitialLoad) return;
      callback({ ok: true, images: [{ id: 'one', sourceId: source.id, url: 'https://visible.example/one.jpg' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('background-current')).toHaveAttribute('data-source-id', source.id));

    hangAfterInitialLoad = true;
    listener({ newpictab: { newValue: { ...createDefaultSettings(), activeSourceId: source.id, sources: [{ ...source, updatedAt: 2 }] } } }, 'local');
    await waitFor(() => expect(screen.getByTestId('background-current')).toHaveAttribute('data-source-id', source.id));

    expect(screen.queryByRole('status', { name: '正在准备图片' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('rejects a remote success response that omits the metadata cursor protocol', async () => {
    const source = { id: 'protocol', name: 'Protocol', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      callback(message.cacheOnly
        ? { ok: false, images: [], error: { code: 'empty', message: 'none' } }
        : { ok: true, images: [{ id: 'bad', sourceId: source.id, url: 'https://missing-cursor.example/bad.jpg' }], totalCount: 12, offset: 0, hasMore: true });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);

    render(<App />);
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId('background-current').style.backgroundImage).not.toContain('missing-cursor.example');
  });

  it('keeps a cache-only blob alive until current and previous migrate to the network lease', async () => {
    const source = { id: 'blob-source', name: 'Blob', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    let resolveNetwork!: () => void;
    const networkReady = new Promise<void>((resolve) => { resolveNetwork = resolve; });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.cacheOnly) {
        callback({ ok: true, images: [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
        return;
      }
      void networkReady.then(() => callback({ ok: true, images: [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false }));
    }) as typeof chrome.runtime.sendMessage);
    vi.spyOn(RemoteCache.prototype, 'get').mockImplementation(async () => new Response(new Blob(['image'])));
    let sequence = 0;
    const violations: string[] = [];
    class TestURL extends URL {}
    TestURL.createObjectURL = vi.fn(() => `blob:lease-${++sequence}`);
    TestURL.revokeObjectURL = vi.fn((url: string) => {
      const current = screen.queryByTestId('background-current')?.getAttribute('style') ?? '';
      const previous = screen.queryByTestId('background-previous')?.getAttribute('style') ?? '';
      if (current.includes(url) || previous.includes(url)) violations.push(url);
    });
    vi.stubGlobal('URL', TestURL);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    const reflows = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('blob:lease-1'));
    reflows.mockClear();
    resolveNetwork();
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('blob:lease-2'));
    await waitFor(() => expect(TestURL.revokeObjectURL).toHaveBeenCalledWith('blob:lease-1'));

    expect(violations).toEqual([]);
    expect(reflows).not.toHaveBeenCalled();
  });

  it('invalidates and revokes a delayed materialization after unmount', async () => {
    const source = { id: 'late-source', name: 'Late', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      callback({ ok: true, images: [{ id: 'late', sourceId: source.id, remoteCacheEntryId: 'late' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
    }) as typeof chrome.runtime.sendMessage);
    let resolveBlob!: (response: Response) => void;
    vi.spyOn(RemoteCache.prototype, 'get').mockImplementation(() => new Promise<Response>((resolve) => { resolveBlob = resolve; }));
    class TestURL extends URL {}
    TestURL.createObjectURL = vi.fn(() => 'blob:late-app');
    TestURL.revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', TestURL);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    const mounted = render(<App />);
    await waitFor(() => expect(RemoteCache.prototype.get).toHaveBeenCalled());

    mounted.unmount();
    resolveBlob(new Response(new Blob(['late'])));

    await waitFor(() => expect(TestURL.revokeObjectURL).toHaveBeenCalledWith('blob:late-app'));
  });

  it('invalidates and revokes a delayed materialization when a newer refresh starts', async () => {
    const source = { id: 'refresh-source', name: 'Refresh', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://images.example/one.jpg' }] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    vi.mocked(chrome.permissions.request).mockImplementation(((_permissions: chrome.permissions.Permissions, callback?: (granted: boolean) => void) => { callback?.(true); }) as typeof chrome.permissions.request);
    let listCount = 0;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { source: string; cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      if (message.source === 'refresh') { callback({ ok: true }); return; }
      if (message.cacheOnly) { callback({ ok: false, images: [], error: { code: 'empty', message: 'none' } }); return; }
      listCount += 1;
      callback({
        ok: true,
        images: listCount === 3
          ? [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one' }]
          : [{ id: 'one', sourceId: source.id, url: `https://images.example/raw-${listCount}.jpg` }],
        totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false
      });
    }) as typeof chrome.runtime.sendMessage);
    let resolveBlob!: (response: Response) => void;
    vi.spyOn(RemoteCache.prototype, 'get').mockImplementation(() => new Promise<Response>((resolve) => { resolveBlob = resolve; }));
    class TestURL extends URL {}
    TestURL.createObjectURL = vi.fn(() => 'blob:stale-refresh');
    TestURL.revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', TestURL);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('raw-1'));
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));

    fireEvent.click(screen.getByRole('button', { name: '刷新 Refresh' }));
    await waitFor(() => expect(RemoteCache.prototype.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '刷新 Refresh' }));
    await waitFor(() => expect(listCount).toBeGreaterThanOrEqual(5));
    resolveBlob(new Response(new Blob(['stale'])));

    await waitFor(() => expect(TestURL.revokeObjectURL).toHaveBeenCalledWith('blob:stale-refresh'));
    expect(screen.getByTestId('background-current').style.backgroundImage).not.toContain('blob:stale-refresh');
  });

  it('rejects contradictory complete cursor metadata without appending or retrying', async () => {
    const source = { id: 'contradictory', name: 'Contradictory', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] } }));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { cacheOnly?: boolean }, callback: (value: unknown) => void) => {
      callback(message.cacheOnly
        ? { ok: false, images: [], error: { code: 'empty', message: 'none' } }
        : { ok: true, images: [{ id: 'bad', sourceId: source.id, url: 'https://contradictory.example/bad.jpg' }], totalCount: 1, offset: 1, consumedCount: 1, nextOffset: 2, hasMore: false });
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);

    render(<App />);
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(screen.getByTestId('background-current').style.backgroundImage).not.toContain('contradictory.example');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('lets a new source own window loading while the old source finishes late', async () => {
    const a = { id: 'owner-a', name: 'Owner A', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const b = { id: 'owner-b', name: 'Owner B', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    let listener!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = { addListener: vi.fn((value) => { listener = value; }), removeListener: vi.fn(), hasListener: vi.fn() };
    const defaults = createDefaultSettings();
    const sequentialSettings = { ...defaults, activeSourceId: a.id, sources: [a, b], appearance: { ...defaults.appearance, order: 'sequential' as const } };
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ newpictab: sequentialSettings }));
    let finishACache!: () => void;
    let finishBNext!: () => void;
    let bCacheOnlyCalls = 0;
    let bNextCalls = 0;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: { config: { id: string }; cacheOnly?: boolean; offset?: number }, callback: (value: unknown) => void) => {
      if (message.config.id === a.id && message.cacheOnly) {
        finishACache = () => callback({ ok: false, images: [], error: { code: 'empty', message: 'late' } });
        return;
      }
      if (message.config.id === b.id && message.cacheOnly) {
        bCacheOnlyCalls += 1;
        callback({ ok: true, images: [{ id: 'b0', sourceId: b.id, url: 'https://b.example/cache.jpg' }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
        return;
      }
      if (message.config.id === b.id && (message.offset ?? 0) === 0) {
        callback({ ok: true, images: ['b0', 'b1', 'b2'].map((id) => ({ id, sourceId: b.id, url: `https://b.example/${id}.jpg` })), totalCount: 13, offset: 0, consumedCount: 12, nextOffset: 12, hasMore: true });
        return;
      }
      if (message.config.id === b.id && message.offset === 12) {
        bNextCalls += 1;
        finishBNext = () => callback({ ok: true, images: [{ id: 'b12', sourceId: b.id, url: 'https://b.example/b12.jpg' }], totalCount: 13, offset: 12, consumedCount: 1, nextOffset: 13, hasMore: false });
      }
    }) as typeof chrome.runtime.sendMessage);
    class DecodedImage { src = ''; decode = vi.fn(async () => undefined); addEventListener = vi.fn(); removeEventListener = vi.fn(); } vi.stubGlobal('Image', DecodedImage);
    render(<App />);
    await waitFor(() => expect(finishACache).toBeTypeOf('function'));

    listener({ newpictab: { newValue: { ...sequentialSettings, activeSourceId: b.id } } }, 'local');
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toMatch(/\/b[0-2]\.jpg/));
    expect(bCacheOnlyCalls).toBe(1);
    await waitFor(() => expect(bNextCalls).toBe(1));

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
    const beforeMatch = screen.getByTestId('background-current').style.backgroundImage.match(/\/b([0-2])\.jpg/);
    expect(beforeMatch).not.toBeNull();
    const beforeIndex = Number(beforeMatch?.[1]);
    const navigatedIndex = (beforeIndex + 1) % 3;
    finishACache();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/b${navigatedIndex}.jpg`));
    await Promise.resolve();
    expect(bNextCalls).toBe(1);

    await act(async () => {
      finishBNext();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    for (let id = navigatedIndex + 1; id <= 2; id += 1) {
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain(`/b${id}.jpg`));
    }
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('background-current').style.backgroundImage).toContain('/b12.jpg'));
  });
});

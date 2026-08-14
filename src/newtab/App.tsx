import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { createDefaultSettings } from '../domain/defaults';
import type { NewPicTabSettings } from '../domain/types';
import type { ImageEntry } from '../sources/adapter';
import { LocalSourceAdapter } from '../sources/local';
import * as settingsStore from '../storage/settingsStore';
import { BackgroundStage } from './components/BackgroundStage';
import { ClockWeather } from './components/ClockWeather';
import { SearchBox } from './components/SearchBox';
import { ShortcutDock } from './components/ShortcutDock';
import { FirstRun } from './components/FirstRun';
import { Icon } from './components/Icon';
import { CornerControl } from './components/CornerControl';
import { chromeRotationCursorStore } from './backgroundCursor';
import { useBackgroundRotation, type BackgroundImage } from './hooks/useBackgroundRotation';
import { createSourceOperations, listSource, RemoteCacheSession, type RemoteCacheLease } from './sourceClient';
import { SettingsDrawer } from './settings/SettingsDrawer';
import type { SourceLoadState } from './settings/SourcesPanel';
import type { WeatherBackgroundResponse } from '../background/messages';
import type { WeatherSnapshot } from '../weather/openMeteo';
import { LanguageProvider } from './i18n';

const BUNDLED_BACKGROUND: BackgroundImage = {
  id: 'newpictab-fallback',
  sourceId: 'bundled',
  url: '/assets/fallback.svg',
  description: 'A calm gradient background'
};
const REMOTE_WINDOW_SIZE = 12;
const MAX_REMOTE_WINDOWS = 3;

interface RemoteWindow {
  lease: RemoteCacheLease;
  entryIds: Set<string>;
  urls: Set<string>;
}

interface WindowLoadOwner {
  generation: number;
  nonce: number;
}

export default function App() {
  const [settings, setSettings] = useState<NewPicTabSettings>(() => createDefaultSettings());
  const [settingsReady, setSettingsReady] = useState(false);
  const [openSourcesRequest, setOpenSourcesRequest] = useState(0);
  const [firstRunDismissRequest, setFirstRunDismissRequest] = useState(0);
  const [firstRunReset, setFirstRunReset] = useState(0);
  const [entries, setEntries] = useState<BackgroundImage[]>([BUNDLED_BACKGROUND]);
  const [sourceCounts, setSourceCounts] = useState<Record<string, number | undefined>>({});
  const [sourceStates, setSourceStates] = useState<Record<string, SourceLoadState | undefined>>({});
  const [backgroundElement, setBackgroundElement] = useState<HTMLElement | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [generation, setGeneration] = useState('bundled-v1');
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [clockScalePreview, setClockScalePreview] = useState<number | null>(null);
  const [localAdapter] = useState(() => new LocalSourceAdapter());
  const [remoteCacheSession] = useState(() => new RemoteCacheSession());
  const loadGeneration = useRef(0);
  const displayedSourceId = useRef<string | null>(null);
  const windowState = useRef({ nextOffset: 0, totalCount: 0, hasMore: false });
  const remoteWindows = useRef<RemoteWindow[]>([]);
  const retiredWindows = useRef<RemoteWindow[]>([]);
  const windowLoading = useRef<WindowLoadOwner | null>(null);
  const windowLoadNonce = useRef(0);
  const protectedEntryIds = useRef<string[]>([]);
  const visibleEntryIds = useRef<string[]>([]);
  const operations = useMemo(() => createSourceOperations(localAdapter), [localAdapter]);
  const activeSource = settings.sources.find((source) => source.id === settings.activeSourceId && source.enabled);
  const activeSourceRevision = activeSource ? `${activeSource.id}:${activeSource.updatedAt}` : '';
  const activeSourceState = activeSource ? sourceStates[activeSource.id]?.status : undefined;
  const backgroundLoadingLabel = settings.interfaceLanguage === 'zh-CN' ? '正在准备图片' : 'Preparing image';

  useEffect(() => {
    let active = true;
    let superseded = false;
    void settingsStore.load().then((loaded) => { if (active && !superseded) { setSettings(loaded); setSettingsReady(true); } });
    const unsubscribe = settingsStore.subscribe((next) => { superseded = true; setSettings(next); setSettingsReady(true); });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    document.documentElement.lang = settings.interfaceLanguage;
  }, [settings.interfaceLanguage]);

  useEffect(() => {
    remoteCacheSession.activate();
    return () => {
      operations.abandonLocalImports?.();
      localAdapter.dispose();
      remoteCacheSession.dispose();
    };
  }, [localAdapter, operations, remoteCacheSession]);

  useLayoutEffect(() => {
    loadGeneration.current += 1;
    const owned = remoteWindows.current.filter((window) => window.lease.urlCount > 0);
    for (const window of remoteWindows.current) if (window.lease.urlCount === 0) window.lease.release();
    remoteWindows.current = [];
    retiredWindows.current = [...retiredWindows.current, ...owned];
    displayedSourceId.current = null;
    windowState.current = { nextOffset: 0, totalCount: 0, hasMore: false };
    windowLoading.current = null;
    protectedEntryIds.current = [];
    setEntries(activeSource ? [] : [BUNDLED_BACKGROUND]);
    setGeneration(activeSource ? `source:${activeSource.id}:revision:${activeSource.updatedAt}` : 'bundled-v1');
  }, [activeSourceRevision, remoteCacheSession]);

  useLayoutEffect(() => {
    loadGeneration.current += 1;
    windowLoading.current = null;
    return () => {
      loadGeneration.current += 1;
      windowLoading.current = null;
    };
  }, [refreshVersion]);

  const publishWindow = useCallback(async (source: NonNullable<typeof activeSource>, result: Awaited<ReturnType<typeof listSource>>, request: number, cachedOnly: boolean, append: boolean, requestedOffset: number): Promise<boolean> => {
    if (request !== loadGeneration.current || !result.ok) return false;
    if (source.type !== 'local' && !hasRemoteWindowCursor(result, requestedOffset)) {
      const state: SourceLoadState = sourceState(source, displayedSourceId.current === source.id ? 'stale' : 'error', { code: 'invalid-pagination-cursor' });
      setSourceStates((states) => ({ ...states, [source.id]: state }));
      return false;
    }
    if (remoteWindows.current.length >= MAX_REMOTE_WINDOWS) {
      const visible = new Set(visibleEntryIds.current);
      const removable = append
        ? remoteWindows.current
            .filter((window) => ![...window.entryIds].some((id) => visible.has(id)))
            .slice(0, remoteWindows.current.length - MAX_REMOTE_WINDOWS + 1)
        : remoteWindows.current.filter((window) => ![...window.entryIds].some((id) => visible.has(id)));
      if (!removable.length) return false;
      const removedIds = new Set(removable.flatMap((window) => [...window.entryIds]));
      for (const window of removable) remoteCacheSession.release(window.lease);
      const removed = new Set(removable);
      remoteWindows.current = remoteWindows.current.filter((window) => !removed.has(window));
      setEntries((current) => current.filter((entry) => !removedIds.has(entry.id)));
    }
    const lease = await remoteCacheSession.materialize(result.images);
    if (request !== loadGeneration.current) { lease.release(); return false; }
    const displayable = lease.entries.flatMap(toBackgroundImage);
    const offset = result.offset ?? requestedOffset;
    const consumedCount = source.type === 'local' ? result.images.length : result.consumedCount!;
    const nextOffset = source.type === 'local' ? offset + consumedCount : result.nextOffset!;
    const totalCount = result.totalCount ?? nextOffset;
    windowState.current = { nextOffset, totalCount, hasMore: result.hasMore ?? nextOffset < totalCount };
    if (!displayable.length) { lease.release(); return false; }
    const firstWindowForSource = displayedSourceId.current !== source.id;
    if (!remoteCacheSession.commit(lease)) return false;
    const nextWindow: RemoteWindow = {
      lease,
      entryIds: new Set(displayable.map((entry) => entry.id)),
      urls: new Set(displayable.map((entry) => entry.url))
    };
    if (append) {
      remoteWindows.current = [...remoteWindows.current, nextWindow];
      setEntries((current) => {
        const currentIds = new Set(current.map((entry) => entry.id));
        return [...current, ...displayable.filter((entry) => !currentIds.has(entry.id))];
      });
    } else {
      const replaced = remoteWindows.current;
      remoteWindows.current = [nextWindow];
      setEntries(displayable);
      const owned = replaced.filter((window) => window.lease.urlCount > 0);
      for (const window of replaced) if (window.lease.urlCount === 0) window.lease.release();
      retiredWindows.current = [...retiredWindows.current, ...owned];
    }
    displayedSourceId.current = source.id;
    if (firstWindowForSource) setGeneration(`source:${source.id}:loaded:${request}`);
    setSourceCounts((counts) => ({ ...counts, [source.id]: totalCount }));
    const stale = cachedOnly || result.warnings?.some((warning) => warning.message.includes('Cached images are being used'));
    setSourceStates((states) => ({ ...states, [source.id]: stale ? sourceState(source, 'stale', result.warnings) : { status: 'ready' } }));
    return true;
  }, [remoteCacheSession]);

  const loadRemoteWindow = useCallback(async (source: NonNullable<typeof activeSource>, offset: number, request: number, cacheOnly = false, append = false): Promise<boolean> => {
    if (windowLoading.current || request !== loadGeneration.current) return false;
    const owner: WindowLoadOwner = { generation: request, nonce: ++windowLoadNonce.current };
    windowLoading.current = owner;
    try {
      const protectedIds = protectedEntryIds.current;
      const result = await listSource(source, localAdapter, { offset, limit: REMOTE_WINDOW_SIZE, cacheOnly, ...(protectedIds.length ? { protectedEntryIds: protectedIds } : {}) });
      return await publishWindow(source, result, request, cacheOnly, append, offset);
    } catch (error) {
      if (request === loadGeneration.current) {
        if (displayedSourceId.current === source.id) {
          setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'stale', error) }));
        } else {
          remoteCacheSession.clear();
          remoteWindows.current = [];
          retiredWindows.current = [];
          displayedSourceId.current = null;
          setEntries([BUNDLED_BACKGROUND]);
          setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'error', error) }));
        }
      }
      return false;
    } finally {
      if (windowLoading.current === owner) windowLoading.current = null;
    }
  }, [localAdapter, publishWindow, remoteCacheSession]);

  useEffect(() => {
    if (!activeSource) {
      return;
    }
    let current = true;
    const source = activeSource;
    const request = loadGeneration.current;
    const mayKeepSameSource = displayedSourceId.current === source.id;
    setSourceStates((states) => ({ ...states, [source.id]: { status: 'loading' } }));
    void (async () => {
      try {
        if (source.type !== 'local' && !mayKeepSameSource) await loadRemoteWindow(source, 0, request, true);
        if (!current || request !== loadGeneration.current) return;
        const result = source.type === 'local'
          ? await listSource(source, localAdapter)
          : await listSource(source, localAdapter, { offset: 0, limit: REMOTE_WINDOW_SIZE });
        if (!current || request !== loadGeneration.current) return;
        if (result.ok && await publishWindow(source, result, request, false, false, 0)) return;
        if (displayedSourceId.current === source.id) {
          setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'stale', result.ok ? result.warnings : result.error) }));
        } else {
          remoteCacheSession.clear(); remoteWindows.current = []; retiredWindows.current = []; displayedSourceId.current = null; setEntries([BUNDLED_BACKGROUND]);
          setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'error', result.ok ? { code: 'empty' } : result.error) }));
        }
      } catch (error) {
        if (!current || request !== loadGeneration.current) return;
        if (displayedSourceId.current === source.id) setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'stale', error) }));
        else { remoteCacheSession.clear(); remoteWindows.current = []; retiredWindows.current = []; displayedSourceId.current = null; setEntries([BUNDLED_BACKGROUND]); setSourceStates((states) => ({ ...states, [source.id]: sourceState(source, 'error', error) })); }
      }
    })();
    return () => {
      current = false;
      if (source.type === 'local') void localAdapter.refreshMetadata(source);
    };
  }, [activeSourceRevision, localAdapter, loadRemoteWindow, publishWindow, refreshVersion, remoteCacheSession]);

  const updateSettings = useCallback(async (updater: (current: NewPicTabSettings) => NewPicTabSettings) => {
    const updated = await settingsStore.update(updater);
    setSettings(updated);
    return updated;
  }, []);

  const refreshSource = useCallback((sourceId: string) => {
    if (sourceId === settings.activeSourceId) setRefreshVersion((value) => value + 1);
  }, [settings.activeSourceId]);

  useEffect(() => {
    const value = settings.widgets.weather;
    const { latitude, longitude } = value;
    if (!value.enabled || latitude === null || longitude === null) { setWeather(null); return; }
    setWeather(null);
    let active = true;
    const loadWeather = async () => {
      const fallback = settings.interfaceLanguage === 'zh-CN' ? '当前位置' : 'Current location';
      const resolved = await sendWeatherReverseGeocode({ latitude, longitude, locale: settings.interfaceLanguage });
      const location = resolved.ok && 'location' in resolved ? resolved.location : value.city || fallback;
      const response = await sendWeatherCurrent({ location, latitude, longitude, locale: settings.interfaceLanguage });
      if (active && response.ok && 'weather' in response) setWeather(response.weather);
    };
    void loadWeather();
    const timer = setInterval(() => { void loadWeather(); }, 30 * 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [settings.interfaceLanguage, settings.widgets.weather.city, settings.widgets.weather.enabled, settings.widgets.weather.latitude, settings.widgets.weather.longitude]);

  const rotationEntries = activeSource && entries[0]?.sourceId !== activeSource.id ? [] : entries;
  const previewWidgets = useMemo(() => clockScalePreview === null
    ? settings.widgets
    : { ...settings.widgets, clock: { ...settings.widgets.clock, scale: clockScalePreview } }, [clockScalePreview, settings.widgets]);
  const background = useBackgroundRotation({
    entries: rotationEntries,
    order: settings.appearance.order,
    changeOn: settings.appearance.changeOn,
    intervalMinutes: settings.appearance.intervalMinutes,
    generation,
    cursorStore: chromeRotationCursorStore,
    incrementalEntries: activeSource?.type !== 'local',
    sourceResetKey: activeSource?.id ?? 'bundled'
  });
  const isSourcePreparing = activeSourceState === 'loading' && background.current?.sourceId !== activeSource?.id;
  const isBackgroundPreparing = background.isDecoding || isSourcePreparing;

  useLayoutEffect(() => {
    visibleEntryIds.current = [background.current?.id, background.previous?.id].filter((id): id is string => Boolean(id));
    const visibleUrls = new Set([background.current?.url, background.previous?.url].filter((url): url is string => Boolean(url)));
    const retained: RemoteWindow[] = [];
    for (const window of retiredWindows.current) {
      if ([...window.urls].some((url) => visibleUrls.has(url))) retained.push(window);
      else remoteCacheSession.release(window.lease);
    }
    retiredWindows.current = retained;
  }, [background.current, background.previous, remoteCacheSession]);

  useEffect(() => {
    const currentIndex = background.current ? entries.findIndex((entry) => entry.id === background.current?.id) : -1;
    protectedEntryIds.current = currentIndex < 0
      ? []
      : [entries[currentIndex]?.id, entries[(currentIndex + 1) % entries.length]?.id].filter((id): id is string => Boolean(id));
  }, [background.current, entries]);

  useEffect(() => {
    if (!activeSource || activeSource.type === 'local' || displayedSourceId.current !== activeSource.id || windowLoading.current) return;
    const currentIndex = background.current ? entries.findIndex((entry) => entry.id === background.current?.id) : -1;
    const window = windowState.current;
    const nearEnd = window.hasMore && currentIndex >= Math.max(0, entries.length - 3);
    if (!nearEnd) return;
    void loadRemoteWindow(activeSource, window.nextOffset, loadGeneration.current, false, true);
  }, [activeSourceRevision, background.current, entries, loadRemoteWindow]);

  return (
    <LanguageProvider language={settings.interfaceLanguage}>
    <main ref={setBackgroundElement} className="app">
      <img
        className="fallback-background"
        src="/assets/fallback.svg"
        alt="A calm gradient background"
      />
      <BackgroundStage
        current={background.current}
        previous={background.previous}
        direction={background.direction}
        transition={settings.appearance.transition}
        transitionMs={settings.appearance.transitionMs}
      />
      <ClockWeather settings={previewWidgets} weather={weather} locale={settings.interfaceLanguage} backgroundImage={background.current} />
      <SearchBox settings={settings.widgets.search} language={settings.interfaceLanguage} />
      <ShortcutDock enabled={settings.widgets.shortcuts.enabled} shortcuts={settings.shortcuts} maxVisible={settings.widgets.shortcuts.maxVisible} scale={settings.widgets.shortcuts.scale} />
      {isBackgroundPreparing && (
        <div className="background-loading" role="status" aria-label={backgroundLoadingLabel}>
          <span className="background-loading__spinner" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
          </span>
        </div>
      )}
      <CornerControl side="left">
        <button className="change-image-trigger corner-control__button icon-button" type="button" aria-label={settings.interfaceLanguage === 'zh-CN' ? '切换图片' : 'Change image'} title={settings.interfaceLanguage === 'zh-CN' ? '切换图片' : 'Change image'} onClick={() => void background.goNext()}><Icon name="refresh" /></button>
      </CornerControl>
      {settingsReady && <FirstRun key={firstRunReset} hasConfiguredSource={settings.sources.length > 0} dismissRequest={firstRunDismissRequest} onOpenSources={() => setOpenSourcesRequest((value) => value + 1)} />}
      <h1 className="app-title">NewPicTab</h1>
    </main>
    <SettingsDrawer settings={settings} onUpdate={updateSettings} onChangeImage={background.goNext} operations={operations} sourceCounts={sourceCounts} sourceStates={sourceStates} onRefreshSource={refreshSource} backgroundElement={backgroundElement} weather={weather} openSourcesRequest={openSourcesRequest} onOpen={() => setFirstRunDismissRequest((value) => value + 1)} onClockScalePreview={setClockScalePreview} onDataCleared={(next) => {
      setSettings(next);
      setSettingsReady(true);
      setClockScalePreview(null);
      setWeather(null);
      setSourceCounts({});
      setSourceStates({});
      setFirstRunDismissRequest(0);
      setFirstRunReset((value) => value + 1);
    }} />
    </LanguageProvider>
  );
}

function sendWeatherReverseGeocode(location: { latitude: number; longitude: number; locale: string }): Promise<WeatherBackgroundResponse> {
  return sendWeatherMessage({ weather: 'reverse-geocode', ...location });
}

function sendWeatherCurrent(location: { location: string; latitude: number; longitude: number; locale: string }): Promise<WeatherBackgroundResponse> {
  return sendWeatherMessage({ weather: 'current', ...location });
}

function sendWeatherMessage(message: unknown): Promise<WeatherBackgroundResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: WeatherBackgroundResponse | undefined) => {
        if (chrome.runtime.lastError || !response) resolve({ ok: false, code: 'network', message: '天气服务暂不可用。' });
        else resolve(response);
      });
    } catch { resolve({ ok: false, code: 'network', message: '天气服务暂不可用。' }); }
  });
}

function toBackgroundImage(entry: ImageEntry): BackgroundImage[] {
  if (!('url' in entry) || !entry.url) return [];
  return [{ id: entry.id, sourceId: entry.sourceId, url: entry.url, ...(entry.description ? { description: entry.description } : {}) }];
}

function hasRemoteWindowCursor(result: Extract<Awaited<ReturnType<typeof listSource>>, { ok: true }>, requestedOffset: number): boolean {
  return typeof result.offset === 'number'
    && Number.isSafeInteger(result.offset)
    && result.offset >= 0
    && result.offset === requestedOffset
    && typeof result.consumedCount === 'number'
    && Number.isSafeInteger(result.consumedCount)
    && result.consumedCount > 0
    && typeof result.nextOffset === 'number'
    && Number.isSafeInteger(result.nextOffset)
    && result.nextOffset === result.offset + result.consumedCount
    && typeof result.totalCount === 'number'
    && Number.isSafeInteger(result.totalCount)
    && result.totalCount >= result.nextOffset
    && typeof result.hasMore === 'boolean'
    && result.hasMore === (result.nextOffset < result.totalCount);
}

function sourceState(source: NewPicTabSettings['sources'][number], status: 'stale' | 'error', detail: unknown): SourceLoadState {
  return { status, detail, protected: source.type === 'webdav' || source.type === 'json-api' || source.type === 'tmdb' };
}

import { createDefaultSettings, DEFAULT_SETTINGS } from './defaults';
import type {
  AppearanceSettings,
  DirectEntry,
  JsonApiSourceConfig,
  PicTabSettings,
  Shortcut,
  SourceBase,
  SourceConfig,
  TmdbMovieSourceConfig,
  TmdbTvSourceConfig,
  WidgetSettings
} from './types';
import { boundedShortcutDockScale, canonicalShortcutTitle, canonicalShortcutUrl, isSafeShortcutIcon, MAX_SHORTCUTS } from './shortcuts';
import { validateSearchTemplate } from './search';
import { isSafeWebDavDirectoryName } from '../sources/webdavUrl';

const TRANSITIONS = new Set(['fade', 'slide', 'ken-burns', 'none']);
const ORDERS = new Set(['sequential', 'shuffle']);
const CHANGE_ON = new Set(['new-tab', 'interval']);
const DATE_FORMATS = new Set(['short', 'medium', 'long', 'full']);
const CLOCK_SIZES = new Set(['compact', 'default', 'large']);
const CLOCK_SCALE_MIN = 0.45;
const CLOCK_SCALE_MAX = 1.35;
const CLOCK_POSITIONS = new Set(['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']);
const INTERFACE_LANGUAGES = new Set(['zh-CN', 'en-US']);
const SEARCH_ENGINES = new Set(['google', 'bing', 'duckduckgo', 'baidu', 'custom']);
const TMDB_MOVIE_FEEDS = new Set(['popular', 'top-rated', 'now-playing', 'upcoming', 'trending-daily', 'trending-weekly', 'discover']);
const TMDB_TV_FEEDS = new Set(['popular', 'top-rated', 'airing-today', 'on-the-air', 'trending-daily', 'trending-weekly', 'discover']);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function legacyClockScale(size: unknown, fallback: number): number {
  if (size === 'compact') return 0.55;
  if (size === 'large') return 1.18;
  return fallback;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function cloneDefaults(): PicTabSettings {
  return createDefaultSettings();
}

function migrateAppearance(value: unknown): AppearanceSettings {
  const defaults = DEFAULT_SETTINGS.appearance;
  if (!isRecord(value)) return { ...defaults };
  return {
    transition: TRANSITIONS.has(value.transition as string) ? value.transition as AppearanceSettings['transition'] : defaults.transition,
    transitionMs: number(value.transitionMs, defaults.transitionMs, 0, 5_000),
    order: ORDERS.has(value.order as string) ? value.order as AppearanceSettings['order'] : defaults.order,
    changeOn: CHANGE_ON.has(value.changeOn as string) ? value.changeOn as AppearanceSettings['changeOn'] : defaults.changeOn,
    intervalMinutes: number(value.intervalMinutes, defaults.intervalMinutes, 1, 1_440)
  };
}

function migrateWidgets(value: unknown): WidgetSettings {
  const defaults = DEFAULT_SETTINGS.widgets;
  const widgets = isRecord(value) ? value : {};
  const clock = isRecord(widgets.clock) ? widgets.clock : {};
  const date = isRecord(widgets.date) ? widgets.date : {};
  const weather = isRecord(widgets.weather) ? widgets.weather : {};
  const search = isRecord(widgets.search) ? widgets.search : {};
  const shortcuts = isRecord(widgets.shortcuts) ? widgets.shortcuts : {};
  const searchSettings = migrateSearch(search, defaults.search);
  const weatherMode = weather.mode === 'coordinates' || weather.mode === 'city' ? weather.mode : defaults.weather.mode;
  const weatherCity = string(weather.city, defaults.weather.city).trim().slice(0, 160);
  const weatherLatitude = coordinate(weather.latitude, -90, 90);
  const weatherLongitude = coordinate(weather.longitude, -180, 180);
  const weatherConfigured = weatherLatitude !== null && weatherLongitude !== null && (weatherMode === 'coordinates' || weatherCity.length > 0);

  return {
    clock: {
      enabled: boolean(clock.enabled, defaults.clock.enabled),
      hour12: boolean(clock.hour12, defaults.clock.hour12),
      showSeconds: boolean(clock.showSeconds, defaults.clock.showSeconds),
      size: CLOCK_SIZES.has(clock.size as string) ? clock.size as WidgetSettings['clock']['size'] : defaults.clock.size,
      scale: number(clock.scale, legacyClockScale(clock.size, defaults.clock.scale), CLOCK_SCALE_MIN, CLOCK_SCALE_MAX),
      position: CLOCK_POSITIONS.has(clock.position as string) ? clock.position as WidgetSettings['clock']['position'] : defaults.clock.position
    },
    date: {
      enabled: boolean(date.enabled, defaults.date.enabled),
      format: DATE_FORMATS.has(date.format as string)
        ? date.format as WidgetSettings['date']['format']
        : defaults.date.format,
      locale: string(date.locale, defaults.date.locale),
      showLunar: boolean(date.showLunar, defaults.date.showLunar)
    },
    weather: {
      enabled: weatherConfigured && boolean(weather.enabled, defaults.weather.enabled),
      mode: weatherMode,
      city: weatherCity,
      latitude: weatherLatitude,
      longitude: weatherLongitude,
      animated: boolean(weather.animated, defaults.weather.animated)
    },
    search: searchSettings,
    shortcuts: {
      enabled: boolean(shortcuts.enabled, defaults.shortcuts.enabled),
      maxVisible: shortcutVisibleLimit(shortcuts.maxVisible, defaults.shortcuts.maxVisible),
      scale: boundedShortcutDockScale(shortcuts.scale as number, defaults.shortcuts.scale)
    }
  };
}

function migrateSearch(
  value: UnknownRecord,
  defaults: WidgetSettings['search']
): WidgetSettings['search'] {
  const enabled = boolean(value.enabled, defaults.enabled);
  if (value.engine === 'custom') {
    const customTemplate = string(value.customTemplate);
    if (validateSearchTemplate(customTemplate)) return { ...defaults, enabled };
    return { enabled, engine: 'custom', customTemplate };
  }

  if (SEARCH_ENGINES.has(value.engine as string)) {
    return {
      enabled,
      engine: value.engine as Exclude<WidgetSettings['search']['engine'], 'custom'>
    };
  }
  return { ...defaults, enabled };
}

function shortcutVisibleLimit(value: unknown, fallback: WidgetSettings['shortcuts']['maxVisible']): WidgetSettings['shortcuts']['maxVisible'] {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(12, Math.max(3, value)) as WidgetSettings['shortcuts']['maxVisible']
    : fallback;
}

function positiveSafeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(100_000, value)
    : fallback;
}

function coordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function migrateBase(value: UnknownRecord): Omit<SourceBase, 'type'> | undefined {
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    enabled: boolean(value.enabled, true),
    createdAt: number(value.createdAt, 0, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: number(value.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function exactOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    try { const url = new URL(item); if (url.protocol === 'https:' && !url.username && !url.password && item === `${url.origin}/*`) output.add(item); } catch { /* ignore */ }
  }
  return [...output];
}

function webDavFolderPath(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const segments = value.filter((item): item is string => typeof item === 'string');
  return segments.length === value.length && segments.every(isSafeWebDavDirectoryName) ? segments : [];
}

function fieldMap(value: unknown): JsonApiSourceConfig['fields'] | undefined {
  if (!isRecord(value)) return undefined;
  const imageUrl = nonEmptyString(value.imageUrl);
  if (!imageUrl) return undefined;
  const title = nonEmptyString(value.title);
  const author = nonEmptyString(value.author);
  const stableId = nonEmptyString(value.stableId);
  const sourcePage = nonEmptyString(value.sourcePage);
  const width = nonEmptyString(value.width);
  const height = nonEmptyString(value.height);
  return {
    imageUrl,
    ...(stableId ? { stableId } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(sourcePage ? { sourcePage } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function migrateDirectEntry(value: unknown): DirectEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const url = httpsUrl(value.url);
  if (!id || !url) return undefined;
  const label = nonEmptyString(value.label);
  return { id, url, ...(label ? { label } : {}) };
}

function migrateSource(value: unknown): SourceConfig | undefined {
  if (!isRecord(value)) return undefined;
  const base = migrateBase(value);
  if (!base) return undefined;

  switch (value.type) {
    case 'local':
      return { ...base, type: 'local', includeSubdirectories: boolean(value.includeSubdirectories, false) };
    case 'webdav': {
      const url = httpsUrl(value.url);
      const username = nonEmptyString(value.username);
      if (!url || !username || typeof value.password !== 'string') return undefined;
      return {
        ...base, type: 'webdav', url, username, password: value.password,
        folderPath: webDavFolderPath(value.folderPath),
        includeSubdirectories: boolean(value.includeSubdirectories, false)
      };
    }
    case 'direct': {
      if (!Array.isArray(value.entries)) return undefined;
      const entries = uniqueById(value.entries.map(migrateDirectEntry).filter((entry): entry is DirectEntry => Boolean(entry)));
      return { ...base, type: 'direct', entries };
    }
    case 'json-api': {
      const endpoint = httpsUrl(value.endpoint);
      const arrayPath = nonEmptyString(value.arrayPath);
      const fields = fieldMap(value.fields);
      if (!endpoint || !arrayPath || !fields) return undefined;
      const pageParam = nonEmptyString(value.pageParam);
      return {
        ...base,
        type: 'json-api',
        endpoint,
        headers: stringRecord(value.headers),
        arrayPath,
        fields,
        startingPage: positiveSafeInteger(value.startingPage, 1),
        authorizedImageOrigins: exactOrigins(value.authorizedImageOrigins),
        ...(pageParam ? { pageParam } : {})
      };
    }
    case 'tmdb': {
      const token = nonEmptyString(value.token);
      if (!token) return undefined;
      const discoverFilters: Record<string, string | number | boolean> = {};
      if (isRecord(value.discoverFilters)) {
        for (const [key, item] of Object.entries(value.discoverFilters)) {
          if (typeof item === 'string' || typeof item === 'boolean') {
            discoverFilters[key] = item;
          } else if (typeof item === 'number' && Number.isFinite(item)) {
            discoverFilters[key] = Math.min(1_000_000, Math.max(-1_000_000, item));
          }
        }
      }
      if (value.media === 'movie' && TMDB_MOVIE_FEEDS.has(value.feed as string)) {
        return {
          ...base, type: 'tmdb', token, media: 'movie',
          feed: value.feed as TmdbMovieSourceConfig['feed'], discoverFilters
        };
      }
      if (value.media === 'tv' && TMDB_TV_FEEDS.has(value.feed as string)) {
        return {
          ...base, type: 'tmdb', token, media: 'tv',
          feed: value.feed as TmdbTvSourceConfig['feed'], discoverFilters
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function migrateShortcuts(value: unknown): Shortcut[] {
  if (!Array.isArray(value)) return [];
  return uniqueById(value.flatMap((item): Shortcut[] => {
    if (!isRecord(item)) return [];
    const id = nonEmptyString(item.id);
    const title = typeof item.title === 'string' ? canonicalShortcutTitle(item.title) : null;
    const url = typeof item.url === 'string' ? canonicalShortcutUrl(item.url) : null;
    if (!id || !title || !url) return [];
    const customIcon = typeof item.customIcon === 'string' && isSafeShortcutIcon(item.customIcon) ? item.customIcon : undefined;
    return [{ id, title, url, ...(customIcon ? { customIcon } : {}) }];
  })).slice(0, MAX_SHORTCUTS);
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => { if (seen.has(value.id)) return false; seen.add(value.id); return true; });
}

/** Converts untrusted persisted data from any previous schema to complete v1 settings. */
export function migrateSettings(value: unknown): PicTabSettings {
  const settings = cloneDefaults();
  if (!isRecord(value)) return settings;

  settings.interfaceLanguage = INTERFACE_LANGUAGES.has(value.interfaceLanguage as string)
    ? value.interfaceLanguage as PicTabSettings['interfaceLanguage']
    : DEFAULT_SETTINGS.interfaceLanguage;
  settings.appearance = migrateAppearance(value.appearance);
  settings.widgets = migrateWidgets(value.widgets);
  settings.sources = Array.isArray(value.sources)
    ? uniqueById(value.sources.map(migrateSource).filter((source): source is SourceConfig => Boolean(source)))
    : [];
  settings.shortcuts = migrateShortcuts(value.shortcuts);

  const activeSourceId = nonEmptyString(value.activeSourceId);
  settings.activeSourceId = activeSourceId && settings.sources.some((source) => source.id === activeSourceId)
    ? activeSourceId
    : null;
  return settings;
}

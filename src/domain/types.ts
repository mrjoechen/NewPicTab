export type TransitionName = 'fade' | 'slide' | 'ken-burns' | 'none';
export type RotationOrder = 'sequential' | 'shuffle';
export type InterfaceLanguage = 'zh-CN' | 'en-US';
export type BuiltInSearchEngine = 'google' | 'bing' | 'duckduckgo' | 'baidu';
export type ShortcutVisibleLimit = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type WidgetPosition = 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface SourceBase {
  id: string;
  name: string;
  type: SourceType;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LocalSourceConfig extends SourceBase {
  type: 'local';
  includeSubdirectories: boolean;
}

export interface WebDavSourceConfig extends SourceBase {
  type: 'webdav';
  /** Canonical WebDAV root directory URL. Selected folders are stored separately. */
  url: string;
  /** Safe decoded folder names relative to url. */
  folderPath?: string[];
  username: string;
  /** Local-only secret. NewPicTab settings are never written to storage.sync. */
  password: string;
  includeSubdirectories: boolean;
}

export interface DirectSourceConfig extends SourceBase {
  type: 'direct';
  entries: DirectEntry[];
}

export interface DirectEntry {
  id: string;
  url: string;
  label?: string;
}

export interface JsonApiSourceConfig extends SourceBase {
  type: 'json-api';
  endpoint: string;
  /** Local-only request headers; may contain credentials. */
  headers: Record<string, string>;
  arrayPath: string;
  fields: {
    imageUrl: string;
    stableId?: string;
    title?: string;
    author?: string;
    sourcePage?: string;
    width?: string;
    height?: string;
  };
  startingPage: number;
  pageParam?: string;
  /** Exact HTTPS origins approved after parsing a connection-test response. */
  authorizedImageOrigins: string[];
}

interface TmdbSourceBase extends SourceBase {
  type: 'tmdb';
  /** Local-only TMDB API token. */
  token: string;
  discoverFilters: TmdbDiscoverFilters;
}

export interface TmdbDiscoverFilters extends Record<string, string | number | boolean | undefined> {
  language?: string;
  region?: string;
  with_genres?: string;
  page?: number;
  primary_release_year?: number;
  first_air_date_year?: number;
  'vote_average.gte'?: number;
  sort_by?: string;
  'primary_release_date.gte'?: string;
  'primary_release_date.lte'?: string;
  'first_air_date.gte'?: string;
  'first_air_date.lte'?: string;
}

export interface TmdbMovieSourceConfig extends TmdbSourceBase {
  media: 'movie';
  feed: 'popular' | 'top-rated' | 'now-playing' | 'upcoming' | 'trending-daily' | 'trending-weekly' | 'discover';
}

export interface TmdbTvSourceConfig extends TmdbSourceBase {
  media: 'tv';
  feed: 'popular' | 'top-rated' | 'airing-today' | 'on-the-air' | 'trending-daily' | 'trending-weekly' | 'discover';
}

export type TmdbSourceConfig = TmdbMovieSourceConfig | TmdbTvSourceConfig;

export type SourceType = 'local' | 'webdav' | 'direct' | 'json-api' | 'tmdb';
export type SourceConfig =
  | LocalSourceConfig
  | WebDavSourceConfig
  | DirectSourceConfig
  | JsonApiSourceConfig
  | TmdbSourceConfig;

export interface AppearanceSettings {
  transition: TransitionName;
  transitionMs: number;
  order: RotationOrder;
  changeOn: 'new-tab' | 'interval';
  intervalMinutes: number;
}

export interface WidgetSettings {
  clock: { enabled: boolean; hour12: boolean; showSeconds: boolean; size: 'compact' | 'default' | 'large'; scale: number; position: WidgetPosition };
  date: { enabled: boolean; format: 'short' | 'medium' | 'long' | 'full'; locale: string; showLunar: boolean };
  weather: {
    enabled: boolean;
    mode: 'city' | 'coordinates';
    city: string;
    latitude: number | null;
    longitude: number | null;
    animated: boolean;
  };
  search: BuiltInSearchSettings | CustomSearchSettings;
  shortcuts: { enabled: boolean; maxVisible: ShortcutVisibleLimit; scale: number };
}

export interface BuiltInSearchSettings {
  enabled: boolean;
  engine: BuiltInSearchEngine;
}

export interface CustomSearchSettings {
  enabled: boolean;
  engine: 'custom';
  customTemplate: string;
}

export interface Shortcut {
  id: string;
  title: string;
  url: string;
  customIcon?: string;
}

export interface NewPicTabSettings {
  version: 1;
  interfaceLanguage: InterfaceLanguage;
  activeSourceId: string | null;
  sources: SourceConfig[];
  appearance: AppearanceSettings;
  widgets: WidgetSettings;
  shortcuts: Shortcut[];
}

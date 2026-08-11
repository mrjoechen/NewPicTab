import type { SourceConfig } from '../domain/types';
import type { ConnectionTestResult, ListImagesResult, SourceError } from '../sources/adapter';
import type { TmdbGenre } from '../sources/tmdb';
import type { CityResult, WeatherSnapshot } from '../weather/openMeteo';

export type BackgroundRequest =
  | { system: 'clear-all-data' }
  | { source: 'test'; config: SourceConfig }
  | { source: 'list'; config: SourceConfig; offset?: number; limit?: number; cacheOnly?: boolean; protectedEntryIds?: string[]; forceRefresh?: boolean }
  | { source: 'refresh'; config: SourceConfig }
  | { source: 'tmdb-metadata'; config: SourceConfig }
  | { source: 'delete'; sourceId: string }
  | { source: 'clear-cache' }
  | { source: 'clear-source-cache'; sourceId: string }
  | { weather: 'city-search'; query: string; locale?: string }
  | { weather: 'reverse-geocode'; latitude: number; longitude: number; locale?: string }
  | { weather: 'current'; location: string; latitude: number; longitude: number; locale?: string };

export type BackgroundFailureCode = SourceError['code'] | 'unsupported';
export type BackgroundFailure = { ok: false; code: BackgroundFailureCode; message: string; failures?: string[] };
export type WeatherBackgroundResponse = { ok: true; cities: CityResult[] } | { ok: true; location: string } | { ok: true; weather: WeatherSnapshot } | BackgroundFailure;
export type BackgroundResponse = ConnectionTestResult | ListImagesResult | { ok: true } | { ok: true; genres: TmdbGenre[]; languages: string[]; regions: string[] } | WeatherBackgroundResponse | BackgroundFailure;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (!isRecord(value)) return false;
  if (value.system === 'clear-all-data') return Object.keys(value).length === 1;
  if (typeof value.source === 'string') {
    return (value.source === 'test' || value.source === 'list' || value.source === 'refresh' || value.source === 'tmdb-metadata') && isSourceEnvelope(value.config)
      || value.source === 'delete' && typeof value.sourceId === 'string' && value.sourceId.trim().length > 0
      || value.source === 'clear-cache'
      || value.source === 'clear-source-cache' && typeof value.sourceId === 'string' && value.sourceId.trim().length > 0;
  }
  const validLocale = value.locale === undefined || typeof value.locale === 'string' && value.locale.length <= 35;
  return value.weather === 'city-search'
      && typeof value.query === 'string'
      && value.query.trim().length >= 2
      && value.query.trim().length <= 100
      && validLocale
    || value.weather === 'reverse-geocode'
      && validCoordinates(value.latitude, value.longitude)
      && validLocale
    || value.weather === 'current'
      && typeof value.location === 'string'
      && value.location.trim().length > 0
      && value.location.length <= 160
      && validCoordinates(value.latitude, value.longitude)
      && validLocale;
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isSourceEnvelope(value: unknown): boolean { return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0 && (value.type === 'local' || value.type === 'direct' || value.type === 'json-api' || value.type === 'webdav' || value.type === 'tmdb'); }
function validCoordinates(latitude: unknown, longitude: unknown): boolean { return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180; }

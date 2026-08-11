import type { TmdbSourceConfig } from '../domain/types';
import type { ConfigValidationResult, ConnectionTestResult, ImageEntry, ListImagesResult, SourceAdapter, SourceError } from './adapter';
import { HttpRequestError, fetchJson, type SourceFetch } from './http';
import { PROVIDERS } from './providers';
import { boundedRemoteText } from './text';

export type TmdbFetch = SourceFetch;
export interface TmdbSourceAdapterOptions { timeoutMs?: number; maxBytes?: number; }
export interface TmdbGenre { readonly id: number; readonly name: string; }
export interface TmdbMetadata {
  readonly genres: readonly TmdbGenre[];
  readonly languages: readonly string[];
  readonly regions: readonly string[];
}
interface ConnectionState { readonly fingerprint: string; readonly imageBase: string; }
interface MetadataState extends TmdbMetadata { readonly fingerprint: string; }

const API_ROOT = 'https://api.themoviedb.org';
const LIST_LIMIT = 100;

export class TmdbSourceAdapter implements SourceAdapter<TmdbSourceConfig> {
  private readonly fetcher: TmdbFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes?: number;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private readonly connections = new Map<string, ConnectionState>();
  private readonly metadata = new Map<string, MetadataState>();
  private disposed = false;

  constructor(fetcher: TmdbFetch = defaultFetch, options: TmdbSourceAdapterOptions = {}) {
    this.fetcher = fetcher;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes;
  }

  validateConfig(config: unknown): ConfigValidationResult { return isTmdbConfig(config) ? { ok: true } : { ok: false, error: validationError() }; }

  async testConnection(config: TmdbSourceConfig): Promise<ConnectionTestResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return { ok: false, error: validation.error };
    if (this.disposed) return { ok: false, error: cancelledError() };
    this.invalidate(config.id);
    const connected = await this.ensureConnected(config);
    return 'error' in connected ? { ok: false, error: connected.error } : { ok: true };
  }

  async listImages(config: TmdbSourceConfig): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return failed(validation.error);
    if (this.disposed) return failed(cancelledError());
    const connected = await this.ensureConnected(config);
    if ('error' in connected) return failed(connected.error);
    const request = this.start(config.id);
    try {
      const endpoint = listEndpoint(config);
      if (!endpoint) return failed(validationError());
      const url = new URL(endpoint, API_ROOT);
      appendListParameters(url, config);
      const result = await this.request(config, `${url.pathname}${url.search}`, request.controller);
      if ('error' in result) return failed(result.error);
      if (!this.isCurrent(config.id, request.generation) || request.controller.signal.aborted) return failed(cancelledError());
      if (!isRecord(result.value) || !Array.isArray(result.value.results)) return failed({ code: 'parse', message: 'TMDB returned an invalid image list.' });
      const warnings: SourceError[] = [];
      const output: ImageEntry[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < Math.min(result.value.results.length, LIST_LIMIT); index += 1) {
        const item = mapImage(result.value.results[index], config, connected.imageBase);
        if (!item) { warnings.push({ code: 'validation', message: 'A TMDB result without a safe backdrop was skipped.', field: 'imageUrl', itemIndex: index, reason: 'invalid-url' }); continue; }
        if (seen.has(item.id)) { warnings.push({ code: 'validation', message: 'A duplicate TMDB backdrop was skipped.', itemIndex: index }); continue; }
        seen.add(item.id); output.push(item);
      }
      if (result.value.results.length > LIST_LIMIT) warnings.push({ code: 'parse', message: `Only the first ${LIST_LIMIT} TMDB results were used.` });
      return output.length ? succeeded(output, warnings) : failed({ code: 'empty', message: 'TMDB returned no safe backdrop images.' }, warnings);
    } finally { this.finish(config.id, request.controller); }
  }

  async refreshMetadata(config: TmdbSourceConfig): Promise<void> {
    const validation = this.validateConfig(config);
    if (!validation.ok) throw validation.error;
    if (this.disposed) throw cancelledError();
    const connected = await this.ensureConnected(config);
    if ('error' in connected) throw connected.error;
    const request = this.start(config.id);
    try {
      const [genreResult, languageResult, regionResult] = await Promise.all([
        this.request(config, `/3/genre/${config.media}/list`, request.controller),
        this.request(config, '/3/configuration/primary_translations', request.controller),
        this.request(config, '/3/configuration/countries', request.controller)
      ]);
      if ('error' in genreResult) throw genreResult.error;
      if ('error' in languageResult) throw languageResult.error;
      if ('error' in regionResult) throw regionResult.error;
      if (!this.isCurrent(config.id, request.generation) || request.controller.signal.aborted) throw cancelledError();
      const genres = parseGenres(genreResult.value);
      const languages = parseLanguageCodes(languageResult.value);
      const regions = parseRegionCodes(regionResult.value);
      if (!genres || !languages || !regions) throw { code: 'parse', message: 'TMDB returned invalid configuration options.' } satisfies SourceError;
      this.metadata.set(config.id, { fingerprint: configFingerprint(config), genres, languages, regions });
    } finally { this.finish(config.id, request.controller); }
  }

  getMetadata(config: TmdbSourceConfig): TmdbMetadata {
    const state = this.metadata.get(config.id);
    return state?.fingerprint === configFingerprint(config)
      ? { genres: state.genres, languages: state.languages, regions: state.regions }
      : { genres: [], languages: [], regions: [] };
  }
  getGenres(config: TmdbSourceConfig): readonly TmdbGenre[] { return this.getMetadata(config).genres; }
  async getAttribution(entry: ImageEntry): Promise<string | undefined> { return entry.attribution; }
  async deleteSource(sourceId: string): Promise<void> { this.invalidate(sourceId); }
  dispose(): void { this.disposed = true; for (const sourceId of new Set([...this.controllers.keys(), ...this.connections.keys(), ...this.metadata.keys()])) this.invalidate(sourceId); this.connections.clear(); this.metadata.clear(); }

  private async request(config: TmdbSourceConfig, path: string, controller: AbortController): Promise<{ value: unknown } | { error: SourceError }> {
    let fetched: { response: Response; value: unknown };
    try { fetched = await fetchJson(this.fetcher, new URL(path, API_ROOT).href, { method: 'GET', headers: new Headers({ Accept: 'application/json', Authorization: `Bearer ${config.token.trim()}` }) }, { timeoutMs: this.timeoutMs, controller, ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }) }); }
    catch (error) { return { error: requestError(error) }; }
    return fetched.response.ok ? { value: fetched.value } : { error: responseError(fetched.response) };
  }
  private async ensureConnected(config: TmdbSourceConfig): Promise<ConnectionState | { error: SourceError }> {
    const cached = this.connectionFor(config); if (cached) return cached;
    const request = this.start(config.id);
    try {
      const result = await this.request(config, '/3/configuration', request.controller);
      if ('error' in result) return result;
      if (!this.isCurrent(config.id, request.generation) || request.controller.signal.aborted) return { error: cancelledError() };
      const imageBase = selectImageBase(result.value);
      if (!imageBase) return { error: { code: 'parse', message: 'TMDB returned no safe HTTPS backdrop image configuration.' } };
      const state = { fingerprint: configFingerprint(config), imageBase }; this.connections.set(config.id, state); return state;
    } finally { this.finish(config.id, request.controller); }
  }
  private start(sourceId: string): { generation: number; controller: AbortController } { const controller = new AbortController(); const group = this.controllers.get(sourceId) ?? new Set<AbortController>(); group.add(controller); this.controllers.set(sourceId, group); return { generation: this.generations.get(sourceId) ?? 0, controller }; }
  private finish(sourceId: string, controller: AbortController): void { const group = this.controllers.get(sourceId); group?.delete(controller); if (group?.size === 0) this.controllers.delete(sourceId); }
  private abortSource(sourceId: string): void { for (const controller of this.controllers.get(sourceId) ?? []) controller.abort(); }
  private invalidate(sourceId: string): void { this.abortSource(sourceId); this.advance(sourceId); this.connections.delete(sourceId); this.metadata.delete(sourceId); }
  private connectionFor(config: TmdbSourceConfig): ConnectionState | undefined { const state = this.connections.get(config.id); return state?.fingerprint === configFingerprint(config) ? state : undefined; }
  private advance(sourceId: string): number { const next = (this.generations.get(sourceId) ?? 0) + 1; this.generations.set(sourceId, next); return next; }
  private isCurrent(sourceId: string, generation: number): boolean { return !this.disposed && (this.generations.get(sourceId) ?? 0) === generation; }
}

function isTmdbConfig(value: unknown): value is TmdbSourceConfig {
  if (!isRecord(value)) return false;
  const base = typeof value.id === 'string' && value.id.trim() && typeof value.name === 'string' && value.name.trim() && value.type === 'tmdb' && typeof value.enabled === 'boolean' && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && typeof value.token === 'string' && value.token.trim().length > 0 && isRecord(value.discoverFilters);
  if (!base || (value.media !== 'movie' && value.media !== 'tv') || typeof value.feed !== 'string') return false;
  return value.media === 'movie' ? ['popular', 'top-rated', 'now-playing', 'upcoming', 'trending-daily', 'trending-weekly', 'discover'].includes(value.feed) : ['popular', 'top-rated', 'airing-today', 'on-the-air', 'trending-daily', 'trending-weekly', 'discover'].includes(value.feed);
}
function listEndpoint(config: TmdbSourceConfig): string | undefined {
  if (config.feed === 'trending-daily') return `/3/trending/${config.media}/day`;
  if (config.feed === 'trending-weekly') return `/3/trending/${config.media}/week`;
  if (config.feed === 'discover') return `/3/discover/${config.media}`;
  const movie = { popular: 'popular', 'top-rated': 'top_rated', 'now-playing': 'now_playing', upcoming: 'upcoming' } as const;
  const tv = { popular: 'popular', 'top-rated': 'top_rated', 'airing-today': 'airing_today', 'on-the-air': 'on_the_air' } as const;
  return config.media === 'movie' && config.feed in movie ? `/3/movie/${movie[config.feed as keyof typeof movie]}` : config.media === 'tv' && config.feed in tv ? `/3/tv/${tv[config.feed as keyof typeof tv]}` : undefined;
}
function appendListParameters(url: URL, config: TmdbSourceConfig): void {
  const values = config.discoverFilters;
  appendPage(url, values.page);
  appendString(url, 'language', values.language);
  if (config.media === 'movie' && !config.feed.startsWith('trending-')) appendString(url, 'region', values.region);
  if (config.feed !== 'discover') return;
  appendString(url, 'with_genres', values.with_genres);
  if (config.media === 'movie') appendInteger(url, 'primary_release_year', values.primary_release_year);
  else appendInteger(url, 'first_air_date_year', values.first_air_date_year);
  if (config.media === 'movie') {
    appendDate(url, 'primary_release_date.gte', values['primary_release_date.gte']);
    appendDate(url, 'primary_release_date.lte', values['primary_release_date.lte']);
  } else {
    appendDate(url, 'first_air_date.gte', values['first_air_date.gte']);
    appendDate(url, 'first_air_date.lte', values['first_air_date.lte']);
  }
  appendNumber(url, 'vote_average.gte', values['vote_average.gte']);
  appendString(url, 'sort_by', values.sort_by);
}
function appendPage(url: URL, value: unknown): void { if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 500) url.searchParams.set('page', String(value)); }
function appendInteger(url: URL, key: string, value: unknown): void { if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 9999) url.searchParams.set(key, String(value)); }
function appendNumber(url: URL, key: string, value: unknown): void { if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10) url.searchParams.set(key, String(value)); }
function appendString(url: URL, key: string, value: unknown): void { if (typeof value === 'string' && value.trim() && value.length <= 100) url.searchParams.set(key, value.trim()); }
function appendDate(url: URL, key: string, value: unknown): void { if (typeof value === 'string' && isStrictDate(value)) url.searchParams.set(key, value); }
function isStrictDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function selectImageBase(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.images) || typeof value.images.secure_base_url !== 'string' || !Array.isArray(value.images.backdrop_sizes)) return undefined;
  const base = value.images.secure_base_url;
  let parsed: URL;
  try { parsed = new URL(base); } catch { return undefined; }
  const authority = base.match(/^https:\/\/([^/]+)/)?.[1];
  if (authority !== 'image.tmdb.org' || parsed.protocol !== 'https:' || parsed.origin !== 'https://image.tmdb.org' || parsed.hostname !== 'image.tmdb.org' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/t/p' && parsed.pathname !== '/t/p/')) return undefined;
  const allowed = new Set(value.images.backdrop_sizes.filter((size): size is string => typeof size === 'string'));
  const size = ['w1280', 'w780', 'w500', 'w300', 'original'].find((candidate) => allowed.has(candidate));
  return size ? `https://image.tmdb.org/t/p/${size}/` : undefined;
}
function mapImage(value: unknown, config: TmdbSourceConfig, base: string): ImageEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 0 || !isSafeBackdrop(value.backdrop_path)) return undefined;
  const path = value.backdrop_path;
  const url = new URL(path.slice(1), base).href;
  const title = text(value.overview) ?? text(value.title) ?? text(value.name);
  const type = config.media === 'movie' ? 'movie' : 'tv';
  return { id: `tmdb:${config.media}:${id}`, sourceId: config.id, url, ...(title ? { description: title } : {}), sourceUrl: `https://www.themoviedb.org/${type}/${id}`, attribution: PROVIDERS.tmdb.attribution };
}
function isSafeBackdrop(value: unknown): value is string {
  return typeof value === 'string' && /^\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(value);
}
function parseGenres(value: unknown): readonly TmdbGenre[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.genres)) return undefined;
  const genres = new Map<number, TmdbGenre>();
  for (const genre of value.genres) {
    if (!isRecord(genre) || !Number.isSafeInteger(genre.id) || typeof genre.id !== 'number' || genre.id < 0 || typeof genre.name !== 'string') continue;
    const name = boundedRemoteText(genre.name);
    if (name) genres.set(genre.id, { id: genre.id, name });
  }
  return Object.freeze([...genres.values()].sort((left, right) => left.id - right.id || left.name.localeCompare(right.name)));
}
function parseLanguageCodes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const languages = new Set<string>();
  for (const language of value) if (typeof language === 'string' && /^[a-z]{2,3}-[A-Z]{2}$/.test(language)) languages.add(language);
  return Object.freeze([...languages].sort((left, right) => left.localeCompare(right)));
}
function parseRegionCodes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const regions = new Set<string>();
  for (const region of value) if (isRecord(region) && typeof region.iso_3166_1 === 'string' && /^[A-Z]{2}$/.test(region.iso_3166_1)) regions.add(region.iso_3166_1);
  return Object.freeze([...regions].sort((left, right) => left.localeCompare(right)));
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === 'string' ? boundedRemoteText(value) : undefined; }
function succeeded(images: ImageEntry[], warnings: SourceError[]): ListImagesResult { return { ok: true, images: images as [ImageEntry, ...ImageEntry[]], ...(warnings.length ? { warnings } : {}) }; }
function failed(error: SourceError, warnings?: SourceError[]): ListImagesResult { return { ok: false, images: [], error, ...(warnings?.length ? { warnings } : {}) }; }
function validationError(): SourceError { return { code: 'validation', message: 'TMDB sources require a supported media/feed selection and a non-empty API read access token.' }; }
function retestError(): SourceError { return { code: 'validation', message: 'TMDB configuration changed or is untested; retest required.' }; }
function configFingerprint(config: TmdbSourceConfig): string { return JSON.stringify([config.id, config.token.trim(), config.media]); }
function cancelledError(): SourceError { return { code: 'network', message: 'The TMDB request was cancelled.', retryable: true }; }
function requestError(error: unknown): SourceError { if (error instanceof SyntaxError) return { code: 'parse', message: 'TMDB returned invalid JSON.' }; if (error instanceof HttpRequestError) return error.kind === 'too-large' ? { code: 'parse', message: 'The TMDB response is too large.' } : { code: 'network', message: error.kind === 'redirect' ? 'TMDB returned an unsupported redirect.' : '暂时无法连接 TMDB API，请检查网络或代理后重试。', retryable: true }; return { code: 'network', message: '暂时无法连接 TMDB API，请检查网络或代理后重试。', retryable: true }; }
function responseError(response: Response): SourceError { if (response.status === 401 || response.status === 403) return { code: 'auth', message: 'TMDB rejected the request credentials.' }; if (response.status === 429) return { code: 'rate-limit', message: 'TMDB rate limit was reached.', retryable: true, retryAfterMs: retryAfter(response) }; return { code: 'http', status: response.status, message: 'TMDB returned an HTTP error.', retryable: response.status >= 500 }; }
function retryAfter(response: Response): number | undefined { const value = response.headers.get('Retry-After'); if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000; const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined; }
const defaultFetch: TmdbFetch = (url, init) => fetch(url, init);

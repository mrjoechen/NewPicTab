import type { JsonApiSourceConfig } from '../domain/types';
import type { ConfigValidationResult, ConnectionTestResult, ImageDimensions, ImageEntry, ListImagesResult, SourceAdapter, SourceError } from './adapter';
import { HttpRequestError, fetchJson } from './http';
import { getJsonPath, parseJsonPath } from './jsonPath';
import { opaqueImageId } from '../lib/crypto';
import { boundedRemoteText } from './text';

export type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface JsonApiAdapterOptions { timeoutMs?: number; maxBytes?: number; }
const LIST_LIMIT = 500;

export class JsonApiSourceAdapter implements SourceAdapter<JsonApiSourceConfig> {
  private readonly fetcher: JsonFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number | undefined;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(fetcher: JsonFetch = defaultFetch, options: JsonApiAdapterOptions = {}) { this.fetcher = fetcher; this.timeoutMs = options.timeoutMs ?? 15_000; this.maxBytes = options.maxBytes; }
  validateConfig(config: unknown): ConfigValidationResult { return isJsonApiConfig(config) ? { ok: true } : { ok: false, error: validationError() }; }
  async testConnection(config: JsonApiSourceConfig): Promise<ConnectionTestResult> {
    // Return every bounded mapped URL so the user gesture can authorize every exact image origin;
    // the editor independently limits how many thumbnails it renders.
    const result = await this.load(config, LIST_LIMIT, false);
    const discovery = safeDiscovery(result.images);
    return result.ok
      ? { ok: true, protected: true, ...discovery, ...(result.warnings ? { warnings: result.warnings } : {}) }
      : { ok: false, protected: true, error: result.error, ...discovery, ...(result.warnings ? { warnings: result.warnings } : {}) };
  }
  async listImages(config: JsonApiSourceConfig): Promise<ListImagesResult> { return this.load(config, LIST_LIMIT, true); }
  async refreshMetadata(config: JsonApiSourceConfig): Promise<void> { this.abortSource(config.id); this.advanceGeneration(config.id); }
  async getAttribution(entry: ImageEntry): Promise<string | undefined> { return entry.attribution; }
  async deleteSource(sourceId: string): Promise<void> { this.abortSource(sourceId); this.advanceGeneration(sourceId); }
  dispose(): void { this.disposed = true; for (const sourceId of this.controllers.keys()) { this.abortSource(sourceId); this.advanceGeneration(sourceId); } }

  private async load(config: JsonApiSourceConfig, maxItems: number, reportLimit: boolean): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return failed(validation.error);
    if (this.disposed) return failed(cancelledError());
    const generation = this.advanceGeneration(config.id);
    const controller = this.register(config.id);
    try {
      const url = new URL(config.endpoint);
      if (config.pageParam) url.searchParams.set(config.pageParam, String(config.startingPage));
      let result: { response: Response; value: unknown };
      try { result = await fetchJson(this.fetcher, url.href, { method: 'GET', headers: new Headers(config.headers) }, { timeoutMs: this.timeoutMs, controller, ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }) }); }
      catch (error) { return failed(httpError(error)); }
      if (!this.isCurrent(config.id, generation) || controller.signal.aborted) return failed(cancelledError());
      if (!result.response.ok) return failed(responseError(result.response));
      const selected = getJsonPath(result.value, config.arrayPath);
      if (!Array.isArray(selected)) return failed(parseError('The configured image list is not an array.'));
      const warnings: SourceError[] = [];
      if (reportLimit && selected.length > maxItems) warnings.push({ code: 'parse', message: `Only the first ${maxItems} images from this response were used.` });
      const images: ImageEntry[] = [];
      const seen = new Set<string>();
      const seenUrls = new Set<string>();
      for (let index = 0; index < Math.min(selected.length, maxItems); index += 1) {
        const mapped = await mapItem(selected[index], config, index);
        if ('error' in mapped) warnings.push(mapped.error);
        else {
          warnings.push(...mapped.warnings);
          if (seen.has(mapped.image.id) || seenUrls.has(mapped.image.url!)) warnings.push({ code: 'validation', message: 'A duplicate image was skipped.', itemIndex: index });
          else { seen.add(mapped.image.id); seenUrls.add(mapped.image.url!); images.push(mapped.image); }
        }
      }
      if (!this.isCurrent(config.id, generation) || controller.signal.aborted) return failed(cancelledError());
      return images.length ? succeeded(images, warnings) : failed({ code: 'empty', message: 'No valid HTTPS images were found in the response.' }, warnings);
    } finally { this.unregister(config.id, controller); }
  }
  private register(sourceId: string): AbortController { const controller = new AbortController(); const set = this.controllers.get(sourceId) ?? new Set(); set.add(controller); this.controllers.set(sourceId, set); return controller; }
  private unregister(sourceId: string, controller: AbortController): void { const set = this.controllers.get(sourceId); set?.delete(controller); if (set?.size === 0) this.controllers.delete(sourceId); }
  private abortSource(sourceId: string): void { for (const controller of this.controllers.get(sourceId) ?? []) controller.abort(); }
  private advanceGeneration(sourceId: string): number { const value = (this.generations.get(sourceId) ?? 0) + 1; this.generations.set(sourceId, value); return value; }
  private isCurrent(sourceId: string, generation: number): boolean { return !this.disposed && this.generations.get(sourceId) === generation; }
}

async function mapItem(item: unknown, config: JsonApiSourceConfig, index: number): Promise<{ image: ImageEntry; warnings: SourceError[] } | { error: SourceError }> {
  if (!item || typeof item !== 'object') return { error: itemError('imageUrl', index, 'missing') };
  const rawImageUrl = getJsonPath(item, config.fields.imageUrl);
  if (rawImageUrl === undefined || rawImageUrl === null || rawImageUrl === '') return { error: itemError('imageUrl', index, 'missing') };
  if (typeof rawImageUrl !== 'string' || !isSafeHttpsUrl(rawImageUrl)) return { error: itemError('imageUrl', index, 'invalid-url') };
  const imageUrl = new URL(rawImageUrl).href;
  const dimensions = mappedDimensions(item, config);
  if ('error' in dimensions) return { error: itemError('width-height', index, 'invalid-dimensions') };
  const sourcePage = optionalStringAt(item, config.fields.sourcePage);
  const warnings: SourceError[] = [];
  const sourceUrl = sourcePage === undefined ? undefined : isSafeHttpsUrl(sourcePage) ? new URL(sourcePage).href : undefined;
  if (sourcePage !== undefined && !sourceUrl) warnings.push({ code: 'validation', message: 'A response item has an invalid HTTPS source page.', field: 'sourcePage', itemIndex: index, reason: 'invalid-url' });
  const description = boundedRemoteText(optionalStringAt(item, config.fields.title));
  const author = boundedRemoteText(optionalStringAt(item, config.fields.author));
  const attribution = boundedRemoteText(author && sourceUrl ? `${author} — ${sourceUrl}` : author ?? sourceUrl);
  const stable = optionalScalarAt(item, config.fields.stableId);
  const identity = JSON.stringify(['json-api', stable ?? imageUrl, imageUrl]);
  return { image: { id: await opaqueImageId(config.id, identity), sourceId: config.id, url: imageUrl, ...(description ? { description } : {}), ...(author ? { author } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(attribution ? { attribution } : {}), ...(dimensions.dimensions ? { dimensions: dimensions.dimensions } : {}) }, warnings };
}
function safeDiscovery(images: readonly ImageEntry[]): Pick<ConnectionTestResult & object, never> & { imageOrigins: string[]; count: number; preview: import('./adapter').SafeImagePreview[] } {
  const origins = new Set<string>();
  for (const entry of images) if ('url' in entry && entry.url) origins.add(`${new URL(entry.url).origin}/*`);
  return { imageOrigins: [...origins], count: images.length, preview: images.slice(0, 6).map(safePreview) };
}
function safePreview(entry: ImageEntry): import('./adapter').SafeImagePreview {
  return { id: entry.id, sourceId: entry.sourceId, ...(safeText(entry.description) ? { description: safeText(entry.description)! } : {}), ...(safeText(entry.author) ? { author: safeText(entry.author)! } : {}), ...(entry.dimensions ? { dimensions: { ...entry.dimensions } } : {}), ...(entry.previewColor ? { previewColor: entry.previewColor } : {}) };
}
function safeText(value: string | undefined): string | undefined { return value && !/(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/)/i.test(value) ? boundedRemoteText(value) : undefined; }
function mappedDimensions(item: object, config: JsonApiSourceConfig): { dimensions?: ImageDimensions } | { error: true } { const width = config.fields.width === undefined ? undefined : getJsonPath(item, config.fields.width); const height = config.fields.height === undefined ? undefined : getJsonPath(item, config.fields.height); if (width === undefined && height === undefined) return {}; return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { dimensions: { width, height } } : { error: true }; }
function optionalStringAt(value: object, path: string | undefined): string | undefined { return path === undefined ? undefined : optionalString(getJsonPath(value, path)); }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value : undefined; }
function optionalScalarAt(value: object, path: string | undefined): string | undefined { if (path === undefined) return undefined; const valueAtPath = getJsonPath(value, path); return (typeof valueAtPath === 'string' && valueAtPath.trim().length > 0) || (typeof valueAtPath === 'number' && Number.isFinite(valueAtPath)) ? String(valueAtPath) : undefined; }
function isJsonApiConfig(value: unknown): value is JsonApiSourceConfig { if (!value || typeof value !== 'object') return false; const config = value as Partial<JsonApiSourceConfig>; return config.type === 'json-api' && validBase(config) && typeof config.endpoint === 'string' && isSafeHttpsUrl(config.endpoint) && validAuthorizedOrigins(config.authorizedImageOrigins) && typeof config.startingPage === 'number' && Number.isSafeInteger(config.startingPage) && config.startingPage > 0 && validHeaders(config.headers) && typeof config.arrayPath === 'string' && validPath(config.arrayPath) && validFields(config.fields) && (config.pageParam === undefined || (typeof config.pageParam === 'string' && config.pageParam.trim().length > 0)); }
function validAuthorizedOrigins(value: unknown): value is string[] { return Array.isArray(value) && value.every((pattern) => { if (typeof pattern !== 'string') return false; try { const url = new URL(pattern.slice(0, -1)); return url.protocol === 'https:' && !url.username && !url.password && pattern.endsWith('/*') && pattern === `${url.origin}/*`; } catch { return false; } }); }
function validBase(config: Partial<JsonApiSourceConfig>): boolean { return typeof config.id === 'string' && config.id.trim().length > 0 && typeof config.name === 'string' && config.name.trim().length > 0 && typeof config.enabled === 'boolean' && Number.isFinite(config.createdAt) && Number.isFinite(config.updatedAt); }
function validHeaders(value: unknown): value is Record<string, string> { if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every((header) => typeof header === 'string')) return false; try { new Headers(value as Record<string, string>); return true; } catch { return false; } }
function validFields(value: unknown): value is JsonApiSourceConfig['fields'] { return !!value && typeof value === 'object' && typeof (value as { imageUrl?: unknown }).imageUrl === 'string' && Object.values(value as Record<string, unknown>).every((path) => path === undefined || (typeof path === 'string' && validPath(path))); }
function validPath(path: string): boolean { try { parseJsonPath(path); return true; } catch { return false; } }
function isSafeHttpsUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
function succeeded(images: ImageEntry[], warnings: SourceError[]): ListImagesResult { return { ok: true, images: images as [ImageEntry, ...ImageEntry[]], ...(warnings.length ? { warnings } : {}) }; }
function failed(error: SourceError, warnings?: SourceError[]): ListImagesResult { return { ok: false, images: [], error, ...(warnings?.length ? { warnings } : {}) }; }
function validationError(): SourceError { return { code: 'validation', message: 'JSON API sources require a valid HTTPS endpoint and safe field mappings.' }; }
function cancelledError(): SourceError { return { code: 'network', message: 'The image service request was cancelled.', retryable: true }; }
function itemError(field: SourceError['field'], itemIndex: number, reason: NonNullable<SourceError['reason']>): SourceError { return { code: 'validation', message: reason === 'missing' ? 'A response item is missing its image URL.' : reason === 'invalid-url' ? 'A response item has an invalid HTTPS image URL.' : 'A response item has invalid width or height.', field, itemIndex, reason }; }
function httpError(error: unknown): SourceError { if (error instanceof SyntaxError) return parseError('The image service returned invalid JSON.'); if (error instanceof HttpRequestError) return error.kind === 'too-large' ? { code: 'parse', message: 'The image service response is too large.' } : { code: 'network', message: error.kind === 'redirect' ? 'The image service returned an unsupported redirect.' : 'The image service could not be reached.', retryable: true }; return { code: 'network', message: 'The image service could not be reached.', retryable: true }; }
function parseError(message: string): SourceError { return { code: 'parse', message }; }
function responseError(response: Response): SourceError { if (response.status === 401 || response.status === 403) return { code: 'auth', message: 'The image service rejected the request credentials.' }; if (response.status === 429) return { code: 'rate-limit', message: 'The image service rate limit was reached.', retryable: true, retryAfterMs: retryAfter(response) }; return { code: 'http', status: response.status, message: 'The image service returned an HTTP error.', retryable: response.status >= 500 }; }
function retryAfter(response: Response): number | undefined { const value = response.headers.get('Retry-After'); if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000; const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined; }
const defaultFetch: JsonFetch = (url, init) => fetch(url, init);

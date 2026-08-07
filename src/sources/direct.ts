import type { DirectSourceConfig } from '../domain/types';
import type { ConfigValidationResult, ConnectionTestResult, ImageEntry, ListImagesResult, SourceAdapter, SourceError } from './adapter';
import { HttpRequestError, cancelBody, fetchResponse } from './http';

export type ImageProbe = (url: string, controller?: AbortController) => Promise<void>;
export type DirectFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface DirectAdapterOptions { fetcher?: DirectFetch; timeoutMs?: number; maxConcurrent?: number; }

const MAX_ENTRIES = 200;

export class DirectSourceAdapter implements SourceAdapter<DirectSourceConfig> {
  private readonly imageProbe: ImageProbe;
  private readonly maxConcurrent: number;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(probeOrOptions: ImageProbe | DirectAdapterOptions = {}, options: DirectAdapterOptions = {}) {
    if (typeof probeOrOptions === 'function') { this.imageProbe = probeOrOptions; this.maxConcurrent = options.maxConcurrent ?? 6; }
    else {
      const fetcher = probeOrOptions.fetcher ?? defaultFetch;
      const timeoutMs = probeOrOptions.timeoutMs ?? options.timeoutMs ?? 15_000;
      this.maxConcurrent = probeOrOptions.maxConcurrent ?? options.maxConcurrent ?? 6;
      this.imageProbe = (url, controller) => probeRemoteImage(url, fetcher, timeoutMs, controller);
    }
  }

  validateConfig(config: unknown): ConfigValidationResult {
    if (!isDirectConfig(config)) return { ok: false, error: validationError() };
    return { ok: true };
  }

  async testConnection(config: DirectSourceConfig): Promise<ConnectionTestResult> {
    const result = await this.probe(config, MAX_ENTRIES);
    return result.ok
      ? { ok: true, entries: result.images, ...(result.warnings ? { warnings: result.warnings } : {}) }
      : { ok: false, error: result.error, entries: result.images, ...(result.warnings ? { warnings: result.warnings } : {}) };
  }

  async listImages(config: DirectSourceConfig): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return failed(validation.error);
    if (this.disposed) return failed(cancelledError());
    return succeeded(config.entries.map((entry) => ({
      id: entry.id,
      sourceId: config.id,
      url: entry.url,
      ...(entry.label ? { description: entry.label } : {})
    })), []);
  }
  async refreshMetadata(config: DirectSourceConfig): Promise<void> { this.abortSource(config.id); this.advanceGeneration(config.id); }
  async getAttribution(entry: ImageEntry): Promise<string | undefined> { return entry.attribution; }
  async deleteSource(sourceId: string): Promise<void> { this.abortSource(sourceId); this.advanceGeneration(sourceId); }
  async dispose(): Promise<void> { this.disposed = true; for (const sourceId of this.controllers.keys()) { this.abortSource(sourceId); this.advanceGeneration(sourceId); } }

  private async probe(config: DirectSourceConfig, limit: number): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return failed(validation.error);
    if (this.disposed) return failed(cancelledError());
    const generation = this.advanceGeneration(config.id);
    const controller = this.register(config.id);
    const entries = config.entries.slice(0, limit);
    const successes: Array<ImageEntry | undefined> = new Array(entries.length);
    const warnings: Array<SourceError | undefined> = new Array(entries.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          await this.probeOne(entry.url, controller);
          successes[index] = { id: entry.id, sourceId: config.id, url: entry.url, ...(entry.label ? { description: entry.label } : {}) };
        } catch (error) { warnings[index] = probeError(error); }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(Math.max(1, this.maxConcurrent), entries.length) }, worker));
      if (!this.isCurrent(config.id, generation) || controller.signal.aborted) return failed(cancelledError());
      const images = successes.filter((entry): entry is ImageEntry => entry !== undefined);
      const problems = warnings.filter((warning): warning is SourceError => warning !== undefined);
      if (images.length === 0) return failed(problems[0] ?? { code: 'empty', message: 'No direct images could be reached.', retryable: true }, problems);
      return succeeded(images, problems);
    } finally { this.unregister(config.id, controller); }
  }

  private register(sourceId: string): AbortController { const controller = new AbortController(); const set = this.controllers.get(sourceId) ?? new Set(); set.add(controller); this.controllers.set(sourceId, set); return controller; }
  private async probeOne(url: string, parent: AbortController): Promise<void> {
    const child = new AbortController();
    const abortChild = () => child.abort();
    if (parent.signal.aborted) child.abort();
    else parent.signal.addEventListener('abort', abortChild, { once: true });
    try { await this.imageProbe(url, child); }
    finally { parent.signal.removeEventListener('abort', abortChild); }
  }
  private unregister(sourceId: string, controller: AbortController): void { const set = this.controllers.get(sourceId); set?.delete(controller); if (set?.size === 0) this.controllers.delete(sourceId); }
  private abortSource(sourceId: string): void { for (const controller of this.controllers.get(sourceId) ?? []) controller.abort(); }
  private advanceGeneration(sourceId: string): number { const value = (this.generations.get(sourceId) ?? 0) + 1; this.generations.set(sourceId, value); return value; }
  private isCurrent(sourceId: string, generation: number): boolean { return !this.disposed && this.generations.get(sourceId) === generation; }
}

function isDirectConfig(value: unknown): value is DirectSourceConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<DirectSourceConfig>;
  const entries = config.entries;
  return config.type === 'direct' && validBase(config) && Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_ENTRIES
    && new Set(entries.map((entry) => entry?.id)).size === entries.length
    && entries.every((entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim().length > 0
      && typeof entry.url === 'string' && isSafeHttpsUrl(entry.url) && (entry.label === undefined || typeof entry.label === 'string'));
}
function validBase(config: Partial<DirectSourceConfig>): boolean { return typeof config.id === 'string' && config.id.trim().length > 0 && typeof config.name === 'string' && config.name.trim().length > 0 && typeof config.enabled === 'boolean' && Number.isFinite(config.createdAt) && Number.isFinite(config.updatedAt); }
function isSafeHttpsUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
function validationError(): SourceError { return { code: 'validation', message: 'Direct sources require 1–200 uniquely identified HTTPS image URLs without user information.' }; }
function cancelledError(): SourceError { return { code: 'network', message: 'The direct image request was cancelled.', retryable: true }; }
function succeeded(images: ImageEntry[], warnings: SourceError[]): ListImagesResult { return { ok: true, images: images as [ImageEntry, ...ImageEntry[]], ...(warnings.length ? { warnings } : {}) }; }
function failed(error: SourceError, warnings?: SourceError[]): ListImagesResult { return { ok: false, images: [], error, ...(warnings?.length ? { warnings } : {}) }; }
function probeError(error: unknown): SourceError {
  if (error instanceof ProbeError) return error.sourceError;
  if (error instanceof HttpRequestError) return error.kind === 'timeout' ? { code: 'network', message: 'The direct image request timed out.', retryable: true } : { code: 'network', message: 'The direct image could not be reached.', retryable: true };
  return { code: 'network', message: 'One direct image could not be reached.', retryable: true };
}
class ProbeError extends Error { constructor(readonly sourceError: SourceError) { super(sourceError.message); } }
async function probeRemoteImage(url: string, fetcher: DirectFetch, timeoutMs: number, controller?: AbortController): Promise<void> {
  const requestController = controller ?? new AbortController();
  const response = await fetchResponse(fetcher, url, { method: 'GET', headers: new Headers({ Accept: 'image/*' }) }, { timeoutMs, controller: requestController });
  try {
    if (response.status === 401 || response.status === 403) throw new ProbeError({ code: 'auth', message: 'The image host rejected the request credentials.' });
    if (!response.ok) throw new ProbeError({ code: 'http', status: response.status, message: 'The image host returned an HTTP error.', retryable: response.status >= 500 });
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('image/')) throw new ProbeError({ code: 'decode', message: 'The image host did not return an image.' });
  } finally { await cancelBody(response); }
}
const defaultFetch: DirectFetch = (url, init) => fetch(url, init);

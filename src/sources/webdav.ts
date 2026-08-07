import { DOMParser as XmlDomParser, type Element as XmlElement } from '@xmldom/xmldom';

import type { WebDavSourceConfig } from '../domain/types';
import type { ConfigValidationResult, ConnectionTestResult, ImageEntry, ListImagesResult, SafeWebDavDirectory, SourceAdapter, SourceError } from './adapter';
import { HttpRequestError, fetchText, type SourceFetch } from './http';
import { opaqueImageId, sha256Hex } from '../lib/crypto';
import { canonicalWebDavChildDirectory, canonicalWebDavDirectory, decodeSafeWebDavPathSegment, isSafeWebDavDirectoryName } from './webdavUrl';

export type WebDavFetch = SourceFetch;
export interface WebDavAdapterOptions { timeoutMs?: number; maxBytes?: number; }

const RESOURCE_LIMIT = 2000;
const DIRECTORY_LIMIT = 200;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontenttype/><getcontentlength/><getlastmodified/></prop></propfind>';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

interface CanonicalUrl { url: URL; segments: string[]; }
interface Resource extends CanonicalUrl { collection: boolean; contentType?: string; }
interface ListedResponse { resource?: Resource; }

export class WebDavSourceAdapter implements SourceAdapter<WebDavSourceConfig> {
  private readonly fetcher: WebDavFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(fetcher: WebDavFetch = defaultFetch, options: WebDavAdapterOptions = {}) {
    this.fetcher = fetcher;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  validateConfig(config: unknown): ConfigValidationResult { return isWebDavConfig(config) ? { ok: true } : { ok: false, error: validationError() }; }
  async testConnection(config: WebDavSourceConfig): Promise<ConnectionTestResult> {
    const validation = this.validateConfig(config);
    const emptyDiscovery = { imageOrigins: safeConfiguredUrl(config.url, config.folderPath) ? [`${new URL(config.url).origin}/*`] : [], count: 0, preview: [] as [] };
    if (!validation.ok) return { ok: false, protected: true, error: validation.error, ...emptyDiscovery, directories: [] };
    if (this.disposed) return { ok: false, protected: true, error: cancelledError(), ...emptyDiscovery, directories: [] };
    const root = configuredDirectoryUrl(config)!;
    const generation = this.advanceGeneration(config.id);
    const controller = this.register(config.id);
    try {
      const listing = await this.listDirectory(root.url, config, controller);
      if (!this.isCurrent(config.id, generation) || controller.signal.aborted) return { ok: false, protected: true, error: cancelledError(), ...emptyDiscovery, directories: [] };
      return { ok: true, protected: true, ...emptyDiscovery, directories: await safeChildDirectories(listing, root, config.id) };
    } catch (error) {
      const mapped = !this.isCurrent(config.id, generation) ? cancelledError() : requestError(error);
      return { ok: false, protected: true, error: mapped, ...emptyDiscovery, directories: [] };
    } finally { this.unregister(config.id, controller); }
  }
  async listImages(config: WebDavSourceConfig): Promise<ListImagesResult> { return this.load(config, RESOURCE_LIMIT); }
  async refreshMetadata(config: WebDavSourceConfig): Promise<void> { this.abortSource(config.id); this.advanceGeneration(config.id); }
  async getAttribution(entry: ImageEntry): Promise<string | undefined> { return entry.attribution; }
  async deleteSource(sourceId: string): Promise<void> { this.abortSource(sourceId); this.advanceGeneration(sourceId); }
  dispose(): void { this.disposed = true; for (const sourceId of this.controllers.keys()) { this.abortSource(sourceId); this.advanceGeneration(sourceId); } }

  private async load(config: WebDavSourceConfig, resourceLimit: number, imageLimit?: number): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return failed(validation.error);
    if (this.disposed) return failed(cancelledError());
    const root = configuredDirectoryUrl(config)!;
    const generation = this.advanceGeneration(config.id);
    const controller = this.register(config.id);
    const images: ImageEntry[] = [];
    const warnings: SourceError[] = [];
    const visited = new Set<string>();
    const queued: CanonicalUrl[] = [root];
    let listedResources = 0;
    let truncated = false;
    let previewComplete = false;
    try {
      while (queued.length && !truncated && !previewComplete) {
        const directory = queued.shift()!;
        if (visited.has(directory.url.href)) continue;
        visited.add(directory.url.href);
        let listing: ListedResponse[];
        try { listing = await this.listDirectory(directory.url, config, controller); }
        catch (error) {
          if (!this.isCurrent(config.id, generation)) return failed(cancelledError(), warnings);
          const mapped = requestError(error);
          if (images.length === 0) return failed(mapped, warnings);
          warnings.push(mapped);
          continue;
        }
        if (!this.isCurrent(config.id, generation) || controller.signal.aborted) return failed(cancelledError(), warnings);
        const remaining = resourceLimit - listedResources;
        const batch = listing.slice(0, Math.max(0, remaining));
        const overflowedBatch = listing.length > batch.length;
        listedResources += batch.length;
        for (const listed of batch) {
          const resource = listed.resource;
          if (!resource) continue;
          if (!insideRoot(resource, root)) { warnings.push({ code: 'validation', message: 'A WebDAV response item outside the configured directory was skipped.' }); continue; }
          if (sameCanonicalPath(resource, directory)) continue;
          if (resource.collection) {
            const childDirectory = directoryUrl(resource.url.href);
            if (config.includeSubdirectories && childDirectory && childDirectory.url.href !== directory.url.href && !visited.has(childDirectory.url.href)) queued.push(childDirectory);
            continue;
          }
          if (!isImage(resource)) continue;
          if (imageLimit !== undefined && images.length >= imageLimit) continue;
          const url = resource.url.href;
          images.push({ id: await opaqueImageId(config.id, JSON.stringify(['webdav', url])), sourceId: config.id, url, description: filename(resource.url) });
        }
        // Reaching the limit is only truncation if this batch had more responses or known child work remains.
        if (overflowedBatch || (listedResources === resourceLimit && queued.length > 0)) truncated = true;
        if (imageLimit !== undefined && images.length >= imageLimit) previewComplete = true;
      }
      if (truncated) warnings.push({ code: 'parse', message: `WebDAV scan was truncated after ${resourceLimit.toLocaleString('en-US')} resources.` });
      return images.length ? succeeded(images, warnings) : failed({ code: 'empty', message: 'No supported images were found in the WebDAV directory.' }, warnings);
    } finally { this.unregister(config.id, controller); }
  }

  private async listDirectory(directory: URL, config: WebDavSourceConfig, controller: AbortController): Promise<ListedResponse[]> {
    const { response, text } = await fetchText(this.fetcher, directory.href, {
      method: 'PROPFIND', redirect: 'manual', headers: new Headers({ Depth: '1', Authorization: basicAuth(config.username, config.password), 'Content-Type': 'application/xml; charset=utf-8' }), body: PROPFIND_BODY
    }, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, controller });
    if (!response.ok || response.status !== 207) throw new ResponseStatusError(response.status, response.headers.get('Retry-After'));
    return parseMultiStatus(text ?? '', directory);
  }

  private register(sourceId: string): AbortController { const controller = new AbortController(); const set = this.controllers.get(sourceId) ?? new Set(); set.add(controller); this.controllers.set(sourceId, set); return controller; }
  private unregister(sourceId: string, controller: AbortController): void { const set = this.controllers.get(sourceId); set?.delete(controller); if (set?.size === 0) this.controllers.delete(sourceId); }
  private abortSource(sourceId: string): void { for (const controller of this.controllers.get(sourceId) ?? []) controller.abort(); }
  private advanceGeneration(sourceId: string): number { const next = (this.generations.get(sourceId) ?? 0) + 1; this.generations.set(sourceId, next); return next; }
  private isCurrent(sourceId: string, generation: number): boolean { return !this.disposed && this.generations.get(sourceId) === generation; }
}

function parseMultiStatus(xml: string, base: URL): ListedResponse[] {
  if (/<!\s*(?:doctype|entity)\b/i.test(xml)) throw new SyntaxError('Unsafe XML.');
  let document;
  try {
    document = new XmlDomParser({ onError: () => { throw new SyntaxError('Invalid XML.'); } }).parseFromString(xml, 'application/xml');
  } catch { throw new SyntaxError('Invalid XML.'); }
  const root = document.documentElement;
  if (!root || root.namespaceURI !== 'DAV:' || elementName(root) !== 'multistatus') throw new SyntaxError('Not a WebDAV multi-status response.');
  const resources: ListedResponse[] = [];
  for (const response of davChildren(root, 'response')) {
    const href = textOf(firstDav(response, 'href'));
    if (!href) { resources.push({}); continue; }
    if (!safeHrefPath(href)) { resources.push({}); continue; }
    let canonical: CanonicalUrl | undefined;
    try { canonical = canonicalUrl(new URL(href, base)); } catch { resources.push({}); continue; }
    if (!canonical) { resources.push({}); continue; }
    const propstat = davChildren(response, 'propstat').find((item) => /^HTTP\/\S+\s+2\d\d\b/.test(textOf(firstDav(item, 'status')) ?? ''));
    const prop = propstat && firstDav(propstat, 'prop');
    if (!prop) { resources.push({}); continue; }
    const collection = Boolean(firstDav(firstDav(prop, 'resourcetype'), 'collection'));
    const contentType = textOf(firstDav(prop, 'getcontenttype'))?.split(';', 1)[0].trim().toLowerCase();
    resources.push({ resource: { ...canonical, collection, ...(contentType ? { contentType } : {}) } });
  }
  return resources;
}

function davChildren(parent: XmlElement, name: string): XmlElement[] {
  const children: XmlElement[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index);
    if (node?.nodeType !== 1) continue;
    const element = node as XmlElement;
    if (element.namespaceURI === 'DAV:' && elementName(element) === name) children.push(element);
  }
  return children;
}
function firstDav(parent: XmlElement | undefined, name: string): XmlElement | undefined { return parent ? davChildren(parent, name)[0] : undefined; }
function textOf(element: XmlElement | undefined): string | undefined { const value = element?.textContent?.trim(); return value || undefined; }
function elementName(element: XmlElement): string { return (element.localName || element.tagName).split(':').pop()!.toLowerCase(); }
function safeUrl(url: URL): boolean { return url.protocol === 'https:' && !url.username && !url.password; }
function configuredDirectoryUrl(config: WebDavSourceConfig): CanonicalUrl | undefined {
  const combined = canonicalWebDavChildDirectory(config.url, config.folderPath ?? []);
  return combined ? canonicalWebDavDirectory(combined) : undefined;
}
function directoryUrl(input: string): CanonicalUrl | undefined { return canonicalWebDavDirectory(input); }
function canonicalUrl(url: URL): CanonicalUrl | undefined {
  if (!safeUrl(url)) return undefined;
  const segments: string[] = [];
  for (const rawSegment of url.pathname.split('/')) {
    if (!rawSegment) continue;
    const segment = decodeSafeWebDavPathSegment(rawSegment);
    if (segment === undefined) return undefined;
    segments.push(segment);
  }
  const canonical = new URL(url.href);
  canonical.pathname = segments.length ? `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}` : '/';
  return { url: canonical, segments };
}
function safeHrefPath(href: string): boolean {
  const withoutQuery = href.split(/[?#]/, 1)[0];
  const absolute = withoutQuery.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i);
  const path = absolute ? absolute[1] ?? '' : withoutQuery;
  return path.split('/').every((segment) => !segment || decodeSafeWebDavPathSegment(segment) !== undefined);
}
function sameCanonicalPath(left: CanonicalUrl, right: CanonicalUrl): boolean { return left.url.origin === right.url.origin && left.segments.length === right.segments.length && left.segments.every((segment, index) => segment === right.segments[index]); }
function insideRoot(resource: CanonicalUrl, root: CanonicalUrl): boolean { return resource.url.origin === root.url.origin && resource.segments.length >= root.segments.length && root.segments.every((segment, index) => resource.segments[index] === segment); }
async function safeChildDirectories(listing: ListedResponse[], root: CanonicalUrl, sourceId: string): Promise<SafeWebDavDirectory[]> {
  const children = new Map<string, Resource>();
  for (const { resource } of listing) {
    if (!resource?.collection || resource.url.search || resource.url.hash) continue;
    if (resource.url.origin !== root.url.origin || resource.segments.length !== root.segments.length + 1 || !insideRoot(resource, root)) continue;
    const name = resource.segments[root.segments.length];
    if (!name || !isSafeWebDavDirectoryName(name)) continue;
    children.set(resource.url.pathname, resource);
  }
  const ordered = [...children.values()]
    .sort((left, right) => compareDirectoryNames(left.segments.at(-1)!, right.segments.at(-1)!))
    .slice(0, DIRECTORY_LIMIT);
  return Promise.all(ordered.map(async (resource) => {
    const name = resource.segments.at(-1)!;
    return { id: `dir_${await sha256Hex(JSON.stringify([sourceId, 'webdav-directory', resource.url.origin, resource.url.pathname]))}`, name, relativeSegments: [name] };
  }));
}
function compareDirectoryNames(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function isImage(resource: Resource): boolean { if (resource.contentType) return IMAGE_TYPES.has(resource.contentType); const ext = resource.url.pathname.split('.').pop()?.toLowerCase(); return Boolean(ext && IMAGE_EXTENSIONS.has(ext)); }
function filename(url: URL): string { const segment = url.pathname.split('/').filter(Boolean).pop() ?? url.pathname; try { return decodeURIComponent(segment); } catch { return segment; } }
function basicAuth(username: string, password: string): string { const bytes = new TextEncoder().encode(`${username}:${password}`); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return `Basic ${btoa(binary)}`; }
function isWebDavConfig(value: unknown): value is WebDavSourceConfig { if (!value || typeof value !== 'object') return false; const config = value as Partial<WebDavSourceConfig>; return config.type === 'webdav' && validBase(config) && typeof config.url === 'string' && safeConfiguredUrl(config.url, config.folderPath) && typeof config.username === 'string' && config.username.trim().length > 0 && !config.username.includes(':') && typeof config.password === 'string' && config.password.length > 0 && typeof config.includeSubdirectories === 'boolean'; }
function validBase(config: Partial<WebDavSourceConfig>): boolean { return typeof config.id === 'string' && config.id.trim().length > 0 && typeof config.name === 'string' && config.name.trim().length > 0 && typeof config.enabled === 'boolean' && Number.isFinite(config.createdAt) && Number.isFinite(config.updatedAt); }
function safeConfiguredUrl(value: string, folderPath: unknown): boolean {
  if (folderPath !== undefined && (!Array.isArray(folderPath) || !folderPath.every((segment) => typeof segment === 'string' && isSafeWebDavDirectoryName(segment)))) return false;
  return Boolean(canonicalWebDavChildDirectory(value, Array.isArray(folderPath) ? folderPath : []));
}
function validationError(): SourceError { return { code: 'validation', message: 'WebDAV sources require a name, an HTTPS directory URL without user information, query, or fragment, username, password, and recursion setting.' }; }
function cancelledError(): SourceError { return { code: 'network', message: 'The WebDAV request was cancelled.', retryable: true }; }
function succeeded(images: ImageEntry[], warnings: SourceError[]): ListImagesResult { return { ok: true, images: images as [ImageEntry, ...ImageEntry[]], ...(warnings.length ? { warnings } : {}) }; }
function failed(error: SourceError, warnings?: SourceError[]): ListImagesResult { return { ok: false, images: [], error, ...(warnings?.length ? { warnings } : {}) }; }
function requestError(error: unknown): SourceError { if (error instanceof ResponseStatusError) return responseError(error); if (error instanceof SyntaxError || error instanceof HttpRequestError && error.kind === 'too-large') return { code: 'parse', message: 'The WebDAV response could not be parsed safely.' }; return { code: 'network', message: 'The WebDAV server could not be reached.', retryable: true }; }
class ResponseStatusError extends Error { constructor(readonly status: number, readonly retryAfter: string | null) { super(String(status)); } }
function responseError(error: ResponseStatusError): SourceError { if (error.status === 401 || error.status === 403) return { code: 'auth', message: 'The WebDAV server rejected the credentials.' }; if (error.status === 429) return { code: 'rate-limit', message: 'The WebDAV server rate limit was reached.', retryable: true, ...(retryAfterMs(error.retryAfter) === undefined ? {} : { retryAfterMs: retryAfterMs(error.retryAfter)! }) }; return { code: 'http', status: error.status, message: 'The WebDAV server returned an HTTP error.', retryable: error.status >= 500 }; }
function retryAfterMs(value: string | null): number | undefined { if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000; const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined; }
const defaultFetch: WebDavFetch = (url, init) => fetch(url, init);

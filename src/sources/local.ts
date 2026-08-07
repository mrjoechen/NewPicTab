import type { LocalSourceConfig } from '../domain/types';
import { deleteSource as deleteLocalSource, listLocal, putLocal } from '../storage/imageDb';
import type { LocalImageInput } from '../storage/imageDb';
import type { ConfigValidationResult, ConnectionTestResult, ImageEntry, ListImagesResult, SourceAdapter, SourceError } from './adapter';

const SUPPORTED_LOCAL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export interface ObjectUrlApi {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export interface LocalImportResult {
  imported: number;
  failures: LocalImportFailure[];
}

export interface LocalImportFailure {
  fileName: string;
  error: SourceError;
}

export interface LocalStorageApi {
  listLocal(sourceId: string): Promise<LocalImageInput[]>;
  putLocal(record: LocalImageInput): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
}

const defaultStorage: LocalStorageApi = { listLocal, putLocal, deleteSource: deleteLocalSource };
const sourceLocks = new Map<string, Promise<void>>();

function withSourceLock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sourceLocks.get(sourceId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tail = current.then(() => undefined, () => undefined);
  sourceLocks.set(sourceId, tail);
  return current.finally(() => {
    if (sourceLocks.get(sourceId) === tail) sourceLocks.delete(sourceId);
  });
}

export function isSupportedLocalImage(blob: Blob): boolean {
  return SUPPORTED_LOCAL_IMAGE_TYPES.has(blob.type.toLowerCase());
}

async function importLocalFiles(
  sourceId: string,
  files: Iterable<File>,
  createId: () => string = () => crypto.randomUUID(),
  saveLocal: (record: LocalImageInput) => Promise<void> = putLocal,
  canImport: () => boolean = () => true
): Promise<LocalImportResult> {
  const pendingFiles = [...files];
  return withSourceLock(sourceId, async () => {
    const failures: LocalImportFailure[] = [];
    let imported = 0;
    for (const file of pendingFiles) {
      if (!canImport()) { failures.push({ fileName: file.name, error: removedError() }); continue; }
      if (!isSupportedLocalImage(file)) {
        failures.push({ fileName: file.name, error: { code: 'validation', message: `Skipped unsupported image: ${file.name}` } });
        continue;
      }
      try {
        await saveLocal({ sourceId, id: createId(), name: file.name, type: file.type, size: file.size, blob: file, createdAt: Date.now() });
        imported += 1;
      } catch {
        failures.push({ fileName: file.name, error: { code: 'unknown', message: `Could not import image: ${file.name}`, retryable: true } });
      }
    }
    return { imported, failures };
  });
}

export class LocalSourceAdapter implements SourceAdapter<LocalSourceConfig> {
  private readonly createObjectURL: ((blob: Blob) => string) | undefined;
  private readonly revokeObjectURL: ((url: string) => void) | undefined;
  private readonly objectUrls = new Map<string, Set<string>>();
  private readonly pendingRevoke = new Set<string>();
  private readonly generations = new Map<string, number>();
  /** Deleted source ids are terminal for this adapter session. */
  private readonly tombstones = new Set<string>();
  private readonly deleting = new Map<string, number>();
  private disposed = false;
  private readonly storage: LocalStorageApi;

  constructor(urlApi: ObjectUrlApi = {}, storage: LocalStorageApi = defaultStorage) {
    this.createObjectURL = urlApi.createObjectURL ?? globalThis.URL?.createObjectURL?.bind(globalThis.URL);
    this.revokeObjectURL = urlApi.revokeObjectURL ?? globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
    this.storage = storage;
  }

  validateConfig(config: unknown): ConfigValidationResult {
    if (!isLocalSourceConfig(config)) return { ok: false, error: { code: 'validation', message: 'A local source requires a non-empty id and name.' } };
    return { ok: true };
  }

  async testConnection(config: LocalSourceConfig): Promise<ConnectionTestResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return validation;
    try {
      await this.storage.listLocal(config.id);
      return { ok: true };
    } catch {
      return { ok: false, error: storageError() };
    }
  }

  async listImages(config: LocalSourceConfig): Promise<ListImagesResult> {
    const validation = this.validateConfig(config);
    if (!validation.ok) return listFailure(validation.error);
    if (this.tombstones.has(config.id) || this.disposed) return listFailure(removedError());
    const generation = this.advanceGeneration(config.id);
    let records: LocalImageInput[];
    try { records = await this.storage.listLocal(config.id); } catch { return listFailure(storageError()); }
    if (!this.isCurrent(config.id, generation)) return listFailure(changedError());
    const created = new Set<string>();
    try {
      const images = records.map((record): ImageEntry => {
        let url: string | undefined;
        try { url = this.createObjectURL?.(record.blob); }
        catch { throw new LocalPreviewError('decode'); }
        if (url) { created.add(url); return { id: record.id, sourceId: record.sourceId, url }; }
        return { id: record.id, sourceId: record.sourceId, localBlobKey: localBlobKey(record.sourceId, record.id) };
      });
      if (!this.isCurrent(config.id, generation)) {
        this.revokeUrls(created);
        return listFailure(changedError());
      }
      const previous = this.objectUrls.get(config.id);
      this.objectUrls.set(config.id, created);
      const revokeFailed = this.revokeUrls(previous);
      if (images.length === 0) return listFailure(revokeFailed ? releaseError() : { code: 'empty', message: 'This local source has no images.' });
      return listSuccess(images, revokeFailed ? [releaseError()] : []);
    } catch (error) {
      this.revokeUrls(created);
      return listFailure(error instanceof LocalPreviewError ? previewError() : storageError());
    }
  }

  async refreshMetadata(config: LocalSourceConfig): Promise<void> {
    this.advanceGeneration(config.id);
    this.releaseUrls(config.id);
    this.retryPendingRevocations();
  }

  async getAttribution(entry: ImageEntry): Promise<string | undefined> {
    return entry.attribution;
  }

  async deleteSource(sourceId: string): Promise<void> {
    this.deleting.set(sourceId, (this.deleting.get(sourceId) ?? 0) + 1);
    this.advanceGeneration(sourceId);
    try {
      await withSourceLock(sourceId, async () => {
        try { await this.storage.deleteSource(sourceId); this.tombstones.add(sourceId); }
        finally { this.advanceGeneration(sourceId); this.releaseUrls(sourceId); this.retryPendingRevocations(); }
      });
    } finally {
      const remaining = (this.deleting.get(sourceId) ?? 1) - 1;
      if (remaining > 0) this.deleting.set(sourceId, remaining); else this.deleting.delete(sourceId);
    }
  }

  importFiles(sourceId: string, files: Iterable<File>, createId?: () => string, saveLocal?: (record: LocalImageInput) => Promise<void>): Promise<LocalImportResult> {
    const pendingFiles = [...files];
    if (!this.canImport(sourceId)) {
      return Promise.resolve({ imported: 0, failures: pendingFiles.map((file) => ({ fileName: file.name, error: removedError() })) });
    }
    return importLocalFiles(sourceId, pendingFiles, createId, saveLocal, () => this.canImport(sourceId));
  }

  private canImport(sourceId: string): boolean { return !this.disposed && !this.tombstones.has(sourceId) && !this.deleting.has(sourceId); }

  dispose(): void {
    this.disposed = true;
    for (const sourceId of this.objectUrls.keys()) this.advanceGeneration(sourceId);
    this.releaseUrls();
    this.retryPendingRevocations();
  }

  private releaseUrls(sourceId?: string): void {
    const entries = sourceId === undefined ? [...this.objectUrls.entries()] : [[sourceId, this.objectUrls.get(sourceId)]] as const;
    for (const [id, urls] of entries) {
      if (!urls) continue;
      this.revokeUrls(urls);
      this.objectUrls.delete(id);
    }
  }

  private revokeUrls(urls: Set<string> | undefined): boolean {
    let failed = false;
    if (urls) for (const url of urls) {
      try { this.revokeObjectURL?.(url); this.pendingRevoke.delete(url); }
      catch { failed = true; this.pendingRevoke.add(url); }
    }
    return failed;
  }
  private retryPendingRevocations(): void { this.revokeUrls(new Set(this.pendingRevoke)); }
  private advanceGeneration(sourceId: string): number { const next = (this.generations.get(sourceId) ?? 0) + 1; this.generations.set(sourceId, next); return next; }
  private isCurrent(sourceId: string, generation: number): boolean { return !this.disposed && !this.tombstones.has(sourceId) && this.generations.get(sourceId) === generation; }
}

function storageError(): SourceError { return { code: 'unknown', message: 'Local image storage is unavailable.', retryable: true }; }
function previewError(): SourceError { return { code: 'decode', message: 'Could not create a local image preview.' }; }
function releaseError(): SourceError { return { code: 'unknown', message: 'Could not release a local image preview.' }; }
function removedError(): SourceError { return { code: 'validation', message: 'This local source has been deleted.' }; }
function changedError(): SourceError { return { code: 'unknown', message: 'The local source changed while loading.' }; }
function listSuccess(images: ImageEntry[], warnings: SourceError[]): ListImagesResult { return { ok: true, images: images as [ImageEntry, ...ImageEntry[]], ...(warnings.length ? { warnings } : {}) }; }
function listFailure(error: SourceError): ListImagesResult { return { ok: false, images: [], error }; }
class LocalPreviewError extends Error { constructor(_kind: 'decode') { super(); } }

function localBlobKey(sourceId: string, id: string): string {
  return JSON.stringify([sourceId, id]);
}

function isLocalSourceConfig(value: unknown): value is LocalSourceConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<LocalSourceConfig>;
  return config.type === 'local'
    && typeof config.id === 'string' && config.id.trim().length > 0
    && typeof config.name === 'string' && config.name.trim().length > 0
    && typeof config.enabled === 'boolean'
    && typeof config.includeSubdirectories === 'boolean'
    && Number.isFinite(config.createdAt)
    && Number.isFinite(config.updatedAt);
}

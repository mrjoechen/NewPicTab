import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalSourceConfig } from '../domain/types';
import { listLocal, putLocal } from '../storage/imageDb';
import { LocalSourceAdapter, isSupportedLocalImage } from './local';
import type { LocalImageInput, LocalImageRecord } from '../storage/imageDb';

const source: LocalSourceConfig = {
  id: 'local-photos', name: 'Photos', type: 'local', enabled: true,
  createdAt: 1, updatedAt: 1, includeSubdirectories: false
};

async function removeDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('pictab');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database remained open'));
  });
}

describe('LocalSourceAdapter', () => {
  beforeEach(removeDatabase);
  afterEach(removeDatabase);

  it('validates LocalSourceConfig', () => {
    const adapter = new LocalSourceAdapter();
    expect(adapter.validateConfig(source)).toEqual({ ok: true });
    expect(adapter.validateConfig({ ...source, id: '' })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(adapter.validateConfig({ ...source, createdAt: Number.NaN })).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('maps persisted local images to entries and reclaims object URLs on refresh and dispose', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    await putLocal({ sourceId: source.id, id: 'a', name: 'a.png', type: 'image/png', size: blob.size, blob, createdAt: 2 });
    const createObjectURL = vi.fn(() => 'blob:one');
    const revokeObjectURL = vi.fn();
    const adapter = new LocalSourceAdapter({ createObjectURL, revokeObjectURL });

    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: [{ id: 'a', sourceId: source.id, url: 'blob:one' }] });
    await adapter.refreshMetadata(source);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:one');
    await adapter.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('reports an empty local source and removes all stored records on deletion', async () => {
    const adapter = new LocalSourceAdapter();
    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: [], error: { code: 'empty' } });
    const blob = new Blob(['image'], { type: 'image/jpeg' });
    await putLocal({ sourceId: source.id, id: 'a', name: 'a.jpg', type: 'image/jpeg', size: blob.size, blob, createdAt: 2 });

    await adapter.deleteSource(source.id);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: [], error: { code: 'validation' } });
  });

  it('accepts browser-safe raster image types and rejects SVG', () => {
    expect(isSupportedLocalImage(new Blob([], { type: 'image/jpeg' }))).toBe(true);
    expect(isSupportedLocalImage(new Blob([], { type: 'image/avif' }))).toBe(true);
    expect(isSupportedLocalImage(new Blob([], { type: 'image/svg+xml' }))).toBe(false);
  });

  it('continues importing later valid files when one file cannot be saved', async () => {
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const broken = new File(['broken'], 'broken.png', { type: 'image/png' });
    const last = new File(['last'], 'last.png', { type: 'image/png' });
    const ids = ['first', 'broken', 'last'];

    const result = await new LocalSourceAdapter().importFiles(source.id, [first, broken, last], () => {
      const id = ids.shift();
      if (id === 'broken') throw new Error('disk unavailable');
      return id ?? 'unexpected';
    });

    expect(result.imported).toBe(2);
    expect(result.failures).toEqual([expect.objectContaining({
      fileName: 'broken.png', error: expect.objectContaining({ code: 'unknown' })
    })]);
    expect((await listLocal(source.id)).map((image) => image.id)).toEqual(['first', 'last']);
  });

  it('reports a per-file storage failure and continues with later files', async () => {
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const broken = new File(['broken'], 'broken.png', { type: 'image/png' });
    const last = new File(['last'], 'last.png', { type: 'image/png' });
    const ids = ['first', 'broken', 'last'];

    const result = await new LocalSourceAdapter().importFiles(source.id, [first, broken, last], () => ids.shift() ?? 'unexpected', async (input) => {
      if (input.id === 'broken') throw new Error('database unavailable');
      await putLocal(input);
    });

    expect(result.imported).toBe(2);
    expect(result.failures).toEqual([expect.objectContaining({ fileName: 'broken.png' })]);
    expect((await listLocal(source.id)).map((image) => image.id)).toEqual(['first', 'last']);
  });

  it('normalizes storage errors from listing and connection tests', async () => {
    const unavailable = { listLocal: vi.fn(async () => { throw new DOMException('sensitive internal detail'); }), putLocal, deleteSource: vi.fn(async () => {}) };
    const adapter = new LocalSourceAdapter({}, unavailable);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: [], error: { code: 'unknown', message: 'Local image storage is unavailable.' } });
    await expect(adapter.testConnection(source)).resolves.toMatchObject({ ok: false, error: { code: 'unknown', message: 'Local image storage is unavailable.' } });
  });

  it('reports a safe decode error when creating an object URL fails', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    const storage = { listLocal: vi.fn(async () => [{ sourceId: source.id, id: 'one', name: 'one.png', type: blob.type, size: blob.size, blob, createdAt: 1 }]), putLocal, deleteSource: vi.fn(async () => {}) };
    const adapter = new LocalSourceAdapter({ createObjectURL: () => { throw new DOMException('internal'); } }, storage);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ images: [], error: { code: 'decode', message: 'Could not create a local image preview.' } });
  });

  it('retries a failed URL revocation during dispose', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    const storage = { listLocal: vi.fn().mockResolvedValueOnce([{ sourceId: source.id, id: 'one', name: 'one.png', type: blob.type, size: blob.size, blob, createdAt: 1 }]).mockResolvedValueOnce([]), putLocal, deleteSource: vi.fn(async () => {}) };
    let attempts = 0;
    const revokeObjectURL = vi.fn(() => { attempts += 1; if (attempts === 1) throw new Error('temporary'); });
    const adapter = new LocalSourceAdapter({ createObjectURL: () => 'blob:retry', revokeObjectURL }, storage);
    await adapter.listImages(source);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ error: { code: 'unknown', message: 'Could not release a local image preview.' } });
    adapter.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('does not let an older overlapping list replace a newer URL generation', async () => {
    let resolveFirst!: (records: LocalImageRecord[]) => void;
    let resolveSecond!: (records: LocalImageRecord[]) => void;
    const first = new Promise<LocalImageRecord[]>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<LocalImageRecord[]>((resolve) => { resolveSecond = resolve; });
    const storage = { listLocal: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), putLocal, deleteSource: vi.fn(async () => {}) };
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revokeObjectURL = vi.fn();
    const adapter = new LocalSourceAdapter({ createObjectURL, revokeObjectURL }, storage);
    const older = adapter.listImages(source);
    const newer = adapter.listImages(source);
    const blob = new Blob(['new'], { type: 'image/png' });
    resolveFirst([{ sourceId: source.id, id: 'old', name: 'old.png', type: blob.type, size: blob.size, blob, createdAt: 1 }]);
    await expect(older).resolves.toMatchObject({ images: [], error: { code: 'unknown' } });
    resolveSecond([{ sourceId: source.id, id: 'new', name: 'new.png', type: blob.type, size: blob.size, blob, createdAt: 2 }]);
    await expect(newer).resolves.toMatchObject({ images: [{ id: 'new', url: 'blob:3' }] });
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('does not publish URLs when disposed while a list is awaiting storage', async () => {
    let resolveRecords!: (records: LocalImageRecord[]) => void;
    const pending = new Promise<LocalImageRecord[]>((resolve) => { resolveRecords = resolve; });
    const storage = { listLocal: vi.fn(() => pending), putLocal, deleteSource: vi.fn(async () => {}) };
    const createObjectURL = vi.fn(() => 'blob:late');
    const adapter = new LocalSourceAdapter({ createObjectURL }, storage);
    const loading = adapter.listImages(source);
    adapter.dispose();
    const blob = new Blob(['late'], { type: 'image/png' });
    resolveRecords([{ sourceId: source.id, id: 'late', name: 'late.png', type: blob.type, size: blob.size, blob, createdAt: 1 }]);
    await expect(loading).resolves.toMatchObject({ images: [], error: { code: 'unknown' } });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('invalidates an in-flight list before deleting its source records', async () => {
    let resolveRecords!: (records: LocalImageRecord[]) => void;
    const pending = new Promise<LocalImageRecord[]>((resolve) => { resolveRecords = resolve; });
    const storage = { listLocal: vi.fn(() => pending), putLocal, deleteSource: vi.fn(async () => {}) };
    const createObjectURL = vi.fn(() => 'blob:deleted');
    const adapter = new LocalSourceAdapter({ createObjectURL }, storage);
    const loading = adapter.listImages(source);
    await adapter.deleteSource(source.id);
    const blob = new Blob(['deleted'], { type: 'image/png' });
    resolveRecords([{ sourceId: source.id, id: 'deleted', name: 'deleted.png', type: blob.type, size: blob.size, blob, createdAt: 1 }]);
    await expect(loading).resolves.toMatchObject({ images: [], error: { code: 'unknown' } });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('never imports records after this adapter has deleted a source', async () => {
    const adapter = new LocalSourceAdapter();
    await adapter.deleteSource(source.id);
    const result = await adapter.importFiles(source.id, [new File(['image'], 'after.png', { type: 'image/png' })], () => 'after');
    expect(result).toMatchObject({ imported: 0, failures: [{ fileName: 'after.png', error: { code: 'validation' } }] });
    expect(await listLocal(source.id)).toEqual([]);
  });

  it('keeps a source usable when its storage deletion fails and makes only a later successful deletion terminal', async () => {
    const blob = new Blob(['existing'], { type: 'image/png' });
    const records: LocalImageRecord[] = [{ sourceId: source.id, id: 'existing', name: 'existing.png', type: blob.type, size: blob.size, blob, createdAt: 1 }];
    const deleteSource = vi.fn().mockRejectedValueOnce(new Error('private delete failure')).mockImplementationOnce(async () => { records.length = 0; });
    const storage = {
      listLocal: vi.fn(async () => records),
      putLocal: vi.fn(async (record: LocalImageInput) => { records.push(record); }),
      deleteSource
    };
    const adapter = new LocalSourceAdapter({ createObjectURL: () => 'blob:usable' }, storage);

    await expect(adapter.deleteSource(source.id)).rejects.toThrow();
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: true, images: [{ id: 'existing' }] });
    await expect(adapter.importFiles(source.id, [new File(['new'], 'new.png', { type: 'image/png' })], () => 'new')).resolves.toMatchObject({ imported: 1 });

    await adapter.deleteSource(source.id);
    await expect(adapter.listImages(source)).resolves.toMatchObject({ ok: false, error: { code: 'validation' } });
    await expect(adapter.importFiles(source.id, [new File(['late'], 'late.png', { type: 'image/png' })], () => 'late')).resolves.toMatchObject({ imported: 0 });
  });

  it('queues source deletion behind an in-progress import batch', async () => {
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
    const deleted = vi.fn(async () => {});
    const adapter = new LocalSourceAdapter({}, { listLocal, putLocal, deleteSource: deleted });
    const importing = adapter.importFiles(source.id, [new File(['image'], 'one.png', { type: 'image/png' })], () => 'one', async () => saving);
    const deleting = adapter.deleteSource(source.id);
    await Promise.resolve();
    expect(deleted).not.toHaveBeenCalled();
    releaseSave();
    await importing;
    await deleting;
    expect(deleted).toHaveBeenCalledWith(source.id);
  });

  it('rejects an import as soon as deletion starts and never writes it after deletion succeeds', async () => {
    let finishDelete!: () => void;
    const deleting = new Promise<void>((resolve) => { finishDelete = resolve; });
    const put = vi.fn(async () => undefined);
    const adapter = new LocalSourceAdapter({}, { listLocal, putLocal: put, deleteSource: vi.fn(() => deleting) });

    const deletion = adapter.deleteSource(source.id);
    const importResult = adapter.importFiles(source.id, [new File(['late'], 'late.png', { type: 'image/png' })], () => 'late');
    await expect(importResult).resolves.toMatchObject({ imported: 0, failures: [{ error: { code: 'validation' } }] });
    finishDelete(); await deletion;
    expect(put).not.toHaveBeenCalled();
  });
});

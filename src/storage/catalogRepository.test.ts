import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { IndexedDbCatalogRepository, MemoryCatalogRepository, type CatalogRecord, type CatalogRepository } from './catalogRepository';

function record(sourceId: string, fingerprint: string): CatalogRecord {
  return {
    sourceId,
    sourceType: 'direct',
    fingerprint,
    images: [
      { id: 'second', sourceId, url: 'https://internal.example/second.jpg' },
      { id: 'first', sourceId, url: 'https://internal.example/first.jpg' }
    ],
    totalCount: 2,
    warnings: [{ code: 'parse', message: 'Safe warning.' }],
    fetchedAt: 42
  };
}

async function exercise(repository: CatalogRepository): Promise<void> {
  const sourceId = `catalog-${crypto.randomUUID()}`;
  const first = record(sourceId, 'a'.repeat(64));
  const second = record(sourceId, 'b'.repeat(64));
  await repository.put(first); await repository.put(second);

  const restartedView = await repository.get(sourceId, first.fingerprint);
  expect(restartedView?.images.map((entry) => entry.id)).toEqual(['second', 'first']);
  expect(Object.keys(restartedView!).sort()).toEqual(['fetchedAt', 'fingerprint', 'images', 'sourceId', 'sourceType', 'totalCount', 'warnings']);
  expect(JSON.stringify(restartedView)).not.toMatch(/password|authorization|bearer/i);

  await repository.delete(sourceId, first.fingerprint);
  await expect(repository.get(sourceId, first.fingerprint)).resolves.toBeUndefined();
  await expect(repository.get(sourceId, second.fingerprint)).resolves.toBeDefined();
  await repository.delete(sourceId);
  await expect(repository.get(sourceId, second.fingerprint)).resolves.toBeUndefined();
}

describe('catalog repositories', () => {
  it('keeps ordered fingerprint namespaces in memory', async () => exercise(new MemoryCatalogRepository()));
  it('rejects protected records with query-bearing URLs before they reach storage', async () => {
    const repository = new MemoryCatalogRepository();
    const unsafe = { ...record('protected', 'd'.repeat(64)), sourceType: 'json-api' as const, images: [{ id: 'one', sourceId: 'protected', url: 'https://internal.example/image.jpg?sig=private' }] as CatalogRecord['images'] };
    await expect(repository.put(unsafe)).rejects.toThrow('cannot be persisted');
    await expect(repository.get(unsafe.sourceId, unsafe.fingerprint)).resolves.toBeUndefined();
  });
  it.each(['webdav', 'json-api'] as const)('never persists a %s catalog, even when its URLs look public, and removes legacy records on read', async (sourceType) => {
    const repository = new MemoryCatalogRepository();
    const protectedRecord: CatalogRecord = { ...record(`protected-${sourceType}`, 'f'.repeat(64)), sourceType };
    await expect(repository.put(protectedRecord)).rejects.toThrow('cannot be persisted');
    const records = (repository as unknown as { records: Map<string, CatalogRecord> }).records;
    records.set(JSON.stringify([protectedRecord.sourceId, protectedRecord.fingerprint]), structuredClone(protectedRecord));
    await expect(repository.get(protectedRecord.sourceId, protectedRecord.fingerprint)).resolves.toBeUndefined();
    expect(records.size).toBe(0);
  });
  it.each(['direct', 'tmdb', 'webdav', 'json-api'] as const)('rejects unsafe URL-bearing fields for %s and removes legacy unsafe records on read', async (sourceType) => {
    const repository = new MemoryCatalogRepository();
    const unsafe: CatalogRecord = { ...record(`unsafe-${sourceType}`, 'e'.repeat(64)), sourceType, images: [{ id: 'one', sourceId: `unsafe-${sourceType}`, url: 'https://safe.example/image.jpg', sourceUrl: 'https://user:password@return.example/page#private', authorUrl: 'https://author.example/?token=secret', attribution: 'Photo — https://credit.example/?sig=secret' }] };
    await expect(repository.put(unsafe)).rejects.toThrow('cannot be persisted');
    const records = (repository as unknown as { records: Map<string, CatalogRecord> }).records;
    records.set(JSON.stringify([unsafe.sourceId, unsafe.fingerprint]), structuredClone(unsafe));
    await expect(repository.get(unsafe.sourceId, unsafe.fingerprint)).resolves.toBeUndefined();
    expect(records.size).toBe(0);
  });
  it('persists ordered fingerprint namespaces across IndexedDB repository instances', async () => {
    const firstWorker = new IndexedDbCatalogRepository();
    const sourceId = `restart-${crypto.randomUUID()}`; const stored = record(sourceId, 'c'.repeat(64));
    await firstWorker.put(stored);
    const restartedWorker = new IndexedDbCatalogRepository();
    await expect(restartedWorker.get(sourceId, stored.fingerprint)).resolves.toEqual(stored);
    await exercise(restartedWorker);
    await restartedWorker.delete(sourceId);
  });
});

import 'fake-indexeddb/auto';

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearAllLocalData, deleteLocal, deleteSource, listLocal, listPendingLocalCleanups, markPendingLocalImport, putLocal, reorderLocal } from './imageDb';

const databaseName = 'newpictab';

function blob(contents = 'image', type = 'image/png'): Blob {
  // fake-indexeddb uses Node's structured-clone implementation, which retains this Blob.
  return new NodeBlob([contents], { type }) as unknown as Blob;
}

function record(sourceId: string, id: string, imageBlob = blob()) {
  return { sourceId, id, name: `${id}.png`, type: 'image/png', size: imageBlob.size, blob: imageBlob, createdAt: 42 };
}

async function removeDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database remained open'));
  });
}

describe('imageDb', () => {
  let originalBlob: typeof Blob;
  beforeEach(async () => {
    originalBlob = globalThis.Blob;
    Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true });
    await removeDatabase();
  });
  afterEach(async () => {
    await removeDatabase();
    Object.defineProperty(globalThis, 'Blob', { value: originalBlob, configurable: true });
  });

  it('orders local blobs by createdAt, then id, then sourceId without changing the blob', async () => {
    const preservedBlob = blob('preserved');
    await putLocal({ ...record('z-source', 'a', preservedBlob), createdAt: 10 });
    await putLocal({ ...record('a-source', 'z'), createdAt: 2 });

    const images = await listLocal();
    expect(images.map(({ sourceId, id }) => `${sourceId}/${id}`)).toEqual(['a-source/z', 'z-source/a']);
    expect(images[1]?.blob).toEqual(preservedBlob);
    await expect(images[1]?.blob.text()).resolves.toBe('preserved');
  });

  it('keeps matching ids from different sources as distinct records', async () => {
    await putLocal(record('first', 'same'));
    await putLocal(record('second', 'same'));

    expect((await listLocal()).map((image) => image.sourceId)).toEqual(['first', 'second']);
  });

  it('deletes exactly one image by its source/id key', async () => {
    await putLocal(record('source', 'one'));
    await putLocal(record('source', 'two'));
    await deleteLocal('source', 'one');

    expect((await listLocal('source')).map((image) => image.id)).toEqual(['two']);
  });

  it('deletes every image owned by a source without touching other sources', async () => {
    await putLocal(record('source-a', 'one'));
    await putLocal(record('source-a', 'two'));
    await putLocal(record('source-b', 'one'));
    await deleteSource('source-a');

    expect((await listLocal()).map((image) => `${image.sourceId}/${image.id}`)).toEqual(['source-b/one']);
  });

  it('persists an explicit per-source order atomically', async () => {
    await putLocal({ ...record('source', 'one'), createdAt: 1 });
    await putLocal({ ...record('source', 'two'), createdAt: 2 });
    await putLocal({ ...record('source', 'three'), createdAt: 3 });

    await reorderLocal('source', ['three', 'one', 'two']);

    expect((await listLocal('source')).map((item) => item.id)).toEqual(['three', 'one', 'two']);
  });

  it('rejects an invalid write before it can create a partial transaction', async () => {
    await expect(putLocal({ ...record('source', 'bad'), blob: {} as Blob })).rejects.toThrow(/Blob/);
    expect(await listLocal()).toEqual([]);
  });

  it('rejects blob lookalikes and records whose metadata does not match their blob', async () => {
    await expect(putLocal({ ...record('source', 'spoof'), blob: { size: 5, type: 'image/png' } as Blob })).rejects.toThrow(/Blob/);
    await expect(putLocal({ ...record('source', 'wrong-size'), size: 99 })).rejects.toThrow(/type and size/);
    await expect(putLocal({ ...record('source', 'wrong-type'), type: 'image/jpeg' })).rejects.toThrow(/type and size/);
    const fake = { size: 5, type: 'image/png', slice: () => fake, arrayBuffer: async () => new ArrayBuffer(0), [Symbol.toStringTag]: 'Blob' } as unknown as Blob;
    await expect(putLocal({ ...record('source', 'spoofed-brand'), blob: fake, size: 5 })).rejects.toThrow(/Blob/);
  });

  it('propagates a failed IndexedDB write and leaves no partial record', async () => {
    const input = record('source', 'broken');
    let nameReads = 0;
    Object.defineProperty(input, 'name', {
      get: () => {
        nameReads += 1;
        if (nameReads > 1) throw new Error('cannot clone record');
        return 'broken.png';
      }
    });

    await expect(putLocal(input)).rejects.toThrow();
    expect(await listLocal()).toEqual([]);
  });

  it('clears local image blobs and cleanup journals in one database transaction', async () => {
    await putLocal(record('source', 'one'));
    await markPendingLocalImport('source');

    await clearAllLocalData();

    expect(await listLocal()).toEqual([]);
    expect(await listPendingLocalCleanups()).toEqual([]);
  });
});

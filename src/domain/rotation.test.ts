import { describe, expect, it } from 'vitest';

import {
  ShuffleBag,
  nextSequential,
  resolveImageFallback,
  validImageIds
} from './rotation';

describe('nextSequential', () => {
  it('wraps forwards and backwards and ignores invalid ids', () => {
    const ids = ['a', '', 'b', 'c'];

    expect(nextSequential(ids, 'c')).toBe('a');
    expect(nextSequential(ids, 'a', 'previous')).toBe('c');
  });

  it('returns null for an empty collection and keeps the only valid item', () => {
    expect(nextSequential([], 'a')).toBeNull();
    expect(nextSequential(['', 'only'], 'only')).toBe('only');
  });

  it('starts at the first or last valid image when the current id is absent', () => {
    expect(nextSequential(['a', 'b', 'c'], 'missing')).toBe('a');
    expect(nextSequential(['a', 'b', 'c'], 'missing', 'previous')).toBe('c');
  });
});

describe('ShuffleBag', () => {
  it('uses a Fisher-Yates bag to visit every valid id once per round', () => {
    const bag = new ShuffleBag(['a', '', 'b', 'c'], { rng: () => 0 });

    expect(validImageIds(['a', '', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect([bag.next(), bag.next(), bag.next()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('removes duplicate ids so a round cannot repeat an image', () => {
    const bag = new ShuffleBag(['a', 'a', 'b'], { rng: () => 0 });

    expect(validImageIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect([bag.next(), bag.next()].sort()).toEqual(['a', 'b']);
  });

  it('does not immediately repeat the previous image when another id exists', () => {
    const bag = new ShuffleBag(['a', 'b'], { rng: () => 0, lastId: 'a' });

    expect(bag.next()).toBe('b');
    expect(bag.next()).toBe('a');
    expect(bag.next()).toBe('b');
  });

  it('selects the first post-last item uniformly before shuffling the remainder', () => {
    expect(new ShuffleBag(['a', 'b', 'c'], { lastId: 'a', rng: () => 0 }).next()).toBe('b');
    expect(new ShuffleBag(['a', 'b', 'c'], { lastId: 'a', rng: () => 0.5 }).next()).toBe('c');
    expect(new ShuffleBag(['a', 'b', 'c'], { lastId: 'a', rng: () => 0.999 }).next()).toBe('c');
  });

  it('returns null for no valid ids and permits the sole id to repeat', () => {
    expect(new ShuffleBag(['', '  '], { rng: () => 0 }).next()).toBeNull();
    const bag = new ShuffleBag(['one'], { rng: () => 0, lastId: 'one' });
    expect(bag.next()).toBe('one');
  });
});

describe('resolveImageFallback', () => {
  const bundled = { id: 'bundled', sourceId: 'bundled' };
  const cached = [{ id: 'cached-a', sourceId: 'local' }, { id: 'cached-b', sourceId: 'local' }];

  it('uses requested, then another cached image, then last successful, then bundled', () => {
    expect(resolveImageFallback({ requested: { id: 'wanted', sourceId: 'remote' }, cached, lastSuccessful: { id: 'last', sourceId: 'remote' }, bundled })).toMatchObject({ id: 'wanted' });
    expect(resolveImageFallback({ requested: { id: '', sourceId: 'remote' }, cached, lastSuccessful: { id: 'last', sourceId: 'remote' }, bundled })).toMatchObject({ id: 'cached-a' });
    expect(resolveImageFallback({ requested: { id: '', sourceId: 'remote' }, cached: [{ id: '', sourceId: 'local' }], lastSuccessful: { id: 'last', sourceId: 'remote' }, bundled })).toMatchObject({ id: 'last' });
    expect(resolveImageFallback({ cached: [], lastSuccessful: { id: '', sourceId: 'remote' }, bundled })).toMatchObject({ id: 'bundled' });
  });

  it('excludes a failed requested id from every fallback tier', () => {
    const failed = { id: 'failed', sourceId: 'remote' };
    const anotherCached = { id: 'cached', sourceId: 'local' };

    expect(resolveImageFallback({ requested: failed, failedIds: ['failed'], cached: [failed, anotherCached], lastSuccessful: { id: 'last', sourceId: 'remote' }, bundled })).toBe(anotherCached);
    expect(resolveImageFallback({ requested: failed, failedIds: ['failed'], cached: [failed], lastSuccessful: { id: 'last', sourceId: 'remote' }, bundled })).toMatchObject({ id: 'last' });
    expect(resolveImageFallback({ requested: failed, failedIds: ['failed'], cached: [failed], lastSuccessful: failed, bundled })).toBe(bundled);
  });
});

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RotationCursorStore } from '../backgroundCursor';
import type { BackgroundImage } from './useBackgroundRotation';
import { decodeBackgroundImage, isTextEditingTarget, useBackgroundRotation } from './useBackgroundRotation';

const one: BackgroundImage = { id: 'one', sourceId: 'source', url: 'https://images.test/one.jpg' };
const two: BackgroundImage = { id: 'two', sourceId: 'source', url: 'https://images.test/two.jpg' };
const three: BackgroundImage = { id: 'three', sourceId: 'source', url: 'https://images.test/three.jpg' };

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMemoryCursorStore(values = new Map<string, string>()): RotationCursorStore {
  const queues = new Map<string, Promise<void>>();
  const enqueue = <T,>(scope: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(scope) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    queues.set(scope, result.then(() => undefined, () => undefined));
    return result;
  };
  return {
    claim(scope, candidateIds) {
      return enqueue(scope, async () => {
        const lastId = values.get(scope);
        const lastIndex = lastId === undefined ? -1 : candidateIds.indexOf(lastId);
        const candidate = candidateIds[lastIndex >= 0 ? (lastIndex + 1) % candidateIds.length : 0] ?? null;
        if (candidate !== null) values.set(scope, candidate);
        return candidate;
      });
    },
    updateLatest(scope, imageId) {
      return enqueue(scope, async () => { values.set(scope, imageId); });
    }
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useBackgroundRotation', () => {
  it('attaches legacy load handlers before assigning src', async () => {
    const calls: string[] = [];
    class LegacyImage {
      private listeners = new Map<string, () => void>();

      addEventListener(type: string, listener: () => void): void {
        calls.push(`listen:${type}`);
        this.listeners.set(type, listener);
      }

      set src(_value: string) {
        calls.push('src');
        this.listeners.get('load')?.();
      }
    }
    vi.stubGlobal('Image', LegacyImage);

    const decoding = decodeBackgroundImage(one);

    expect(calls).toEqual(['listen:load', 'listen:error', 'src']);
    await decoding;
  });

  it('bounds default image decoding and clears the underlying Image on timeout', async () => {
    vi.useFakeTimers();
    const hanging = deferred();
    const assigned: string[] = [];
    class HangingImage {
      decode = vi.fn(() => hanging.promise);
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      set src(value: string) { assigned.push(value); }
    }
    vi.stubGlobal('Image', HangingImage);

    const decoding = decodeBackgroundImage(one, 25);
    const rejected = expect(decoding).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(assigned).toEqual([one.url, '']);
    hanging.reject(new Error('late rejection'));
    await Promise.resolve();
  });

  it('publishes an initial image only after it decodes', async () => {
    const pending = deferred();
    const decodeImage = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], decodeImage })
    );

    expect(result.current.current).toBeNull();
    expect(decodeImage).toHaveBeenCalledWith(one, expect.any(AbortSignal));

    await act(async () => pending.resolve());

    expect(result.current.current).toEqual(one);
    expect(result.current.previous).toBeNull();
  });

  it('uses shuffle order for the first image in this new-tab lifecycle', async () => {
    const { result } = renderHook(() =>
      useBackgroundRotation({
        entries: [one, two, three],
        order: 'shuffle',
        rng: () => 0.5,
        decodeImage: vi.fn().mockResolvedValue(undefined)
      })
    );

    await waitFor(() => expect(result.current.current).toEqual(two));
  });

  it('continues sequential new-tab rotation after unmounting and mounting again', async () => {
    const cursors = new Map<string, string>();
    const cursorStore = createMemoryCursorStore(cursors);
    const decodeImage = vi.fn().mockResolvedValue(undefined);

    const firstTab = renderHook(() => useBackgroundRotation({
      entries: [one, two, three],
      changeOn: 'new-tab',
      generation: 'generation-a',
      cursorStore,
      decodeImage
    }));
    await waitFor(() => expect(firstTab.result.current.current).toEqual(one));
    firstTab.unmount();

    const secondTab = renderHook(() => useBackgroundRotation({
      entries: [one, two, three],
      changeOn: 'new-tab',
      generation: 'generation-a',
      cursorStore,
      decodeImage
    }));

    await waitFor(() => expect(secondTab.result.current.current).toEqual(two));
    expect([...cursors.values()]).toEqual(['two']);
  });

  it('persists the latest successfully decoded manual image for the next tab', async () => {
    const values = new Map<string, string>();
    const cursorStore = createMemoryCursorStore(values);
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const firstTab = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'manual', cursorStore, decodeImage
    }));
    await waitFor(() => expect(firstTab.result.current.current).toEqual(one));
    await act(async () => firstTab.result.current.goNext());
    expect(firstTab.result.current.current).toEqual(two);
    firstTab.unmount();

    const secondTab = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'manual', cursorStore, decodeImage
    }));

    await waitFor(() => expect(secondTab.result.current.current).toEqual(three));
  });

  it('isolates persisted cursors by source and generation', async () => {
    const values = new Map<string, string>();
    const cursorStore = createMemoryCursorStore(values);
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const first = renderHook(() => useBackgroundRotation({
      entries: [one, two], generation: 'a', cursorStore, decodeImage
    }));
    await waitFor(() => expect(first.result.current.current).toEqual(one));
    first.unmount();

    const nextGeneration = renderHook(() => useBackgroundRotation({
      entries: [one, two], generation: 'b', cursorStore, decodeImage
    }));

    await waitFor(() => expect(nextGeneration.result.current.current).toEqual(one));
    expect(values.size).toBe(2);
  });

  it('claims distinct candidates without holding the cross-tab lock during decode', async () => {
    const values = new Map<string, string>();
    const cursorStore = createMemoryCursorStore(values);
    const firstDecode = deferred();
    const decodeImage = vi.fn((image: BackgroundImage) => image.id === 'one' ? firstDecode.promise : Promise.resolve());

    const tabA = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'shared', cursorStore, decodeImage
    }));
    await waitFor(() => expect(decodeImage).toHaveBeenCalledWith(one, expect.any(AbortSignal)));
    const tabB = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'shared', cursorStore, decodeImage
    }));

    await waitFor(() => expect(tabB.result.current.current).toEqual(two));
    expect(tabA.result.current.current).toBeNull();
    firstDecode.resolve();
    await waitFor(() => expect(tabA.result.current.current).toEqual(one));
  });

  it('keeps ArrowRight and ArrowLeft local after another tab advances the global cursor', async () => {
    const values = new Map<string, string>();
    const cursorStore = createMemoryCursorStore(values);
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const tabA = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'interleaved', cursorStore, decodeImage
    }));
    await waitFor(() => expect(tabA.result.current.current).toEqual(one));
    const tabB = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], generation: 'interleaved', cursorStore, decodeImage
    }));
    await waitFor(() => expect(tabB.result.current.current).toEqual(two));

    await act(async () => tabA.result.current.goNext());
    expect(tabA.result.current.current).toEqual(two);
    await act(async () => tabA.result.current.goPrevious());
    expect(tabA.result.current.current).toEqual(one);
  });

  it('does not decode a stale claim after unmount', async () => {
    const claiming = deferred();
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const cursorStore = {
      claim: vi.fn(async () => { await claiming.promise; return 'one'; }),
      updateLatest: vi.fn().mockResolvedValue(undefined)
    };
    const tab = renderHook(() => useBackgroundRotation({
      entries: [one, two], generation: 'stale', cursorStore, decodeImage
    }));
    await waitFor(() => expect(cursorStore.claim).toHaveBeenCalled());

    tab.unmount();
    claiming.resolve();
    await act(async () => claiming.promise);

    expect(decodeImage).not.toHaveBeenCalled();
  });

  it('automatically tries the remaining initial candidates after a decode failure', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'one') throw new Error('cannot decode');
    });
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two, three], decodeImage })
    );

    await waitFor(() => expect(result.current.current).toEqual(two));
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['one', 'two']);
    expect(result.current.failedIds).toEqual(['one']);
  });

  it('tries the complete forward sequential sequence during one manual navigation', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() => useBackgroundRotation({ entries: [one, two, three], decodeImage }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    decodeImage.mockClear();

    await act(async () => result.current.goNext());

    expect(result.current.current).toEqual(three);
    expect(result.current.failedIds).toEqual(['two']);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['two', 'three']);
  });

  it('tries every unique non-current shuffle candidate in the same navigation', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    decodeImage.mockClear();

    await act(async () => result.current.goNext());

    expect(result.current.current).toEqual(three);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['two', 'three']);
  });

  it('maintains one shuffle round without repeats until every image is shown', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    await act(async () => result.current.goNext());

    expect(decodeImage.mock.calls.slice(0, 3).map(([image]) => image.id)).toEqual(['one', 'two', 'three']);
  });

  it('keeps every full shuffle window fair across round boundaries', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    for (let index = 0; index < 5; index += 1) {
      await act(async () => result.current.goNext());
    }
    const shown = decodeImage.mock.calls.slice(0, 6).map(([image]) => image.id);

    expect(new Set(shown.slice(0, 3))).toEqual(new Set(['one', 'two', 'three']));
    expect(new Set(shown.slice(3, 6))).toEqual(new Set(['one', 'two', 'three']));
  });

  it('resets the pending shuffle round when the generation changes', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ generation }) => useBackgroundRotation({
        entries: [one, two, three], generation, order: 'shuffle', rng: () => 0, decodeImage
      }),
      { initialProps: { generation: 1 } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);

    rerender({ generation: 2 });

    await waitFor(() => expect(result.current.current).toEqual(one));
    decodeImage.mockClear();
    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(one);
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it('resets the pending shuffle round when source entries change', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ sourceEntries }) => useBackgroundRotation({
        entries: sourceEntries, order: 'shuffle', rng: () => 0, decodeImage
      }),
      { initialProps: { sourceEntries: [one, two, three] } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);

    rerender({ sourceEntries: [one, three, two] });

    await waitFor(() => expect(result.current.current).toEqual(one));
  });

  it('removes a failed shuffle item from the current and following rounds', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);
    await act(async () => result.current.goNext());

    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['one', 'two', 'three', 'one', 'three']);
  });

  it('preserves the unclaimed shuffle order when initialization claims a non-head item', async () => {
    const claims = vi.fn().mockResolvedValue('three');
    const updates = vi.fn().mockResolvedValue(undefined);
    const cursorStore: RotationCursorStore = { claim: claims, updateLatest: updates };
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three],
      generation: 'claimed-shuffle',
      order: 'shuffle',
      rng: () => 0,
      cursorStore,
      decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(three));

    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);
    expect(claims).toHaveBeenCalledTimes(1);
  });

  it('uses shuffle display history for next, previous, then next before consuming the queue', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);

    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(one);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['one', 'two', 'one', 'two', 'three']);
  });

  it('walks backward and forward through occurrence history across a repeated-id round boundary', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    await act(async () => result.current.goNext());
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);

    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(three);
    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(two);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);
  });

  it('bounds shuffle occurrence history while retaining recent previous navigation', async () => {
    const historyLimit = 72;
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    for (let index = 0; index < historyLimit + 4; index += 1) await act(async () => result.current.goNext());
    decodeImage.mockClear();

    for (let index = 0; index < historyLimit + 4; index += 1) await act(async () => result.current.goPrevious());

    expect(decodeImage.mock.calls.length).toBeLessThanOrEqual(historyLimit - 1);
  });

  it('makes previous a safe no-op before shuffle history has an older occurrence', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    decodeImage.mockClear();

    await act(async () => result.current.goPrevious());

    expect(result.current.current).toEqual(one);
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it('removes a newly failed historical occurrence and fixes the history position', async () => {
    let failTwo = false;
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (failTwo && image.id === 'two') throw new Error('stale historical image');
    });
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    failTwo = true;
    decodeImage.mockClear();

    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(one);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['two', 'one']);
    decodeImage.mockClear();

    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['three']);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);
    expect(result.current.failedIds).toEqual(['two']);
  });

  it('continues past a failed interval candidate within the same tick', async () => {
    vi.useFakeTimers();
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], changeOn: 'interval', intervalMinutes: 1, decodeImage
    }));
    await act(async () => Promise.resolve());
    expect(result.current.current).toEqual(one);
    decodeImage.mockClear();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(result.current.current).toEqual(three);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).toEqual(['two', 'three']);
  });

  it('times out a hanging injected decoder, ignores its late rejection, and continues', async () => {
    vi.useFakeTimers();
    const hanging = deferred();
    const decodeImage = vi.fn((image: BackgroundImage) => image.id === 'one' ? hanging.promise : Promise.resolve());
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two], decodeImage, decodeTimeoutMs: 20, operationBudgetMs: 60
    }));

    await act(async () => vi.advanceTimersByTimeAsync(20));

    expect(result.current.current).toEqual(two);
    expect(result.current.failedIds).toEqual(['one']);
    hanging.reject(new Error('late rejection'));
    await act(async () => Promise.resolve());
  });

  it('bounds the whole operation even when every injected decoder hangs', async () => {
    vi.useFakeTimers();
    const decodeImage = vi.fn(() => new Promise<void>(() => undefined));
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two, three], decodeImage, decodeTimeoutMs: 20, operationBudgetMs: 35
    }));

    await act(async () => vi.advanceTimersByTimeAsync(35));

    expect(result.current.current).toBeNull();
    expect(result.current.isDecoding).toBe(false);
    expect(decodeImage).toHaveBeenCalledTimes(2);
  });

  it('stops after every initial candidate fails and preserves an already displayed image', async () => {
    let failAll = false;
    const decodeImage = vi.fn(async () => {
      if (failAll) throw new Error('cannot decode');
    });
    const { result, rerender } = renderHook(
      ({ generation }) => useBackgroundRotation({ entries: [one, two, three], generation, decodeImage }),
      { initialProps: { generation: 1 } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));

    failAll = true;
    decodeImage.mockClear();
    rerender({ generation: 2 });

    await waitFor(() => expect(result.current.isDecoding).toBe(false));
    expect(result.current.current).toEqual(one);
    expect(result.current.failedIds).toEqual(['two', 'three']);
    expect(decodeImage).toHaveBeenCalledTimes(2);
  });

  it('moves in both directions and exposes the image being replaced', async () => {
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], decodeImage: vi.fn().mockResolvedValue(undefined) })
    );
    await waitFor(() => expect(result.current.current).toEqual(one));

    await act(async () => result.current.goNext());
    expect(result.current).toMatchObject({ current: two, previous: one, direction: 'next' });

    await act(async () => result.current.goPrevious());
    expect(result.current).toMatchObject({ current: one, previous: two, direction: 'previous' });
  });

  it('continues sequentially across appended windows and can step back over the boundary', async () => {
    const window = Array.from({ length: 13 }, (_, index): BackgroundImage => ({
      id: String(index), sourceId: 'remote', url: `https://images.test/${index}.jpg`
    }));
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ entries }) => useBackgroundRotation({ entries, incrementalEntries: true, generation: 'remote', decodeImage }),
      { initialProps: { entries: window.slice(0, 12) } }
    );
    await waitFor(() => expect(result.current.current?.id).toBe('0'));
    for (let id = 1; id <= 9; id += 1) await act(async () => result.current.goNext());

    rerender({ entries: window });
    await act(async () => result.current.goNext());
    expect(result.current.current?.id).toBe('10');
    await act(async () => result.current.goNext());
    expect(result.current.current?.id).toBe('11');
    await act(async () => result.current.goNext());
    expect(result.current.current?.id).toBe('12');
    await act(async () => result.current.goPrevious());
    expect(result.current.current?.id).toBe('11');
  });

  it('uses appended entries on the next interval tick without restarting at the first entry', async () => {
    vi.useFakeTimers();
    const window = Array.from({ length: 13 }, (_, index): BackgroundImage => ({ id: String(index), sourceId: 'remote', url: `https://images.test/${index}.jpg` }));
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ entries }) => useBackgroundRotation({ entries, incrementalEntries: true, generation: 'remote', changeOn: 'interval', intervalMinutes: 1, decodeImage }),
      { initialProps: { entries: window.slice(0, 12) } }
    );
    await act(async () => Promise.resolve());
    for (let id = 1; id <= 9; id += 1) await act(async () => result.current.goNext());
    rerender({ entries: window });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(result.current.current?.id).toBe('10');
  });

  it('keeps the current shuffle bag and valid history when entries append and old entries prune', async () => {
    const four: BackgroundImage = { id: 'four', sourceId: 'source', url: 'blob:four' };
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ entries }) => useBackgroundRotation({ entries, incrementalEntries: true, generation: 'remote', order: 'shuffle', rng: () => 0, decodeImage }),
      { initialProps: { entries: [one, two, three] } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(two);

    rerender({ entries: [one, two, three, four] });
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(three);
    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(two);

    rerender({ entries: [two, three, four] });
    decodeImage.mockClear();
    await act(async () => result.current.goPrevious());
    expect(result.current.current).toEqual(two);
    expect(decodeImage.mock.calls.map(([image]) => image.id)).not.toContain('one');
  });

  it('keeps the current image visible while a source reset waits for replacement entries', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const { result, rerender } = renderHook(
      ({ sourceResetKey }) => useBackgroundRotation({ entries: [one, two], sourceResetKey, generation: 'stable', decodeImage }),
      { initialProps: { sourceResetKey: 'source-a' }, wrapper }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.previous).toEqual(one);

    rerender({ sourceResetKey: 'source-b' });

    expect(result.current.current).toEqual(two);
    expect(result.current.previous).toBeNull();
    expect(result.current.failedIds).toEqual([]);
  });

  it('keeps the displayed image and records the failed id when a candidate cannot decode', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], decodeImage, generation: 1 })
    );
    await waitFor(() => expect(result.current.current).toEqual(one));

    await act(async () => result.current.goNext());

    expect(result.current.current).toEqual(one);
    expect(result.current.previous).toBeNull();
    expect(result.current.failedIds).toEqual(['two']);
  });

  it('removes failed candidates from later shuffle rounds', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two, three], order: 'shuffle', rng: () => 0, decodeImage })
    );
    await waitFor(() => expect(result.current.current).toEqual(one));

    await act(async () => result.current.goNext());
    expect(result.current.failedIds).toEqual(['two']);
    expect(result.current.current).toEqual(three);
    await act(async () => result.current.goNext());
    expect(result.current.current).toEqual(one);
    await act(async () => result.current.goNext());

    expect(result.current.current).toEqual(three);
  });

  it('resets failed ids for a new source generation', async () => {
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two') throw new Error('cannot decode');
    });
    const { result, rerender } = renderHook(
      ({ generation }) => useBackgroundRotation({ entries: [one, two], decodeImage, generation }),
      { initialProps: { generation: 1 } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.failedIds).toEqual(['two']);

    rerender({ generation: 2 });

    await waitFor(() => expect(result.current.failedIds).toEqual([]));
  });

  it('distinguishes numeric and string generations and resets their failure state', async () => {
    let failTwo = true;
    const scopes: string[] = [];
    const cursorStore: RotationCursorStore = {
      async claim(scope, candidates) {
        scopes.push(scope);
        return candidates[0] ?? null;
      },
      async updateLatest() { return undefined; }
    };
    const decodeImage = vi.fn(async (image: BackgroundImage) => {
      if (image.id === 'two' && failTwo) throw new Error('cannot decode');
    });
    const { result, rerender } = renderHook(
      ({ generation }: { generation: number | string }) => useBackgroundRotation({
        entries: [one, two], generation, cursorStore, decodeImage
      }),
      { initialProps: { generation: 1 as number | string } }
    );
    await waitFor(() => expect(result.current.current).toEqual(one));
    await act(async () => result.current.goNext());
    expect(result.current.failedIds).toEqual(['two']);

    failTwo = false;
    rerender({ generation: '1' });

    await waitFor(() => expect(result.current.current).toEqual(two));
    expect(result.current.failedIds).toEqual([]);
    expect(new Set(scopes).size).toBe(2);
  });

  it('uses a short stable cursor scope when no generation is provided', async () => {
    const entries = Array.from({ length: 2_000 }, (_, index): BackgroundImage => ({
      id: `image-${index}`,
      sourceId: 'large-source',
      url: `https://images.test/${index}.jpg`
    }));
    let scope = '';
    const cursorStore: RotationCursorStore = {
      async claim(value, candidates) {
        scope = value;
        return candidates[0] ?? null;
      },
      async updateLatest() { return undefined; }
    };
    renderHook(() => useBackgroundRotation({
      entries, cursorStore, decodeImage: vi.fn().mockResolvedValue(undefined)
    }));

    await waitFor(() => expect(scope).not.toBe(''));
    expect(scope.length).toBeLessThan(100);
  });

  it('keeps initialization and repeated arrow keys in a single decode flight', async () => {
    const initial = deferred();
    const next = deferred();
    const decodeImage = vi.fn((image: BackgroundImage) => image.id === 'one' ? initial.promise : next.promise);
    const { result } = renderHook(() => useBackgroundRotation({ entries: [one, two, three], decodeImage }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(decodeImage).toHaveBeenCalledTimes(1);
    initial.resolve();
    await waitFor(() => expect(result.current.current).toEqual(one));

    const firstNavigation = result.current.goNext();
    const overlappingNavigation = result.current.goNext();
    expect(decodeImage).toHaveBeenCalledTimes(2);
    next.resolve();
    await act(async () => Promise.all([firstNavigation, overlappingNavigation]));
    expect(decodeImage).toHaveBeenCalledTimes(2);
  });

  it('allows reverse navigation after the image is displayed while cursor persistence is still pending', async () => {
    const pendingCursorUpdate = deferred();
    let updateCalls = 0;
    const cursorStore: RotationCursorStore = {
      async claim(_scope, candidateIds) {
        return candidateIds[0] ?? null;
      },
      async updateLatest() {
        updateCalls += 1;
        if (updateCalls === 1) await pendingCursorUpdate.promise;
      }
    };
    const { result } = renderHook(() => useBackgroundRotation({
      entries: [one, two],
      cursorStore,
      decodeImage: vi.fn().mockResolvedValue(undefined)
    }));
    await waitFor(() => expect(result.current.current).toEqual(one));

    const nextNavigation = result.current.goNext();
    await waitFor(() => expect(result.current.current).toEqual(two));
    void result.current.goPrevious();

    await waitFor(() => expect(result.current.current).toEqual(one));
    pendingCursorUpdate.resolve();
    await act(async () => nextNavigation);
  });

  it('coalesces overlapping interval ticks while a decode is pending', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    let initial = true;
    const decodeImage = vi.fn(() => {
      if (initial) { initial = false; return Promise.resolve(); }
      return pending.promise;
    });
    renderHook(() => useBackgroundRotation({
      entries: [one, two, three],
      changeOn: 'interval',
      intervalMinutes: 1,
      decodeImage,
      decodeTimeoutMs: 300_000,
      operationBudgetMs: 300_000
    }));
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(120_000));

    expect(decodeImage).toHaveBeenCalledTimes(2);
    pending.resolve();
  });

  it('aborts a hanging decode on unmount and safely absorbs its late rejection', async () => {
    const pending = deferred();
    let first = true;
    let navigationSignal: AbortSignal | undefined;
    const decodeImage = vi.fn((_image: BackgroundImage, signal?: AbortSignal) => {
      if (first) { first = false; return Promise.resolve(); }
      navigationSignal = signal;
      return pending.promise;
    });
    const tab = renderHook(() => useBackgroundRotation({ entries: [one, two], decodeImage }));
    await waitFor(() => expect(tab.result.current.current).toEqual(one));

    const navigation = tab.result.current.goNext();
    await waitFor(() => expect(navigationSignal).toBeDefined());
    tab.unmount();

    await expect(navigation).resolves.toBeUndefined();
    expect(navigationSignal?.aborted).toBe(true);
    pending.reject(new Error('late rejection'));
    await Promise.resolve();
  });

  it('handles arrow keys but ignores editable targets', async () => {
    const decodeImage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], decodeImage })
    );
    await waitFor(() => expect(result.current.current).toEqual(one));

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await act(async () => Promise.resolve());
    expect(result.current.current).toEqual(one);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await waitFor(() => expect(result.current.current).toEqual(two));

    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    expect(isTextEditingTarget(textbox)).toBe(true);
    expect(isTextEditingTarget(document.body)).toBe(false);
  });

  it('schedules only interval mode and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const decodeImage = vi.fn().mockResolvedValue(undefined);

    const newTab = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], changeOn: 'new-tab', intervalMinutes: 2, decodeImage })
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
    newTab.unmount();

    const interval = renderHook(() =>
      useBackgroundRotation({ entries: [one, two], changeOn: 'interval', intervalMinutes: 2, decodeImage })
    );
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);

    interval.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ShuffleBag, type SequentialDirection } from '../../domain/rotation';
import type { AppearanceSettings, RotationOrder } from '../../domain/types';
import type { RotationCursorStore } from '../backgroundCursor';

export interface BackgroundImage {
  id: string;
  sourceId: string;
  url: string;
  description?: string;
}

export type BackgroundDirection = SequentialDirection;

export interface BackgroundRotationState {
  current: BackgroundImage | null;
  previous: BackgroundImage | null;
  direction: BackgroundDirection;
  failedIds: string[];
  isDecoding: boolean;
  goNext: () => Promise<void>;
  goPrevious: () => Promise<void>;
}

export interface UseBackgroundRotationOptions {
  entries: readonly BackgroundImage[];
  order?: RotationOrder;
  changeOn?: AppearanceSettings['changeOn'];
  intervalMinutes?: number;
  /** Change this value when a source refresh creates a new failure generation. */
  generation?: string | number;
  decodeImage?: (image: BackgroundImage, signal?: AbortSignal) => Promise<void>;
  decodeTimeoutMs?: number;
  operationBudgetMs?: number;
  rng?: () => number;
  cursorStore?: RotationCursorStore;
  /** Keep the current image while a remote metadata window is replaced. */
  incrementalEntries?: boolean;
  /** Synchronously clears display state before a newly selected source can paint. */
  sourceResetKey?: string | number;
}

interface DisplayState {
  current: BackgroundImage | null;
  previous: BackgroundImage | null;
  direction: BackgroundDirection;
  failedIds: string[];
  isDecoding: boolean;
}

interface Flight {
  direction: BackgroundDirection;
  request: number;
  controller: AbortController;
  promise: Promise<void>;
}

interface ShuffleHistoryNode {
  occurrence: number;
  image: BackgroundImage;
}

interface OperationCandidate {
  image: BackgroundImage;
  historyOccurrence?: number;
  fromShuffleQueue: boolean;
}

const INITIAL_STATE: DisplayState = {
  current: null,
  previous: null,
  direction: 'next',
  failedIds: [],
  isDecoding: false
};

export const DEFAULT_DECODE_TIMEOUT_MS = 15_000;
export const DEFAULT_OPERATION_BUDGET_MS = 30_000;
const MAX_SHUFFLE_HISTORY = 72;

class TimedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimedOperationError';
  }
}

class CancelledOperationError extends Error {
  constructor() {
    super('Background operation was cancelled.');
    this.name = 'CancelledOperationError';
  }
}

function finiteDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, value) : fallback;
}

export function decodeBackgroundImage(
  entry: BackgroundImage,
  timeoutMs = DEFAULT_DECODE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  const image = new Image();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, cancelImage = false) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      image.removeEventListener?.('load', onLoad);
      image.removeEventListener?.('error', onError);
      if (cancelImage) image.src = '';
      if (error === undefined) resolve();
      else reject(error);
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error('Image decoding failed.'));
    const onAbort = () => finish(new CancelledOperationError(), true);
    const timer = window.setTimeout(
      () => finish(new TimedOperationError('Image decoding timed out.'), true),
      finiteDuration(timeoutMs, DEFAULT_DECODE_TIMEOUT_MS)
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (typeof image.decode === 'function') {
      image.src = entry.url;
      let decoding: Promise<void>;
      try {
        decoding = image.decode();
      } catch (error) {
        finish(error);
        return;
      }
      void decoding.then(() => finish(), (error) => finish(error));
      return;
    }

    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    image.src = entry.url;
  });
}

function runBounded(
  operation: () => Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(new CancelledOperationError());
    const timer = window.setTimeout(
      () => finish(new TimedOperationError(timeoutMessage)),
      finiteDuration(timeoutMs, 1)
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let result: Promise<void>;
    try {
      result = operation();
    } catch (error) {
      finish(error);
      return;
    }
    void result.then(() => finish(), (error) => finish(error));
  });
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])') !== null;
}

function uniqueSourceEntries(entries: readonly BackgroundImage[]): BackgroundImage[] {
  const sourceId = entries[0]?.sourceId;
  if (!sourceId) return [];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.sourceId !== sourceId || seen.has(entry.id) || entry.id.length === 0) return false;
    seen.add(entry.id);
    return true;
  });
}

function sequentialCandidates(
  entries: readonly BackgroundImage[],
  current: BackgroundImage | null,
  direction: BackgroundDirection,
  failedIds: ReadonlySet<string>
): BackgroundImage[] {
  if (entries.length === 0) return [];
  const currentIndex = current === null
    ? -1
    : entries.findIndex((entry) => entry.id === current.id && entry.sourceId === current.sourceId);
  const start = currentIndex >= 0
    ? currentIndex
    : direction === 'next' ? -1 : 0;
  const candidates: BackgroundImage[] = [];

  for (let offset = 1; offset <= entries.length; offset += 1) {
    const delta = direction === 'next' ? offset : -offset;
    const index = (start + delta + entries.length) % entries.length;
    const entry = entries[index]!;
    const isCurrent = current?.id === entry.id && current.sourceId === entry.sourceId;
    if (!isCurrent && !failedIds.has(entry.id)) candidates.push(entry);
  }
  return candidates;
}

function shuffledCandidates(
  entries: readonly BackgroundImage[],
  current: BackgroundImage | null,
  failedIds: ReadonlySet<string>,
  rng?: () => number
): BackgroundImage[] {
  const available = entries.filter((entry) => !failedIds.has(entry.id));
  const byId = new Map(available.map((entry) => [entry.id, entry]));
  const bag = new ShuffleBag([...byId.keys()], { lastId: current?.id, rng });
  const candidates: BackgroundImage[] = [];
  for (let index = 0; index < byId.size; index += 1) {
    const id = bag.next();
    const entry = id === null ? undefined : byId.get(id);
    if (entry) candidates.push(entry);
  }
  return candidates;
}

function generationToken(generation: string | number | undefined): string {
  if (generation === undefined) return 'auto:v1';
  if (typeof generation === 'string') return `string:${generation}`;
  if (Number.isNaN(generation)) return 'number:NaN';
  if (Object.is(generation, -0)) return 'number:-0';
  return `number:${String(generation)}`;
}

export function useBackgroundRotation({
  entries,
  order = 'sequential',
  changeOn = 'new-tab',
  intervalMinutes = 5,
  generation,
  decodeImage,
  decodeTimeoutMs = DEFAULT_DECODE_TIMEOUT_MS,
  operationBudgetMs = DEFAULT_OPERATION_BUDGET_MS,
  rng,
  cursorStore,
  incrementalEntries = false,
  sourceResetKey
}: UseBackgroundRotationOptions): BackgroundRotationState {
  const entrySignature = useMemo(
    () => JSON.stringify(entries.map(({ id, sourceId, url }) => [sourceId, id, url])),
    [entries]
  );
  const encodedGeneration = generationToken(generation);
  const generationKey = incrementalEntries ? encodedGeneration : `${encodedGeneration}\u0000${entrySignature}`;
  const cursorScope = JSON.stringify([entries[0]?.sourceId ?? '', encodedGeneration]);
  const [state, setState] = useState<DisplayState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const entriesRef = useRef(entries);
  const decodeRef = useRef(decodeImage);
  const rngRef = useRef(rng);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const failedRef = useRef(new Set<string>());
  const shuffleQueueRef = useRef<BackgroundImage[]>([]);
  const shuffleHistoryRef = useRef<ShuffleHistoryNode[]>([]);
  const shuffleHistoryIndexRef = useRef(-1);
  const shuffleOccurrenceRef = useRef(0);
  const flightRef = useRef<Flight | null>(null);

  stateRef.current = state;
  entriesRef.current = entries;
  decodeRef.current = decodeImage;
  rngRef.current = rng;

  const publish = useCallback((next: DisplayState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const runOperation = useCallback(async (
    direction: BackgroundDirection,
    request: number,
    signal: AbortSignal,
    claimInitialCandidate: boolean
  ): Promise<void> => {
    if (!mountedRef.current || signal.aborted || request !== requestRef.current) return;
    const sourceEntries = uniqueSourceEntries(entriesRef.current);
    let candidates: OperationCandidate[];
    if (order === 'shuffle') {
      const validIds = new Set(sourceEntries.map((entry) => entry.id));
      shuffleQueueRef.current = shuffleQueueRef.current.filter((entry) =>
        validIds.has(entry.id) && !failedRef.current.has(entry.id)
      );

      const history = shuffleHistoryRef.current;
      const historyIndex = shuffleHistoryIndexRef.current;
      const historyNodes = direction === 'previous'
        ? history.slice(0, historyIndex).reverse()
        : historyIndex >= 0 && historyIndex < history.length - 1
          ? history.slice(historyIndex + 1)
          : [];

      if (historyNodes.length > 0 || direction === 'previous') {
        candidates = historyNodes
          .filter((node) => !failedRef.current.has(node.image.id))
          .map((node) => ({
            image: node.image,
            historyOccurrence: node.occurrence,
            fromShuffleQueue: false
          }));
      } else {
        if (shuffleQueueRef.current.length === 0) {
          shuffleQueueRef.current = shuffledCandidates(
            sourceEntries,
            stateRef.current.current,
            failedRef.current,
            rngRef.current
          );
        }
        candidates = shuffleQueueRef.current
          .filter((entry) =>
            !(stateRef.current.current?.id === entry.id && stateRef.current.current.sourceId === entry.sourceId)
          )
          .map((image) => ({ image, fromShuffleQueue: true }));
      }
    } else {
      candidates = sequentialCandidates(
        sourceEntries,
        stateRef.current.current,
        direction,
        failedRef.current
      ).map((image) => ({ image, fromShuffleQueue: false }));
    }
    const remaining = [...candidates];
    const deadline = Date.now() + finiteDuration(operationBudgetMs, DEFAULT_OPERATION_BUDGET_MS);
    publish({ ...stateRef.current, isDecoding: remaining.length > 0 });

    while (remaining.length > 0 && mountedRef.current && !signal.aborted && request === requestRef.current) {
      const budgetBeforeClaim = deadline - Date.now();
      if (budgetBeforeClaim <= 0) break;

      let operationCandidate: OperationCandidate | undefined;
      if (cursorStore && claimInitialCandidate) {
        try {
          let claimedId: string | null = null;
          await runBounded(async () => {
            claimedId = await cursorStore.claim(cursorScope, remaining.map(({ image }) => image.id));
          }, budgetBeforeClaim, signal, 'Background cursor claim timed out.');
          const index = remaining.findIndex(({ image }) => image.id === claimedId);
          if (index < 0) break;
          operationCandidate = remaining.splice(index, 1)[0];
        } catch (error) {
          if (error instanceof CancelledOperationError || error instanceof TimedOperationError) break;
          operationCandidate = remaining.shift();
        }
      } else {
        operationCandidate = remaining.shift();
      }
      if (!operationCandidate) break;
      const candidate = operationCandidate.image;
      if (failedRef.current.has(candidate.id)) continue;
      if (order === 'shuffle' && operationCandidate.fromShuffleQueue) {
        shuffleQueueRef.current = shuffleQueueRef.current.filter((entry) => entry.id !== candidate!.id);
      }

      const remainingBudget = deadline - Date.now();
      if (remainingBudget <= 0) break;
      const candidateTimeout = Math.min(
        finiteDuration(decodeTimeoutMs, DEFAULT_DECODE_TIMEOUT_MS),
        remainingBudget
      );

      try {
        await runBounded(
          () => decodeRef.current
            ? decodeRef.current(candidate!, signal)
            : decodeBackgroundImage(candidate!, candidateTimeout, signal),
          candidateTimeout,
          signal,
          'Image decoding timed out.'
        );
      } catch (error) {
        if (error instanceof CancelledOperationError) break;
        if (!mountedRef.current || request !== requestRef.current) return;
        failedRef.current.add(candidate.id);
        if (order === 'shuffle') {
          shuffleQueueRef.current = shuffleQueueRef.current.filter((entry) => entry.id !== candidate!.id);
          const currentHistoryNode = shuffleHistoryRef.current[shuffleHistoryIndexRef.current];
          shuffleHistoryRef.current = shuffleHistoryRef.current.filter((node) =>
            node.occurrence === currentHistoryNode?.occurrence || node.image.id !== candidate!.id
          );
          shuffleHistoryIndexRef.current = currentHistoryNode
            ? shuffleHistoryRef.current.findIndex((node) => node.occurrence === currentHistoryNode.occurrence)
            : Math.min(shuffleHistoryIndexRef.current, shuffleHistoryRef.current.length - 1);
        }
        publish({ ...stateRef.current, failedIds: [...failedRef.current], isDecoding: remaining.length > 0 });
        continue;
      }

      if (!mountedRef.current || signal.aborted || request !== requestRef.current) return;
      if (order === 'shuffle') {
        if (operationCandidate.historyOccurrence !== undefined) {
          shuffleHistoryIndexRef.current = shuffleHistoryRef.current.findIndex(
            (node) => node.occurrence === operationCandidate.historyOccurrence
          );
        } else {
          const node: ShuffleHistoryNode = {
            occurrence: ++shuffleOccurrenceRef.current,
            image: candidate
          };
          shuffleHistoryRef.current = [...shuffleHistoryRef.current, node].slice(-MAX_SHUFFLE_HISTORY);
          shuffleHistoryIndexRef.current = shuffleHistoryRef.current.length - 1;
        }
      }
      const displayed = stateRef.current.current;
      publish({
        current: candidate,
        previous: displayed?.id === candidate.id && displayed.sourceId === candidate.sourceId ? null : displayed,
        direction,
        failedIds: [...failedRef.current],
        isDecoding: false
      });
      if (cursorStore && !claimInitialCandidate) {
        const updateBudget = deadline - Date.now();
        if (updateBudget > 0) {
          try {
            await runBounded(
              () => cursorStore.updateLatest(cursorScope, candidate!.id),
              updateBudget,
              signal,
              'Background cursor update timed out.'
            );
          } catch {
            // A displayed image remains valid if cursor persistence is unavailable.
          }
        }
      }
      return;
    }

    if (mountedRef.current && request === requestRef.current) {
      publish({ ...stateRef.current, isDecoding: false });
    }
  }, [cursorScope, cursorStore, decodeTimeoutMs, operationBudgetMs, order, publish]);

  const startFlight = useCallback((
    direction: BackgroundDirection,
    request?: number,
    claimInitialCandidate = false
  ): Promise<void> => {
    const existing = flightRef.current;
    if (existing && !existing.controller.signal.aborted) {
      if (existing.direction === direction || stateRef.current.isDecoding) return existing.promise;
      existing.controller.abort();
      flightRef.current = null;
    }

    const flightRequest = request ?? ++requestRef.current;
    const controller = new AbortController();
    const promise = runOperation(direction, flightRequest, controller.signal, claimInitialCandidate);
    const flight: Flight = { direction, request: flightRequest, controller, promise };
    flightRef.current = flight;
    void promise.then(() => {
      if (flightRef.current === flight) flightRef.current = null;
    });
    return promise;
  }, [runOperation]);

  const goNext = useCallback(() => startFlight('next'), [startFlight]);
  const goPrevious = useCallback(() => startFlight('previous'), [startFlight]);

  useLayoutEffect(() => {
    requestRef.current += 1;
    flightRef.current?.controller.abort();
    flightRef.current = null;
    failedRef.current = new Set();
    shuffleQueueRef.current = [];
    shuffleHistoryRef.current = [];
    shuffleHistoryIndexRef.current = -1;
    shuffleOccurrenceRef.current = 0;
    publish({ ...INITIAL_STATE, current: stateRef.current.current });
  }, [publish, sourceResetKey]);

  useLayoutEffect(() => {
    if (!incrementalEntries) return;
    const entryById = new Map(entries.map((entry) => [`${entry.sourceId}\u0000${entry.id}`, entry]));
    const currentEntry = (image: BackgroundImage | null): BackgroundImage | null =>
      image ? entryById.get(`${image.sourceId}\u0000${image.id}`) ?? null : null;
    shuffleQueueRef.current = shuffleQueueRef.current.flatMap((image) => currentEntry(image) ?? []);
    const currentNode = shuffleHistoryRef.current[shuffleHistoryIndexRef.current];
    shuffleHistoryRef.current = shuffleHistoryRef.current.flatMap((node) => {
      const image = currentEntry(node.image);
      return image ? [{ ...node, image }] : [];
    });
    shuffleHistoryIndexRef.current = currentNode
      ? shuffleHistoryRef.current.findIndex((node) => node.occurrence === currentNode.occurrence)
      : -1;
    const current = currentEntry(stateRef.current.current) ?? stateRef.current.current;
    const previous = currentEntry(stateRef.current.previous);
    if (current !== stateRef.current.current || previous !== stateRef.current.previous) {
      publish({ ...stateRef.current, current, previous });
    }
  }, [entries, entrySignature, incrementalEntries, publish]);

  useEffect(() => {
    mountedRef.current = true;
    flightRef.current?.controller.abort();
    flightRef.current = null;
    const request = ++requestRef.current;
    failedRef.current = new Set();
    shuffleQueueRef.current = [];
    shuffleHistoryRef.current = [];
    shuffleHistoryIndexRef.current = -1;
    shuffleOccurrenceRef.current = 0;
    publish({ ...INITIAL_STATE, current: stateRef.current.current });
    void startFlight('next', request, true);

    return () => {
      requestRef.current += 1;
      flightRef.current?.controller.abort();
      flightRef.current = null;
    };
  }, [generationKey, publish, startFlight]);

  useEffect(() => () => {
    mountedRef.current = false;
    requestRef.current += 1;
    flightRef.current?.controller.abort();
    flightRef.current = null;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target)) return;
      if (event.key === 'ArrowRight') void goNext();
      if (event.key === 'ArrowLeft') void goPrevious();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrevious]);

  useEffect(() => {
    if (changeOn !== 'interval') return;
    const safeMinutes = Number.isFinite(intervalMinutes) ? Math.max(1, intervalMinutes) : 1;
    const timer = window.setInterval(() => void goNext(), safeMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [changeOn, goNext, intervalMinutes]);

  return { ...state, goNext, goPrevious };
}

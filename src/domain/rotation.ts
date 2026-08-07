export interface ImageIdentity {
  id: string;
  sourceId: string;
}

export type SequentialDirection = 'next' | 'previous';

export function validImageIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0))];
}

export function nextSequential(
  ids: readonly string[],
  currentId: string | null | undefined,
  direction: SequentialDirection = 'next'
): string | null {
  const validIds = validImageIds(ids);
  if (validIds.length === 0) return null;

  const currentIndex = currentId === undefined || currentId === null ? -1 : validIds.indexOf(currentId);
  if (currentIndex === -1) return direction === 'next' ? validIds[0] ?? null : validIds.at(-1) ?? null;

  const offset = direction === 'next' ? 1 : -1;
  return validIds[(currentIndex + offset + validIds.length) % validIds.length] ?? null;
}

export interface ShuffleBagOptions {
  rng?: () => number;
  lastId?: string | null;
}

/** A shuffle-once bag. Every valid id is yielded once before the next shuffle. */
export class ShuffleBag {
  private readonly ids: string[];
  private readonly rng: () => number;
  private bag: string[] = [];
  private lastId: string | null;

  constructor(ids: readonly string[], options: ShuffleBagOptions = {}) {
    this.ids = validImageIds(ids);
    this.rng = options.rng ?? Math.random;
    this.lastId = options.lastId ?? null;
  }

  next(): string | null {
    if (this.ids.length === 0) return null;
    if (this.bag.length === 0) this.bag = this.createRound();

    const next = this.bag.pop() ?? null;
    if (next !== null) this.lastId = next;
    return next;
  }

  private createRound(): string[] {
    const candidates = this.ids.filter((id) => this.ids.length === 1 || id !== this.lastId);
    const first = candidates[Math.floor(this.normalizedRandom() * candidates.length)]!;
    const round = this.ids.filter((id) => id !== first);
    for (let index = round.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.normalizedRandom() * (index + 1));
      [round[index], round[other]] = [round[other]!, round[index]!];
    }
    // The bag is popped, so append the unbiased first choice last.
    return [...round, first];
  }

  private normalizedRandom(): number {
    const value = this.rng();
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.9999999999999999) : 0;
  }
}

export interface ImageFallbackOptions<T extends ImageIdentity> {
  requested?: T | null;
  /** IDs that failed to load during this recovery attempt. */
  failedIds?: readonly string[];
  cached: readonly T[];
  lastSuccessful?: T | null;
  bundled: T;
}

function isValidImage<T extends ImageIdentity>(image: T | null | undefined): image is T {
  return image !== null && image !== undefined && image.id.trim().length > 0 && image.sourceId.trim().length > 0;
}

/** Selects images in the recovery order: request, cache, last success, bundled fallback. */
export function resolveImageFallback<T extends ImageIdentity>(options: ImageFallbackOptions<T>): T {
  const failedIds = new Set(options.failedIds);
  const isEligible = (image: T | null | undefined): image is T => isValidImage(image) && !failedIds.has(image.id);

  if (isEligible(options.requested)) return options.requested;
  const cached = options.cached.find(isEligible);
  if (cached) return cached;
  if (isEligible(options.lastSuccessful)) return options.lastSuccessful;
  return options.bundled;
}

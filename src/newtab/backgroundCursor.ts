import { getLocal, setLocal } from '../lib/chrome';
import { withAuxiliaryStorageWriteLock } from '../storage/maintenance';

export interface RotationCursorStore {
  /** Atomically records and returns one candidate. Consumer work happens after this resolves. */
  claim(scope: string, candidateIds: readonly string[]): Promise<string | null>;
  /** Records a successful local navigation without influencing that navigation's selection. */
  updateLatest(scope: string, imageId: string): Promise<void>;
}

const CURSOR_PREFIX = 'pictab-background-cursor:';
const fallbackQueues = new Map<string, Promise<void>>();

function storageKey(scope: string): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(scope)}`;
}

function withFallbackLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = fallbackQueues.get(name) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  fallbackQueues.set(name, settled);
  void settled.finally(() => {
    if (fallbackQueues.get(name) === settled) fallbackQueues.delete(name);
  });
  return result;
}

function withCursorLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return withAuxiliaryStorageWriteLock(() => locks ? locks.request(name, operation) : withFallbackLock(name, operation));
}

export function createChromeRotationCursorStore(): RotationCursorStore {
  return {
    async claim(scope, candidateIds) {
      const candidates = [...new Set(candidateIds.filter((id) => id.length > 0))];
      if (candidates.length === 0) return null;
      const name = storageKey(scope);
      const operation = async () => {
        const stored = await getLocal<unknown>(name);
        const lastIndex = typeof stored === 'string' ? candidates.indexOf(stored) : -1;
        const candidate = candidates[lastIndex >= 0 ? (lastIndex + 1) % candidates.length : 0] ?? null;
        if (candidate !== null) await setLocal(name, candidate);
        return candidate;
      };
      return withCursorLock(name, operation);
    },

    async updateLatest(scope, imageId) {
      if (imageId.length === 0) return;
      const name = storageKey(scope);
      await withCursorLock(name, () => setLocal(name, imageId));
    }
  };
}

export const chromeRotationCursorStore = createChromeRotationCursorStore();

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

const runtime = {
  onMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
  },
  sendMessage: vi.fn()
};

const storage = {
  local: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn()
  },
  sync: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn()
  }
};

const permissions = {
  contains: vi.fn(),
  request: vi.fn(),
  remove: vi.fn(),
  getAll: vi.fn()
};

Object.defineProperty(globalThis, 'chrome', {
  value: { runtime, storage, permissions },
  configurable: true,
  writable: true
});

// Node exposes a process-wide LockManager. Tests opt into isolated lock mocks
// explicitly so parallel Vitest files cannot block one another on production names.
if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });

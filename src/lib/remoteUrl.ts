const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:']);

export function isSafeRemoteUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return SAFE_REMOTE_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function canonicalRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return isSafeRemoteUrl(url) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function exactRemoteOriginPattern(input: string): string | undefined {
  try {
    const url = new URL(input);
    return isSafeRemoteUrl(url) ? `${url.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

export function isExactRemoteOriginPattern(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('/*')) return false;
  try {
    const url = new URL(value.slice(0, -1));
    return isSafeRemoteUrl(url) && value === `${url.origin}/*`;
  } catch {
    return false;
  }
}

export function isPlainHttpUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'http:';
  } catch {
    return false;
  }
}

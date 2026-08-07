const REDACTED = '[REDACTED]';
const URL_REDACTED = '[URL REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const SENSITIVE_KEY = /(token|password|passwd|pwd|secret|authorization|api[\s_-]*key|credential|cookie|session|username|user[\s_-]*name)/i;
const PROTECTED_LOCATION_KEY = /(^|[\s_-])(url|uri|href|path|endpoint|query|location)([\s_-]|$)/i;
const URI_PATTERN = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?[^\s"'<>]+/g;
const SAFE_HIERARCHICAL_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ws:', 'wss:']);

export interface RedactionOptions {
  hideUrls?: boolean;
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

export interface DiagnosticOptions extends RedactionOptions {
  maxLength?: number;
}

const DEFAULTS: Required<RedactionOptions> = {
  hideUrls: false,
  maxDepth: 8,
  maxArrayItems: 40,
  maxObjectKeys: 60,
  maxStringLength: 2_000
};

/** Produces a bounded, detached value suitable for settings-only diagnostics. */
export function redactForDiagnostics(value: unknown, options: RedactionOptions = {}): unknown {
  const limits = { ...DEFAULTS, ...options };
  try { return visit(value, limits, new WeakSet<object>(), 0); }
  catch { return '[Unreadable]'; }
}

/** Returns a bounded string that may be copied without exposing source credentials or URL secrets. */
export function copySafeDiagnostic(value: unknown, options: DiagnosticOptions = {}): string {
  const maxLength = Math.max(100, Math.min(options.maxLength ?? 8_000, 50_000));
  const redacted = redactForDiagnostics(value, options);
  let output: string;
  try { output = JSON.stringify(redacted, null, 2) ?? String(redacted); }
  catch { output = JSON.stringify({ error: 'Diagnostic serialization failed.' }); }
  return output.length <= maxLength ? output : `${output.slice(0, Math.max(0, maxLength - TRUNCATED.length))}${TRUNCATED}`;
}

function visit(value: unknown, options: Required<RedactionOptions>, ancestors: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return sanitizeText(value, options);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[Unsupported]';
  if (typeof value === 'symbol') return '[Redacted]';
  if (typeof value === 'bigint' || value === undefined) return String(value);
  if (depth >= options.maxDepth) return '[MAX DEPTH]';
  if (typeof value !== 'object') return sanitizeText(String(value), options);
  let tracked = false;
  try {
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value); tracked = true;
    if (value instanceof Error) {
      return {
        name: sanitizeText(value.name, options),
        message: sanitizeText(value.message, options)
      };
    }
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      return redactRecord(Object.fromEntries(value.entries()), options, ancestors, depth);
    }
    if (typeof URL !== 'undefined' && value instanceof URL) return sanitizeUri(value.toString(), options.hideUrls);
    if (Array.isArray(value)) {
      const selected = value.slice(0, options.maxArrayItems).map((item) => visit(item, options, ancestors, depth + 1));
      if (value.length > options.maxArrayItems) selected.push(TRUNCATED);
      return selected;
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    return redactRecord(value as Record<string, unknown>, options, ancestors, depth);
  } catch {
    return '[Unreadable]';
  } finally {
    if (tracked) {
      try { ancestors.delete(value); } catch { /* A hostile object must not escape diagnostics. */ }
    }
  }
}

function redactRecord(value: Record<string, unknown>, options: Required<RedactionOptions>, ancestors: WeakSet<object>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const snapshot = safeEntries(value);
  if (!snapshot.readable) return { __unreadable__: '[Unreadable]' };
  const entries = snapshot.entries.slice(0, options.maxObjectKeys);
  for (const [key, child] of entries) output[key] = isSensitiveKey(key)
    ? REDACTED
    : options.hideUrls && PROTECTED_LOCATION_KEY.test(splitCamelCase(key))
      ? URL_REDACTED
      : visit(child, options, ancestors, depth + 1);
  if (snapshot.total > options.maxObjectKeys) output.__truncated__ = TRUNCATED;
  return output;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(splitCamelCase(key));
}

function sanitizeText(input: string, options: Required<RedactionOptions>): string {
  let scrubbed = input
    .replace(/\bauthorization\s*:[^\r\n]*/gi, `Authorization: ${REDACTED}`)
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s/, 1)[0]} ${REDACTED}`)
    .replace(URI_PATTERN, (raw) => sanitizeUri(raw, options.hideUrls))
    .replace(/\b(authorization|api[\s_-]*key|token|password|passwd|pwd|secret)\s*[:=]\s*[^\s,;]+/gi, `$1: ${REDACTED}`);
  if (options.hideUrls) scrubbed = scrubbed
    .replace(/(^|[\s("'=])(?:\/|[A-Za-z]:\\)[^\s"',;)]+/g, '$1[PATH REDACTED]')
    .replace(/(^|[\s("'])(?:[?&][A-Za-z0-9_.~-]+=[^\s"',;)]+)/g, '$1[QUERY REDACTED]');
  return scrubbed.length <= options.maxStringLength ? scrubbed : `${scrubbed.slice(0, Math.max(0, options.maxStringLength - TRUNCATED.length))}${TRUNCATED}`;
}

function splitCamelCase(value: string): string { return value.replace(/([a-z])([A-Z])/g, '$1_$2'); }

function sanitizeUri(raw: string, hide: boolean): string {
  if (hide) return URL_REDACTED;
  try {
    const trailing = raw.match(/[),.;!?]+$/)?.[0] ?? '';
    const value = trailing ? raw.slice(0, -trailing.length) : raw;
    const url = new URL(value);
    if (!SAFE_HIERARCHICAL_SCHEMES.has(url.protocol)) return URL_REDACTED;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.toString()}${trailing}`;
  } catch { return URL_REDACTED; }
}

function safeEntries(value: Record<string, unknown>): { entries: [string, unknown][]; total: number; readable: boolean } {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    const entries: [string, unknown][] = keys.map((key) => {
      const descriptor = descriptors[key];
      return [key, descriptor && 'value' in descriptor ? descriptor.value : '[Unreadable]'];
    });
    return { entries, total: keys.length, readable: true };
  } catch {
    return { entries: [], total: 0, readable: false };
  }
}

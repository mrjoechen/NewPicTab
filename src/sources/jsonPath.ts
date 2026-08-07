const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*/;

/** Parses the deliberately small path grammar used for untrusted JSON responses. */
export function parseJsonPath(path: string): Array<string | number> {
  if (typeof path !== 'string' || path.length === 0) throw new Error('JSON path must not be empty.');
  const result: Array<string | number> = [];
  let position = 0;
  let expectKey = true;

  while (position < path.length) {
    if (!expectKey) {
      if (path[position] !== '.') throw new Error('JSON path has invalid syntax.');
      position += 1;
      expectKey = true;
      continue;
    }
    const match = path.slice(position).match(KEY);
    if (!match) throw new Error('JSON path has invalid syntax.');
    const key = match[0];
    if (FORBIDDEN_KEYS.has(key)) throw new Error('JSON path contains a prohibited key.');
    result.push(key);
    position += key.length;
    expectKey = false;

    while (path[position] === '[') {
      const close = path.indexOf(']', position + 1);
      if (close === -1) throw new Error('JSON path has invalid syntax.');
      const indexText = path.slice(position + 1, close);
      if (!/^(0|[1-9][0-9]*)$/.test(indexText)) throw new Error('JSON path array indices must be non-negative integers.');
      const index = Number(indexText);
      if (!Number.isSafeInteger(index)) throw new Error('JSON path array index is too large.');
      result.push(index);
      position = close + 1;
    }
  }
  if (expectKey) throw new Error('JSON path has invalid syntax.');
  return result;
}

/** Returns undefined when a segment is absent or inherited; it never evaluates input. */
export function getJsonPath(value: unknown, path: string | readonly (string | number)[]): unknown {
  const parts = typeof path === 'string' ? parseJsonPath(path) : path;
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

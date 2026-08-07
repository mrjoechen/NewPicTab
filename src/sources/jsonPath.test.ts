import { describe, expect, it } from 'vitest';

import { getJsonPath, parseJsonPath } from './jsonPath';

describe('constrained JSON paths', () => {
  it('traverses own object keys and numeric array indices', () => {
    const value = { data: { items: [{ images: ['one'] }] } };
    expect(parseJsonPath('data.items[0].images')).toEqual(['data', 'items', 0, 'images']);
    expect(getJsonPath(value, 'data.items[0].images')).toEqual(['one']);
    expect(getJsonPath(value, 'data.items')).toEqual([{ images: ['one'] }]);
  });

  it('returns undefined for a missing own property', () => {
    expect(getJsonPath({ data: {} }, 'data.items')).toBeUndefined();
  });

  it.each(['', '.data', 'data.', 'data..items', 'data[-1]', 'data[1.2]', 'data[*]', 'data[0]()', 'data[0].constructor'])
  ('rejects unsafe or invalid syntax: %s', (path) => {
    expect(() => parseJsonPath(path)).toThrow(/path/i);
  });

  it('does not traverse prototype properties or prototype-pollution keys', () => {
    const inherited = Object.create({ secret: 'nope' }) as { data?: unknown };
    inherited.data = { safe: true };
    expect(getJsonPath(inherited, 'secret')).toBeUndefined();
    expect(() => parseJsonPath('__proto__.polluted')).toThrow();
    expect(() => parseJsonPath('data.constructor')).toThrow();
    expect(() => parseJsonPath('data.prototype')).toThrow();
  });
});

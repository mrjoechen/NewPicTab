import { describe, expect, it } from 'vitest';

import { copySafeDiagnostic, redactForDiagnostics } from './redact';

describe('redactForDiagnostics', () => {
  it('recursively clones sensitive keys and authorization headers without mutating input', () => {
    const input = {
      token: 'tmdb-private',
      nested: [{ Password: 'dav-private', headers: { Authorization: 'Bearer json-private', 'X-Api-Key': 'api-private', Accept: 'image/*' } }],
      api_key: 'snake-private',
      clientSecret: 'client-private'
    };

    const result = redactForDiagnostics(input);

    expect(result).toEqual({
      token: '[REDACTED]',
      nested: [{ Password: '[REDACTED]', headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]', Accept: 'image/*' } }],
      api_key: '[REDACTED]',
      clientSecret: '[REDACTED]'
    });
    expect(input.nested[0]?.headers.Authorization).toBe('Bearer json-private');
    expect(JSON.stringify(result)).not.toMatch(/tmdb-private|dav-private|json-private|api-private|client-private/);
  });

  it('sanitizes Errors, URL credentials and query strings, bearer/basic values, and protected paths', () => {
    const error = new Error('GET https://ada:pw@dav.example.test/private/photos.jpg?token=url-secret Authorization: Basic basic-secret Bearer bearer-secret');
    const result = redactForDiagnostics({ error, endpoint: 'https://api.example.test/v1/private?api_key=query-secret' }, { hideUrls: true });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/ada|pw|private\/photos|url-secret|basic-secret|bearer-secret|query-secret|api\.example/);
    expect(serialized).toContain('[URL REDACTED]');
    expect(serialized).toContain('[REDACTED]');
  });

  it('bounds cycles, depth, arrays, object keys, and diagnostic output size safely', () => {
    const cyclic: Record<string, unknown> = { public: 'ok', huge: 'x'.repeat(20_000) };
    cyclic.self = cyclic;
    cyclic.deep = { one: { two: { three: { four: 'hidden' } } } };
    cyclic.items = Array.from({ length: 200 }, (_, index) => ({ index, token: `secret-${index}` }));
    for (let index = 0; index < 200; index += 1) cyclic[`field-${index}`] = index;

    const redacted = redactForDiagnostics(cyclic, { maxDepth: 3, maxArrayItems: 4, maxObjectKeys: 8, maxStringLength: 30 });
    const diagnostic = copySafeDiagnostic(cyclic, { maxLength: 800 });

    expect(JSON.stringify(redacted)).toContain('[Circular]');
    expect(JSON.stringify(redacted)).toContain('[TRUNCATED]');
    expect(diagnostic.length).toBeLessThanOrEqual(800);
    expect(diagnostic).not.toContain('secret-0');
  });

  it('redacts native Headers case-insensitively while retaining harmless values', () => {
    const headers = new Headers({ authorization: 'Bearer hidden', 'x-api-key': 'hidden-too', accept: 'application/json' });

    expect(redactForDiagnostics(headers)).toEqual({ accept: 'application/json', authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' });
  });

  it('removes protected source usernames, path fields, query fields, and path-like message fragments', () => {
    const result = redactForDiagnostics({ username: 'private-user', path: '/customers/acme/photo.jpg', query: 'cursor=signed-value', message: 'failed at /customers/acme/photo.jpg?sig=signed-value' }, { hideUrls: true });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/private-user|customers|acme|photo|signed-value/);
  });

  it('redacts credentials and payloads from every URI scheme, including URL objects', () => {
    const values = [
      new URL('ftp://user:password@example.test/private?token=secret#fragment'),
      'wss://user:password@example.test/socket?token=secret',
      'file:///Users/private/secret.txt',
      'data:text/plain;base64,cHJpdmF0ZS1zZWNyZXQ=',
      'blob:https://example.test/private-id',
      'mailto:private@example.test?subject=secret',
      'custom-scheme:private-secret',
      'x://user:password@example.test/private?token=secret',
      'z:opaque-private-secret'
    ];

    const output = copySafeDiagnostic(values, { hideUrls: true });

    expect(output).not.toMatch(/user|password|private|secret|example\.test|cHJp/);
    expect(output).toContain('[URL REDACTED]');
  });

  it('uses fixed sentinels for functions and symbols instead of copying source or descriptions', () => {
    const secretFunction = function privateCredentialFunction() { return 'raw-private-secret'; };
    const output = copySafeDiagnostic([secretFunction, Symbol('raw-private-secret')]);

    expect(output).toContain('[Unsupported]');
    expect(output).toContain('[Redacted]');
    expect(output).not.toMatch(/privateCredentialFunction|raw-private-secret/);
  });

  it('redacts Bearer and Basic Authorization headers even when no optional whitespace follows the colon', () => {
    const output = copySafeDiagnostic('Authorization:Bearer bearer-private Authorization:Basic basic-private');

    expect(output).not.toMatch(/bearer-private|basic-private/);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts the complete value of arbitrary Authorization schemes', () => {
    const output = copySafeDiagnostic('Authorization:ApiKey api-private\nAuthorization: AWS4-HMAC-SHA256 Credential=aws-private, SignedHeaders=host\nsafe line');

    expect(output).not.toMatch(/api-private|aws-private|SignedHeaders/);
    expect(output).toContain('safe line');
    expect(output).toContain('[REDACTED]');
  });

  it('never throws for revoked proxies or hostile reflection traps', () => {
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys secret'); }, getPrototypeOf: () => { throw new Error('prototype secret'); } });

    expect(() => redactForDiagnostics(proxy)).not.toThrow();
    expect(() => copySafeDiagnostic(hostile)).not.toThrow();
    expect(copySafeDiagnostic([proxy, hostile])).not.toMatch(/ownKeys secret|prototype secret/);
  });
});

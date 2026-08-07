import { describe, expect, it, vi } from 'vitest';

import type { WebDavSourceConfig } from '../domain/types';
import { WebDavSourceAdapter } from './webdav';

const source: WebDavSourceConfig = {
  id: 'dav', name: 'Photos', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1,
  url: 'https://dav.example.test/photos', username: '阿达', password: '密碼', includeSubdirectories: false
};

function response(xml: string, status = 207, headers: Record<string, string> = {}): Response {
  return new Response(xml, { status, headers: { 'Content-Type': 'application/xml', ...headers } });
}

function multistatus(items: string): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items}</d:multistatus>`;
}

function item(href: string, contentType = 'image/jpeg', status = 'HTTP/1.1 200 OK', collection = false): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection ? '<d:collection/>' : ''}</d:resourcetype><d:getcontenttype>${contentType}</d:getcontenttype><d:getcontentlength>123</d:getcontentlength><d:getlastmodified>Tue, 01 Jan 2030 00:00:00 GMT</d:getlastmodified></d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
}

describe('WebDavSourceAdapter', () => {
  it('parses DAV XML in a service-worker environment without a global DOMParser', async () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      const adapter = new WebDavSourceAdapter(async () => response(multistatus(item('/photos/worker.jpg'))));
      const result = await adapter.listImages(source);
      expect(result.ok && result.images[0]?.url).toBe('https://dav.example.test/photos/worker.jpg');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('validates every required field and normalizes a configured directory URL', async () => {
    const fetcher = vi.fn(async () => response(multistatus(item('/photos/'))));
    const adapter = new WebDavSourceAdapter(fetcher);
    expect(adapter.validateConfig(source)).toEqual({ ok: true });
    for (const bad of [
      { ...source, name: '' }, { ...source, username: '' }, { ...source, username: 'ada:admin' }, { ...source, password: '' }, { ...source, password: 3 }, { ...source, includeSubdirectories: 'yes' },
      { ...source, url: 'http://dav.example.test/photos' }, { ...source, url: 'https://a:b@dav.example.test/photos' },
      { ...source, url: 'https://dav.example.test/photos?capability=secret' }, { ...source, url: 'https://dav.example.test/photos#album' }
    ]) expect(adapter.validateConfig(bad)).toMatchObject({ ok: false, error: { code: 'validation' } });
    await adapter.listImages(source);
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe('https://dav.example.test/photos/');
  });

  it('canonicalizes the WebDAV origin root to one trailing slash', async () => {
    const fetcher = vi.fn(async () => response(multistatus(item('/', '', 'HTTP/1.1 200 OK', true))));
    await new WebDavSourceAdapter(fetcher).testConnection({ ...source, url: 'https://dav.example.test/' });
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe('https://dav.example.test/');
  });

  it('preserves a non-default port, Unicode, and a long configured base segment', async () => {
    const longSegment = 'a'.repeat(240);
    const fetcher = vi.fn(async () => response(multistatus('')));
    const result = await new WebDavSourceAdapter(fetcher).testConnection({ ...source, url: `https://dav.example.test:8443/相册/${longSegment}` });
    expect(result).toMatchObject({ ok: true });
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe(`https://dav.example.test:8443/%E7%9B%B8%E5%86%8C/${longSegment}/`);
  });

  it('combines a saved WebDAV root URL with a separate folder path for requests', async () => {
    const fetcher = vi.fn(async () => response(multistatus(item('/photos/%E5%AE%B6%E5%BA%AD%20%E7%9B%B8%E5%86%8C/a.jpg'))));
    const adapter = new WebDavSourceAdapter(fetcher);
    const result = await adapter.listImages({ ...source, url: 'https://dav.example.test/photos/', folderPath: ['家庭 相册'] });

    expect(result.ok && result.images[0]?.url).toBe('https://dav.example.test/photos/%E5%AE%B6%E5%BA%AD%20%E7%9B%B8%E5%86%8C/a.jpg');
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe('https://dav.example.test/photos/%E5%AE%B6%E5%BA%AD%20%E7%9B%B8%E5%86%8C/');
  });

  it('rejects unsafe separate WebDAV folder path segments before a network request', async () => {
    const fetcher = vi.fn(async () => response(multistatus(item('/photos/a.jpg'))));
    const result = await new WebDavSourceAdapter(fetcher).listImages({ ...source, folderPath: ['..'] });

    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses a safe UTF-8 Basic PROPFIND request and never exposes credentials', async () => {
    const fetcher = vi.fn(async () => response(multistatus(item('/photos/a.jpg'))));
    const adapter = new WebDavSourceAdapter(fetcher);
    const result = await adapter.listImages(source);
    const [, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(init.method).toBe('PROPFIND');
    expect(init.redirect).toBe('manual');
    expect(new Headers(init.headers)).toMatchObject({});
    expect(new Headers(init.headers).get('Depth')).toBe('1');
    expect(new Headers(init.headers).get('Content-Type')).toContain('xml');
    expect(new Headers(init.headers).get('Authorization')).toBe('Basic 6Zi/6L6+OuWvhueivA==');
    expect(String(init.body)).toContain('getcontenttype');
    expect(JSON.stringify(result)).not.toContain(source.password);
    expect(JSON.stringify(result)).not.toContain(source.username);
  });

  it('maps only safe image resources from a realistic namespace-independent multi-status fixture', async () => {
    const fixture = multistatus([
      item('/photos/'), item('/photos/space%20cat.JPG'), item('/photos/readme.txt', 'text/plain'), item('/photos/vector.svg', 'image/svg+xml'),
      item('/photos/nested/', '', 'HTTP/1.1 200 OK', true), item('/photos/nope.png', 'image/png', 'HTTP/1.1 404 Nope'),
      item('https://evil.example/x.jpg'), item('/outside/../secret.jpg'), item('/photos/image.avif', '')
    ].join(''));
    const adapter = new WebDavSourceAdapter(async () => response(fixture));
    const result = await adapter.listImages(source);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.images.map((image) => image.url)).toEqual([
      'https://dav.example.test/photos/space%20cat.JPG', 'https://dav.example.test/photos/image.avif'
    ]);
    if (!result.ok) throw new Error('expected images');
    expect(result.images[0]).toMatchObject({ sourceId: source.id, description: 'space cat.JPG' });
    expect(result.images[0].dimensions).toBeUndefined();
    expect(new Set(result.images.map((image) => image.id)).size).toBe(2);
  });

  it('hashes canonical DAV hrefs and never returns protected hrefs from connection tests', async () => {
    const secretHref = '/photos/customer-acme/private-album/photo.jpg?sig=signed-secret';
    const adapter = new WebDavSourceAdapter(async () => response(multistatus(item(secretHref))));
    const listed = await adapter.listImages(source);
    expect(listed.ok && listed.images[0]?.id).toMatch(/^img_[0-9a-f]{64}$/);
    expect(listed.ok && listed.images[0]?.id).not.toContain('private-album');

    const tested = await adapter.testConnection(source);
    expect(tested).toMatchObject({ ok: true, count: 0, imageOrigins: ['https://dav.example.test/*'], preview: [] });
    expect(tested).not.toHaveProperty('entries');
    expect(JSON.stringify(tested)).not.toContain('private-album');
    expect(JSON.stringify(tested)).not.toContain('signed-secret');
  });

  it('rejects encoded separators, dot traversal, and double-encoded traversal without scanning child directories', async () => {
    const malicious = ['%2e%2e/secret/', '%2e%2e%2fsecret/', '%2Fchild/', '%5cchild/', '%252e%252e%252fsecret/'];
    const root = multistatus([item('/', '', 'HTTP/1.1 200 OK', true), ...malicious.map((href) => item(`/${href}`, '', 'HTTP/1.1 200 OK', true))].join(''));
    const fetcher = vi.fn(async () => response(root));
    const result = await new WebDavSourceAdapter(fetcher).listImages({ ...source, url: 'https://dav.example.test/', includeSubdirectories: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('treats percent-encoded unreserved path segments as canonical equivalents', async () => {
    const adapter = new WebDavSourceAdapter(async () => response(multistatus([item('/photos/~user/'), item('/photos/%7Euser/a.jpg')].join(''))));
    const result = await adapter.listImages({ ...source, url: 'https://dav.example.test/photos/%7euser' });
    expect(result.ok && result.images[0]?.url).toBe('https://dav.example.test/photos/~user/a.jpg');
  });

  it('requires a DAV multi-status root and ignores foreign namespace response elements', async () => {
    const wrapped = '<wrapper xmlns="DAV:" xmlns:d="DAV:"><d:multistatus>' + item('/photos/a.jpg') + '</d:multistatus></wrapper>';
    await expect(new WebDavSourceAdapter(async () => response(wrapped)).listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
    const foreign = '<d:multistatus xmlns:d="DAV:" xmlns:f="urn:foreign"><f:response><f:href>/photos/a.jpg</f:href><f:propstat><f:prop><f:getcontenttype>image/jpeg</f:getcontenttype></f:prop><f:status>HTTP/1.1 200 OK</f:status></f:propstat></f:response></d:multistatus>';
    await expect(new WebDavSourceAdapter(async () => response(foreign)).listImages(source)).resolves.toMatchObject({ error: { code: 'empty' } });
  });

  it('recursively breadth-first scans child directories, blocks traversal, and visits loops once', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/photos/')) return response(multistatus([item('/photos/'), item('/photos/nested/', '', 'HTTP/1.1 200 OK', true), item('/evil/', '', 'HTTP/1.1 200 OK', true)].join('')));
      return response(multistatus([item('/photos/nested/a.png', 'image/png'), item('/photos/', '', 'HTTP/1.1 200 OK', true)].join('')));
    });
    const adapter = new WebDavSourceAdapter(fetcher);
    const result = await adapter.listImages({ ...source, includeSubdirectories: true });
    expect(result.ok && result.images.map((entry) => entry.url)).toEqual(['https://dav.example.test/photos/nested/a.png']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes collections without a trailing slash and rejects well-formed non-WebDAV XML', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/photos/')
      ? response(multistatus([item('/photos/'), item('/photos/nested', '', 'HTTP/1.1 200 OK', true)].join('')))
      : response(multistatus(item('/photos/nested/a.gif', 'image/gif'))));
    const result = await new WebDavSourceAdapter(fetcher).listImages({ ...source, includeSubdirectories: true });
    expect(result.ok && result.images[0]?.url).toBe('https://dav.example.test/photos/nested/a.gif');
    await expect(new WebDavSourceAdapter(async () => response('<root/>')).listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
  });

  it('returns partial entries with a warning at the hard resource cap', async () => {
    const many = Array.from({ length: 2002 }, (_, i) => item(`/photos/${i}.jpg`)).join('');
    const result = await new WebDavSourceAdapter(async () => response(multistatus(many))).listImages(source);
    expect(result).toMatchObject({ ok: true, warnings: [expect.objectContaining({ code: 'parse' })] });
    expect(result.images).toHaveLength(2000);
  }, 15_000);

  it('does not report truncation for exactly 2000 non-recursive responses', async () => {
    const exact = Array.from({ length: 2000 }, (_, i) => item(`/photos/${i}.jpg`)).join('');
    const result = await new WebDavSourceAdapter(async () => response(multistatus(exact))).listImages(source);
    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toBeUndefined();
    expect(result.images).toHaveLength(2000);
  }, 15_000);

  it('reports truncation at an exact resource cap when a discovered child directory remains to scan', async () => {
    const root = [
      ...Array.from({ length: 1999 }, (_, i) => item(`/photos/${i}.txt`, 'text/plain')),
      item('/photos/nested/', '', 'HTTP/1.1 200 OK', true)
    ].join('');
    const fetcher = vi.fn(async () => response(multistatus(root)));
    const result = await new WebDavSourceAdapter(fetcher).listImages({ ...source, includeSubdirectories: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'empty' }, warnings: [expect.objectContaining({ code: 'parse', message: 'WebDAV scan was truncated after 2,000 resources.' })] });
    expect(fetcher).toHaveBeenCalledOnce();
  }, 15_000);

  it('requires a 207 Multi-Status response even when another 2xx response has valid XML', async () => {
    const result = await new WebDavSourceAdapter(async () => response(multistatus(item('/photos/a.jpg')), 200)).listImages(source);
    expect(result).toMatchObject({ ok: false, error: { code: 'http', status: 200 } });
  });

  it.each([
    ['auth', 401], ['auth', 403], ['rate-limit', 429], ['http', 500]
  ] as const)('normalizes status %s without credentials leaking', async (code, status) => {
    const result = await new WebDavSourceAdapter(async () => response('secret 密碼', status)).listImages(source);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(source.password);
  });

  it('distinguishes network, timeout, redirect, malformed XML, and an empty listing', async () => {
    await expect(new WebDavSourceAdapter(async () => { throw new Error('secret 密碼'); }).listImages(source)).resolves.toMatchObject({ error: { code: 'network' } });
    await expect(new WebDavSourceAdapter(() => new Promise<Response>(() => {}), { timeoutMs: 1 }).listImages(source)).resolves.toMatchObject({ error: { code: 'network' } });
    await expect(new WebDavSourceAdapter(async () => response('', 302)).listImages(source)).resolves.toMatchObject({ error: { code: 'network' } });
    await expect(new WebDavSourceAdapter(async () => response('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///nope">]><x/>')).listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
    await expect(new WebDavSourceAdapter(async () => response(multistatus(item('/photos/')))).listImages(source)).resolves.toMatchObject({ error: { code: 'empty' } });
  });

  it('reports a timed-out connection test as unreachable instead of user-cancelled', async () => {
    const adapter = new WebDavSourceAdapter((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }), { timeoutMs: 1 });

    await expect(adapter.testConnection(source)).resolves.toMatchObject({
      ok: false,
      error: { code: 'network', message: 'The WebDAV server could not be reached.' }
    });
  });

  it('caps oversized XML response bodies and cancels late work on dispose', async () => {
    const tooLarge = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1025)); c.close(); } }));
    await expect(new WebDavSourceAdapter(async () => tooLarge, { maxBytes: 1024 }).listImages(source)).resolves.toMatchObject({ error: { code: 'parse' } });
    let signal!: AbortSignal;
    const adapter = new WebDavSourceAdapter((_url, init) => new Promise<Response>((_resolve, reject) => { signal = init!.signal!; signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }));
    const loading = adapter.listImages(source);
    await adapter.dispose();
    await expect(loading).resolves.toMatchObject({ error: { code: 'network' } });
    expect(signal.aborted).toBe(true);
  });

  it('tests only the current directory once and succeeds when it contains no images', async () => {
    const listing = [
      item('/photos/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/Family/', '', 'HTTP/1.1 200 OK', true)
    ].join('');
    const fetcher = vi.fn(async () => response(multistatus(listing)));

    const result = await new WebDavSourceAdapter(fetcher).testConnection({ ...source, includeSubdirectories: true });

    expect(result).toMatchObject({
      ok: true,
      protected: true,
      count: 0,
      preview: [],
      directories: [{ id: expect.stringMatching(/^dir_[0-9a-f]{64}$/), name: 'Family', relativeSegments: ['Family'] }]
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns only safe unique sorted direct child directories without protected URLs', async () => {
    const listing = [
      item('/photos/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/beta/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/Alpha/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/%41lpha/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/Alpha/nested/', '', 'HTTP/1.1 200 OK', true),
      item('/outside/', '', 'HTTP/1.1 200 OK', true),
      item('https://evil.example/photos/foreign/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/%2e%2e%2fsecret/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/%252e%252e%252fsecret/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/slash%2Fname/', '', 'HTTP/1.1 200 OK', true),
      item('/photos/private/?token=signed-secret', '', 'HTTP/1.1 200 OK', true)
    ].join('');

    const result = await new WebDavSourceAdapter(async () => response(multistatus(listing))).testConnection(source);

    expect(result).toMatchObject({
      ok: true,
      directories: [
        { id: expect.stringMatching(/^dir_[0-9a-f]{64}$/), name: 'Alpha', relativeSegments: ['Alpha'] },
        { id: expect.stringMatching(/^dir_[0-9a-f]{64}$/), name: 'beta', relativeSegments: ['beta'] }
      ]
    });
    const serializedDirectories = JSON.stringify('directories' in result ? result.directories : []);
    expect(serializedDirectories).not.toMatch(/dav\.example|evil\.example|signed-secret|username|password|private/);
  });

  it('aborts and suppresses a late pending request when deleting its source', async () => {
    let signal!: AbortSignal;
    let resolve!: (response: Response) => void;
    const adapter = new WebDavSourceAdapter((_url, init) => new Promise<Response>((done) => { signal = init!.signal!; resolve = done; }));
    const loading = adapter.listImages(source);
    await adapter.deleteSource(source.id);
    resolve(response(multistatus(item('/photos/a.jpg'))));
    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: 'network' }, images: [] });
    expect(signal.aborted).toBe(true);
  });
});

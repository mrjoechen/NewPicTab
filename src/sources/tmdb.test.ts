import { describe, expect, it, vi } from 'vitest';
import type { TmdbSourceConfig } from '../domain/types';
import { TmdbSourceAdapter, type TmdbFetch } from './tmdb';
import { MAX_REMOTE_TEXT_LENGTH } from './text';

const token = 'tmdb-read-token-not-for-errors';
const movie: TmdbSourceConfig = { id: 'tmdb-movie', name: 'Movies', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token, media: 'movie', feed: 'popular', discoverFilters: {} };
const tv: TmdbSourceConfig = { ...movie, id: 'tmdb-tv', media: 'tv', feed: 'popular' };
const response = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const connection = () => response({ images: { secure_base_url: 'https://image.tmdb.org/t/p/', backdrop_sizes: ['w300', 'w1280', 'original'] } });
const images = (...items: unknown[]) => response({ results: items });
const languages = (...values: unknown[]) => response(values.length ? values : ['en-US', 'zh-CN']);
const regions = (...values: unknown[]) => response(values.length ? values : [{ iso_3166_1: 'CN' }, { iso_3166_1: 'US' }]);
function metadataResponse(url: string | URL, genres: unknown[] = []): Response {
  const path = new URL(String(url)).pathname;
  if (path === '/3/configuration/primary_translations') return languages();
  if (path === '/3/configuration/countries') return regions();
  return response({ genres });
}

describe('TmdbSourceAdapter', () => {
  it('lazily reconnects after an MV3 worker restart for lists and metadata refreshes', async () => {
    const fetcher = vi.fn(async (url: string | URL) => String(url).endsWith('/configuration') ? connection() : String(url).includes('/movie/popular') ? images({ id: 1, backdrop_path: '/a.jpg' }) : metadataResponse(url));
    const restarted = new TmdbSourceAdapter(fetcher);
    await expect(restarted.listImages(movie)).resolves.toMatchObject({ ok: true });
    await expect(restarted.refreshMetadata(movie)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/configuration'))).toHaveLength(1);
  });
  it('requires a nonblank token and never includes it in diagnostics', async () => {
    const adapter = new TmdbSourceAdapter(async () => { throw new Error(`Bearer ${token}`); });
    expect(adapter.validateConfig({ ...movie, token: '  ' })).toMatchObject({ ok: false, error: { code: 'validation' } });
    const result = await adapter.testConnection(movie);
    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('tests only the authenticated configuration endpoint and caches a safe desktop image base', async () => {
    const fetcher = vi.fn<TmdbFetch>(async () => connection());
    const adapter = new TmdbSourceAdapter(fetcher);
    await expect(adapter.testConnection(movie)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.themoviedb.org/3/configuration');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('manual');
  });

  it.each([
    ['movie', 'popular', '/3/movie/popular'], ['movie', 'top-rated', '/3/movie/top_rated'], ['movie', 'now-playing', '/3/movie/now_playing'], ['movie', 'upcoming', '/3/movie/upcoming'],
    ['tv', 'popular', '/3/tv/popular'], ['tv', 'top-rated', '/3/tv/top_rated'], ['tv', 'airing-today', '/3/tv/airing_today'], ['tv', 'on-the-air', '/3/tv/on_the_air'],
    ['movie', 'trending-daily', '/3/trending/movie/day'], ['tv', 'trending-weekly', '/3/trending/tv/week'], ['movie', 'discover', '/3/discover/movie'], ['tv', 'discover', '/3/discover/tv'],
  ] as const)('maps %s %s to %s', async (media, feed, expected) => {
    const config = { ...movie, id: `${media}-${feed}`, media, feed } as TmdbSourceConfig;
    const seen: string[] = [];
    const adapter = new TmdbSourceAdapter(async (url) => { seen.push(url); return seen.length === 1 ? connection() : images({ id: 7, backdrop_path: '/x.jpg', title: 'A' }); });
    await adapter.testConnection(config);
    await adapter.listImages(config);
    expect(new URL(seen[1]!).pathname).toBe(expected);
  });

  it('serializes only documented discover fields, encoded safely, with page and relevant locale parameters', async () => {
    const seen: string[] = [];
    const config: TmdbSourceConfig = { ...movie, feed: 'discover', discoverFilters: { with_genres: '1,2', language: 'en-US', region: 'US', primary_release_year: 2020, 'primary_release_date.gte': '2020-02-29', 'primary_release_date.lte': '2020-12-31', 'vote_average.gte': 7, sort_by: 'vote_average.desc', ignored: 'secret&x=1' } };
    const adapter = new TmdbSourceAdapter(async (url) => { seen.push(url); return seen.length === 1 ? connection() : images({ id: 1, backdrop_path: '/x.jpg' }); });
    await adapter.testConnection(config);
    await adapter.listImages({ ...config, discoverFilters: { ...config.discoverFilters, page: 3 } });
    const query = new URL(seen[1]!).searchParams;
    expect(Object.fromEntries(query)).toEqual({ with_genres: '1,2', language: 'en-US', region: 'US', primary_release_year: '2020', 'primary_release_date.gte': '2020-02-29', 'primary_release_date.lte': '2020-12-31', 'vote_average.gte': '7', sort_by: 'vote_average.desc', page: '3' });
    expect(seen[1]).not.toContain('ignored');
  });

  it('uses page/language/region on ordinary feeds where appropriate', async () => {
    const seen: string[] = [];
    const adapter = new TmdbSourceAdapter(async (url) => { seen.push(url); return seen.length === 1 ? connection() : images({ id: 1, backdrop_path: '/x.jpg' }); });
    await adapter.testConnection(movie);
    await adapter.listImages({ ...movie, discoverFilters: { page: 2, language: 'fr-FR', region: 'FR', ignored: 'x' } });
    expect(Object.fromEntries(new URL(seen[1]!).searchParams)).toEqual({ page: '2', language: 'fr-FR', region: 'FR' });
  });

  it('loads validated TMDB genres, language tags, and region codes separately per media', async () => {
    const genreValues = [{ id: 2, name: 'Drama' }, { id: 2, name: 'Drama' }, { id: 'bad', name: 'No' }, { id: 1, name: ' Action ' }];
    const fetcher = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/configuration')) return connection();
      const path = new URL(String(url)).pathname;
      if (path === '/3/configuration/primary_translations') return languages('zh-CN', 'en-US', 'zh-CN', 'invalid');
      if (path === '/3/configuration/countries') return regions({ iso_3166_1: 'US' }, { iso_3166_1: 'CN' }, { iso_3166_1: 'CN' }, { iso_3166_1: 'bad' });
      return response({ genres: genreValues });
    });
    const adapter = new TmdbSourceAdapter(fetcher);
    await expect(adapter.refreshMetadata(movie)).resolves.toBeUndefined();
    await adapter.testConnection(movie);
    await adapter.refreshMetadata(movie);
    expect(adapter.getMetadata(movie)).toEqual({
      genres: [{ id: 1, name: 'Action' }, { id: 2, name: 'Drama' }],
      languages: ['en-US', 'zh-CN'],
      regions: ['CN', 'US']
    });
    await adapter.testConnection(tv);
    await adapter.refreshMetadata(tv);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/3/genre/tv/list'))).toBe(true);
  });

  it('maps safe backdrop results to stable HTTPS TMDB entries and reports partial bad items', async () => {
    const adapter = new TmdbSourceAdapter(async (url) => String(url).endsWith('/configuration') ? connection() : images(
      { id: 9, backdrop_path: '/good.jpg', title: 'Film', overview: 'Description' }, { id: 10, backdrop_path: 'https://evil.test/x' }, { id: 11 }, { id: 9, backdrop_path: '/good.jpg' },
    ));
    await adapter.testConnection(movie);
    const result = await adapter.listImages(movie);
    expect(result).toMatchObject({ ok: true, images: [{ id: 'tmdb:movie:9', url: 'https://image.tmdb.org/t/p/w1280/good.jpg', description: 'Description', sourceUrl: 'https://www.themoviedb.org/movie/9' }] });
    expect(result.ok && result.warnings?.length).toBeGreaterThan(0);
  });

  it('bounds provider-controlled overview text before cataloging it', async () => {
    const huge = 'x'.repeat(MAX_REMOTE_TEXT_LENGTH + 2_000);
    const adapter = new TmdbSourceAdapter(async (url) => String(url).endsWith('/configuration') ? connection() : images({ id: 9, backdrop_path: '/good.jpg', overview: huge }));
    await adapter.testConnection(movie);
    const result = await adapter.listImages(movie);
    expect(result.ok && result.images[0]?.description).toHaveLength(MAX_REMOTE_TEXT_LENGTH);
  });

  it('keeps the TMDB image ID stable across backdrop changes while separating media kinds', async () => {
    const replies = [connection(), images({ id: 44, backdrop_path: '/first.jpg' }), images({ id: 44, backdrop_path: '/replacement.jpg' }), connection(), images({ id: 44, backdrop_path: '/tv.jpg' })];
    const adapter = new TmdbSourceAdapter(async () => replies.shift()!);
    await adapter.testConnection(movie);
    const first = await adapter.listImages(movie);
    const replaced = await adapter.listImages(movie);
    await adapter.testConnection(tv);
    const tvResult = await adapter.listImages(tv);
    expect(first.ok && first.images[0].id).toBe('tmdb:movie:44');
    expect(replaced.ok && replaced.images[0].id).toBe('tmdb:movie:44');
    expect(tvResult.ok && tvResult.images[0].id).toBe('tmdb:tv:44');
  });

  it('rejects unsafe image bases, handles empty image results, and returns typed HTTP errors', async () => {
    await expect(new TmdbSourceAdapter(async () => response({ images: { secure_base_url: 'http://image.tmdb.org/t/p/', backdrop_sizes: ['original'] } })).testConnection(movie)).resolves.toMatchObject({ ok: false, error: { code: 'parse' } });
    const adapter = new TmdbSourceAdapter(async (url) => String(url).endsWith('/configuration') ? connection() : images({ id: 1, backdrop_path: '/../no.jpg' }));
    await adapter.testConnection(movie);
    await expect(adapter.listImages(movie)).resolves.toMatchObject({ ok: false, error: { code: 'empty' } });
    await expect(new TmdbSourceAdapter(async () => new Response('', { status: 429, headers: { 'Retry-After': '10' } })).testConnection(movie)).resolves.toMatchObject({ ok: false, error: { code: 'rate-limit', retryAfterMs: 10_000 } });
    await expect(new TmdbSourceAdapter(async () => new Response('', { status: 401 })).testConnection(movie)).resolves.toMatchObject({ ok: false, error: { code: 'auth' } });
    await expect(new TmdbSourceAdapter(async () => new Response('{bad', { status: 200 })).testConnection(movie)).resolves.toMatchObject({ ok: false, error: { code: 'parse' } });
  });

  it('reports a timed-out connection as unreachable instead of user-cancelled', async () => {
    const adapter = new TmdbSourceAdapter((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }), { timeoutMs: 1 });

    await expect(adapter.testConnection(movie)).resolves.toMatchObject({
      ok: false,
      error: { code: 'network', message: '暂时无法连接 TMDB API，请检查网络或代理后重试。' }
    });
  });

  it.each([
    'https://image.tmdb.org:443/t/p/', 'https://image.tmdb.org:8443/t/p/', 'https://image.tmdb.org/other/', 'https://image.tmdb.org/t/p/extra/', 'https://user@image.tmdb.org/t/p/',
  ])('rejects a noncanonical TMDB image base: %s', async (base) => {
    const result = await new TmdbSourceAdapter(async () => response({ images: { secure_base_url: base, backdrop_sizes: ['w1280', 'original'] } })).testConnection(movie);
    expect(result).toMatchObject({ ok: false, error: { code: 'parse' } });
  });

  it('permits only a legitimate TMDB backdrop basename', async () => {
    const adapter = new TmdbSourceAdapter(async (url) => String(url).endsWith('/configuration') ? connection() : images(
      { id: 1, backdrop_path: '/abc_123-xy.jpg' }, { id: 2, backdrop_path: '/' }, { id: 3, backdrop_path: '/white space.jpg' }, { id: 4, backdrop_path: '/encoded%2Ejpg' }, { id: 5, backdrop_path: '/nested/a.jpg' }, { id: 6, backdrop_path: '/control\n.jpg' },
    ));
    await adapter.testConnection(movie);
    await expect(adapter.listImages(movie)).resolves.toMatchObject({ ok: true, images: [{ id: 'tmdb:movie:1', url: 'https://image.tmdb.org/t/p/w1280/abc_123-xy.jpg' }], warnings: expect.arrayContaining([expect.anything()]) });
  });

  it('rebuilds a matching configuration fingerprint after token or media changes', async () => {
    let connections = 0;
    const adapter = new TmdbSourceAdapter(async (url) => {
      if (String(url).endsWith('/configuration')) return connections++ === 1 ? new Response('', { status: 401 }) : connection();
      return images({ id: 1, backdrop_path: '/a.jpg' });
    });
    await adapter.testConnection(movie);
    await expect(adapter.listImages(movie)).resolves.toMatchObject({ ok: true });
    const changedToken = { ...movie, token: 'a-different-token' };
    await expect(adapter.testConnection(changedToken)).resolves.toMatchObject({ ok: false, error: { code: 'auth' } });
    await expect(adapter.listImages(movie)).resolves.toMatchObject({ ok: true });
    await expect(adapter.refreshMetadata(changedToken)).rejects.toMatchObject({ code: 'parse' });
    const changedMedia: TmdbSourceConfig = { ...changedToken, media: 'tv', feed: 'popular' };
    await adapter.testConnection(changedMedia);
    await expect(adapter.listImages(changedToken)).resolves.toMatchObject({ ok: true });
    await expect(adapter.listImages(changedMedia)).resolves.toMatchObject({ ok: true });
  });

  it('retesting immediately clears metadata and aborts active work before a failed replacement connection', async () => {
    let resolveList!: (value: Response) => void;
    let listSignal: AbortSignal | undefined;
    const adapter = new TmdbSourceAdapter((url, init) => {
      if (String(url).endsWith('/configuration')) return Promise.resolve(new Headers(init?.headers).get('Authorization')?.includes('new-token') ? new Response('', { status: 401 }) : connection());
      if (String(url).includes('/genre/')) return Promise.resolve(response({ genres: [{ id: 3, name: 'Comedy' }] }));
      if (String(url).includes('/configuration/')) return Promise.resolve(metadataResponse(url));
      return new Promise<Response>((resolve) => { resolveList = resolve; listSignal = init?.signal ?? undefined; });
    });
    await adapter.testConnection(movie);
    await adapter.refreshMetadata(movie);
    expect(adapter.getGenres(movie)).toEqual([{ id: 3, name: 'Comedy' }]);
    const activeList = adapter.listImages(movie);
    await Promise.resolve();
    await expect(adapter.testConnection({ ...movie, token: 'new-token' })).resolves.toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(listSignal?.aborted).toBe(true);
    expect(adapter.getGenres(movie)).toEqual([]);
    resolveList(images({ id: 1, backdrop_path: '/late.jpg' }));
    await expect(activeList).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it('returns cached genres only for the current normalized token and media fingerprint', async () => {
    const tokenWithWhitespace = ` ${token} `;
    const configuredMovie = { ...movie, token: tokenWithWhitespace };
    const authorizations: Array<string | null> = [];
    const adapter = new TmdbSourceAdapter(async (url, init) => {
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      return String(url).endsWith('/configuration') ? connection() : metadataResponse(url, [{ id: 8, name: 'Mystery' }]);
    });
    await adapter.testConnection(configuredMovie);
    await adapter.refreshMetadata(configuredMovie);
    const currentGenres = adapter.getGenres(movie);
    expect(currentGenres).toEqual([{ id: 8, name: 'Mystery' }]);
    expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
    const sameIdDifferentMedia: TmdbSourceConfig = { ...movie, token: 'token-b', media: 'tv', feed: 'popular' };
    const changedGenres = adapter.getGenres(sameIdDifferentMedia);
    expect(changedGenres).toEqual([]);
  });

  it('allows image listing and metadata refresh to complete concurrently for one configured source', async () => {
    const pending: Array<{ url: string; resolve: (value: Response) => void }> = [];
    const adapter = new TmdbSourceAdapter((url) => {
      if (String(url).endsWith('/configuration')) return Promise.resolve(connection());
      return new Promise<Response>((resolve) => { pending.push({ url: String(url), resolve }); });
    });
    await adapter.testConnection(movie);
    const listing = adapter.listImages(movie);
    const metadata = adapter.refreshMetadata(movie);
    await Promise.resolve();
    const listRequest = pending.find((item) => item.url.includes('/3/movie/popular'))!;
    const genreRequest = pending.find((item) => item.url.includes('/3/genre/movie/list'))!;
    const languageRequest = pending.find((item) => item.url.includes('/3/configuration/primary_translations'))!;
    const regionRequest = pending.find((item) => item.url.includes('/3/configuration/countries'))!;
    listRequest.resolve(images({ id: 1, backdrop_path: '/a.jpg' }));
    genreRequest.resolve(response({ genres: [{ id: 4, name: 'Crime' }] }));
    languageRequest.resolve(languages());
    regionRequest.resolve(regions());
    await expect(listing).resolves.toMatchObject({ ok: true, images: [{ id: 'tmdb:movie:1' }] });
    await expect(metadata).resolves.toBeUndefined();
    expect(adapter.getGenres(movie)).toEqual([{ id: 4, name: 'Crime' }]);
  });

  it('uses TV discover dates without a movie-only region parameter', async () => {
    const seen: string[] = [];
    const config: TmdbSourceConfig = { ...tv, feed: 'discover', discoverFilters: { first_air_date_year: 2022, 'first_air_date.gte': '2022-01-01', 'first_air_date.lte': '2022-12-31', region: 'US', language: 'en-US', page: 2 } };
    const adapter = new TmdbSourceAdapter(async (url) => { seen.push(String(url)); return seen.length === 1 ? connection() : images({ id: 1, backdrop_path: '/tv.jpg' }); });
    await adapter.testConnection(config);
    await adapter.listImages(config);
    expect(Object.fromEntries(new URL(seen[1]!).searchParams)).toEqual({ page: '2', language: 'en-US', first_air_date_year: '2022', 'first_air_date.gte': '2022-01-01', 'first_air_date.lte': '2022-12-31' });
  });

  it('omits invalid discover dates and never sends date filters on non-discover feeds', async () => {
    const seen: string[] = [];
    const adapter = new TmdbSourceAdapter(async (url) => { seen.push(String(url)); return seen.length === 1 ? connection() : images({ id: 1, backdrop_path: '/x.jpg' }); });
    await adapter.testConnection(movie);
    await adapter.listImages({ ...movie, feed: 'discover', discoverFilters: { 'primary_release_date.gte': '2023-02-29', 'primary_release_date.lte': '2023/12/31' } });
    expect(Object.fromEntries(new URL(seen[1]!).searchParams)).toEqual({});
  });

  it('aborts late work on disposal and deletion without remote side effects on delete', async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const adapter = new TmdbSourceAdapter((_url, init) => new Promise((done) => { resolve = done; signal = init?.signal ?? undefined; }));
    const pending = adapter.testConnection(movie);
    await Promise.resolve();
    await adapter.deleteSource(movie.id);
    expect(signal?.aborted).toBe(true);
    resolve(connection());
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
    await adapter.dispose();
  });
});

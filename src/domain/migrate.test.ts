import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from './defaults';
import { migrateSettings } from './migrate';

describe('migrateSettings', () => {
  it('keeps only unique valid shortcut IDs and accepts bounded local icon data', () => {
    const result = migrateSettings({
      shortcuts: [
        { id: 'same', title: 'One', url: 'https://one.example/', customIcon: pngDataUrl(16, 16) },
        { id: 'same', title: 'Duplicate', url: 'https://two.example/' },
        { id: 'unsafe', title: 'Unsafe', url: 'javascript:alert(1)' }
      ]
    });

    expect(result.shortcuts).toEqual([
      { id: 'same', title: 'One', url: 'https://one.example/', customIcon: pngDataUrl(16, 16) }
    ]);
  });

  it('rejects ambiguous custom templates and control characters in shortcut URLs', () => {
    const result = migrateSettings({
      widgets: { search: { enabled: true, engine: 'custom', customTemplate: 'https://search.example/{query}?again={query}' } },
      shortcuts: [{ id: 'line', title: 'Line', url: 'https://example.com/path\n' }]
    });

    expect(result.widgets.search).toEqual({ ...DEFAULT_SETTINGS.widgets.search, enabled: true });
    expect(result.shortcuts).toEqual([]);
  });

  it('bounds shortcut storage and migrates a viewport maximum', () => {
    const shortcuts = Array.from({ length: 40 }, (_, index) => ({ id: String(index), title: `Item ${index}`, url: `https://${index}.example.com/` }));
    const result = migrateSettings({ widgets: { shortcuts: { enabled: true, maxVisible: 6, scale: 1.25 } }, shortcuts });
    expect(result.widgets.shortcuts).toEqual({ enabled: true, maxVisible: 6, scale: 1.25 });
    expect(result.shortcuts).toHaveLength(24);
  });

  it('clamps shortcut dock scale and falls back invalid values', () => {
    expect(migrateSettings({ widgets: { shortcuts: { scale: 9 } } }).widgets.shortcuts.scale).toBe(1.35);
    expect(migrateSettings({ widgets: { shortcuts: { scale: 0.1 } } }).widgets.shortcuts.scale).toBe(0.85);
    expect(migrateSettings({ widgets: { shortcuts: { scale: Number.NaN } } }).widgets.shortcuts.scale).toBe(DEFAULT_SETTINGS.widgets.shortcuts.scale);
  });

  it('drops persisted shortcuts whose titles violate editor invariants', () => {
    const result = migrateSettings({ shortcuts: [
      { id: 'control', title: 'Bad\u0007title', url: 'https://control.example/' },
      { id: 'long', title: 'x'.repeat(81), url: 'https://long.example/' },
      { id: 'trimmed', title: '  Valid title  ', url: 'https://valid.example/' }
    ] });

    expect(result.shortcuts).toEqual([
      { id: 'trimmed', title: 'Valid title', url: 'https://valid.example/' }
    ]);
  });
  it('returns a complete independent default settings object for unknown or empty values', () => {
    const fromUnknown = migrateSettings({ nope: true });
    const fromEmpty = migrateSettings({});

    expect(fromUnknown).toEqual(DEFAULT_SETTINGS);
    expect(fromEmpty).toEqual(DEFAULT_SETTINGS);
    expect(fromUnknown).not.toBe(DEFAULT_SETTINGS);
    expect(fromUnknown.appearance).not.toBe(DEFAULT_SETTINGS.appearance);
    expect(fromUnknown).toMatchObject({
      version: 1,
      interfaceLanguage: 'zh-CN',
      activeSourceId: null,
      sources: [],
      appearance: {
        transition: 'fade',
        transitionMs: 1_200,
        order: 'shuffle',
        changeOn: 'new-tab',
        intervalMinutes: 60
      },
      widgets: {
        clock: { enabled: true, position: 'center' },
        date: { enabled: true },
        weather: { enabled: false },
        search: { enabled: false },
        shortcuts: { enabled: false }
      },
      shortcuts: []
    });
  });

  it('migrates partial version 0 data, clamps numbers, and safely falls back invalid transition', () => {
    const migrated = migrateSettings({
      version: 0,
      activeSourceId: 'local-1',
      appearance: {
        transition: 'spin',
        transitionMs: 99_999,
        order: 'sequential',
        changeOn: 'interval',
        intervalMinutes: 0
      },
      sources: [
        {
          id: 'local-1',
          name: 'Library',
          type: 'local',
          enabled: true,
          createdAt: 1,
          updatedAt: 2,
          includeSubdirectories: true
        }
      ]
    });

    expect(migrated.version).toBe(1);
    expect(migrated.appearance).toMatchObject({
      transition: 'fade',
      transitionMs: 5_000,
      order: 'sequential',
      changeOn: 'interval',
      intervalMinutes: 1
    });
    expect(migrated.activeSourceId).toBe('local-1');
    expect(migrated.sources).toEqual([
      expect.objectContaining({ id: 'local-1', type: 'local', includeSubdirectories: true })
    ]);
  });

  it('retains valid source and widget fields while discarding unsafe URLs and remote credentials', () => {
    const migrated = migrateSettings({
      version: 1,
      activeSourceId: 'webdav',
      sources: [
        {
          id: 'webdav',
          name: 'Private photos',
          type: 'webdav',
          enabled: true,
          createdAt: 10,
          updatedAt: 11,
          url: 'https://dav.example.com/photos',
          folderPath: ['家庭 相册', '2026'],
          username: 'ada',
          password: 'local-only',
          includeSubdirectories: true
        },
        {
          id: 'bad-direct',
          name: 'Bad links',
          type: 'direct',
          enabled: true,
          createdAt: 10,
          updatedAt: 11,
          entries: [
            { id: 'bad', url: 'http://insecure.example/image.jpg' },
            { id: 'safe', url: 'https://safe.example/image.jpg', label: 'Safe image' }
          ]
        },
        {
          id: 'bad-api',
          name: 'Bad API',
          type: 'json-api',
          enabled: true,
          createdAt: 10,
          updatedAt: 11,
          endpoint: 'javascript:alert(1)',
          headers: { Authorization: 'secret' },
          arrayPath: 'items',
          fields: { imageUrl: 'src' }
        }
      ],
      widgets: {
        clock: { enabled: false, hour12: true, showSeconds: true, size: 'large', position: 'top-right' },
        search: { enabled: true, engine: 'custom', customTemplate: 'https://search.example/?q={query}' }
      },
      interfaceLanguage: 'en-US',
      shortcuts: [
        { id: 'safe', title: 'Safe', url: 'https://safe.example', customIcon: 'https://safe.example/icon.png' },
        { id: 'unsafe', title: 'Unsafe', url: 'ftp://unsafe.example' }
      ]
    });

    expect(migrated.sources).toEqual([
      expect.objectContaining({
        id: 'webdav',
        type: 'webdav',
        url: 'https://dav.example.com/photos',
        folderPath: ['家庭 相册', '2026'],
        username: 'ada',
        password: 'local-only'
      }),
      expect.objectContaining({
        id: 'bad-direct',
        type: 'direct',
        entries: [{ id: 'safe', url: 'https://safe.example/image.jpg', label: 'Safe image' }]
      })
    ]);
    expect(migrated.activeSourceId).toBe('webdav');
    expect(migrated.interfaceLanguage).toBe('en-US');
    expect(migrated.widgets.clock).toEqual({ enabled: false, hour12: true, showSeconds: true, size: 'large', scale: 1.18, position: 'top-right' });
    expect(migrated.widgets.search).toEqual({
      enabled: true,
      engine: 'custom',
      customTemplate: 'https://search.example/?q={query}'
    });
    expect(migrated.shortcuts).toEqual([
      { id: 'safe', title: 'Safe', url: 'https://safe.example/' }
    ]);
  });

  it('drops unsafe WebDAV folder path segments while preserving the root URL', () => {
    const migrated = migrateSettings({ sources: [{
      id: 'webdav',
      name: 'Private photos',
      type: 'webdav',
      enabled: true,
      createdAt: 10,
      updatedAt: 11,
      url: 'https://dav.example.com/photos',
      folderPath: ['safe', '..', 'nested'],
      username: 'ada',
      password: 'local-only',
      includeSubdirectories: false
    }] });

    expect(migrated.sources).toEqual([
      expect.objectContaining({ type: 'webdav', url: 'https://dav.example.com/photos', folderPath: [] })
    ]);
  });

  it('clears an active source id that is not among valid sources', () => {
    expect(migrateSettings({ activeSourceId: 'missing', sources: [] }).activeSourceId).toBeNull();
  });

  it('keeps only the first valid source and Direct entry for duplicate persisted IDs', () => {
    const migrated = migrateSettings({ activeSourceId: 'shared', sources: [
      { id: 'shared', name: 'First', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'entry', url: 'https://one.example/a.jpg' }, { id: 'entry', url: 'https://two.example/b.jpg' }] },
      { id: 'shared', name: 'Second', type: 'local', enabled: true, createdAt: 1, updatedAt: 1, includeSubdirectories: false }
    ] });
    expect(migrated.sources).toEqual([expect.objectContaining({ id: 'shared', name: 'First', entries: [{ id: 'entry', url: 'https://one.example/a.jpg' }] })]);
    expect(migrated.activeSourceId).toBe('shared');
  });

  it('preserves a complete valid JSON API source including page and field mappings', () => {
    const migrated = migrateSettings({
      activeSourceId: 'api',
      sources: [{
        id: 'api', name: 'Photo API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 2,
        endpoint: 'https://api.example.test/photos',
        headers: { Accept: 'application/json' },
        authorizedImageOrigins: ['https://images.example.test/*', 'https://images.example.test/path/*', 'http://unsafe.example/*'],
        arrayPath: 'data.items',
        startingPage: 3,
        pageParam: 'page',
        fields: {
          imageUrl: 'image.url', stableId: 'id', title: 'caption', author: 'user.name',
          sourcePage: 'page', width: 'width', height: 'height'
        }
      }]
    });

    expect(migrated.activeSourceId).toBe('api');
    expect(migrated.sources).toEqual([expect.objectContaining({
      type: 'json-api',
      startingPage: 3,
      authorizedImageOrigins: ['https://images.example.test/*'],
      fields: {
        imageUrl: 'image.url', stableId: 'id', title: 'caption', author: 'user.name',
        sourcePage: 'page', width: 'width', height: 'height'
      }
    })]);
  });

  it('defaults and clamps JSON API startingPage to a positive page number', () => {
    const migrated = migrateSettings({
      sources: [{
        id: 'api', name: 'Photo API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 2,
        endpoint: 'https://api.example.test/photos', arrayPath: 'data', fields: { imageUrl: 'image' },
        startingPage: 0
      }]
    });

    expect(migrated.sources).toEqual([expect.objectContaining({ type: 'json-api', startingPage: 1 })]);
  });

  it('preserves a valid TMDB feed only when it is compatible with its media type', () => {
    const migrated = migrateSettings({
      sources: [{
        id: 'tmdb', name: 'Weekly films', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 2,
        token: 'local-token', media: 'movie', feed: 'trending-weekly', discoverFilters: { year: 2026 }
      }, {
        id: 'invalid-tmdb', name: 'Invalid combination', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 2,
        token: 'local-token', media: 'tv', feed: 'upcoming', discoverFilters: {}
      }]
    });

    expect(migrated.sources).toEqual([expect.objectContaining({
      id: 'tmdb', type: 'tmdb', media: 'movie', feed: 'trending-weekly', discoverFilters: { year: 2026 }
    })]);
  });

  it('falls back invalid appearance and widget enum values to their defaults', () => {
    const migrated = migrateSettings({
      appearance: { order: 'random', changeOn: 'manual' },
      widgets: {
        clock: { size: 'huge', scale: 99, position: 'middle-ish' },
        date: { format: 'emoji', showLunar: true },
        search: { engine: 'ask-jeeves' },
        weather: { mode: 'planet' }
      }
    });

    expect(migrated.appearance).toMatchObject({ order: 'shuffle', changeOn: 'new-tab' });
    expect(migrated.widgets.clock.size).toBe(DEFAULT_SETTINGS.widgets.clock.size);
    expect(migrated.widgets.clock.scale).toBe(1.35);
    expect(migrated.widgets.clock.position).toBe(DEFAULT_SETTINGS.widgets.clock.position);
    expect(migrated.widgets.date.format).toBe(DEFAULT_SETTINGS.widgets.date.format);
    expect(migrated.widgets.date.showLunar).toBe(true);
    expect(migrated.widgets.search.engine).toBe(DEFAULT_SETTINGS.widgets.search.engine);
    expect(migrated.widgets.weather.mode).toBe(DEFAULT_SETTINGS.widgets.weather.mode);
  });

  it('disables weather instead of preserving an unusable enabled state with corrupt coordinates', () => {
    const missing = migrateSettings({ widgets: { weather: { enabled: true, mode: 'city', city: '上海', latitude: 31.2 } } });
    const outOfRange = migrateSettings({ widgets: { weather: { enabled: true, mode: 'coordinates', city: '当前位置', latitude: 999, longitude: 121.4 } } });
    expect(missing.widgets.weather).toMatchObject({ enabled: false, latitude: 31.2, longitude: null });
    expect(outOfRange.widgets.weather).toMatchObject({ enabled: false, latitude: null, longitude: 121.4 });
  });

  it('uses a template only for a valid custom search URL containing the query placeholder', () => {
    const valid = migrateSettings({
      widgets: { search: { enabled: true, engine: 'custom', customTemplate: 'https://search.example/?q={query}' } }
    });
    const invalid = migrateSettings({
      widgets: { search: { enabled: true, engine: 'custom', customTemplate: 'https://search.example/?q=term' } }
    });
    const builtIn = migrateSettings({
      widgets: { search: { enabled: true, engine: 'baidu', customTemplate: 'https://should-not-survive.example/?q={query}' } }
    });

    expect(valid.widgets.search).toEqual({
      enabled: true, engine: 'custom', customTemplate: 'https://search.example/?q={query}'
    });
    expect(invalid.widgets.search).toEqual({ ...DEFAULT_SETTINGS.widgets.search, enabled: true });
    expect(builtIn.widgets.search).toEqual({ enabled: true, engine: 'baidu' });
  });

  it('falls back search engines that are no longer offered', () => {
    const migrated = migrateSettings({ widgets: { search: { enabled: true, engine: 'brave' } } });
    expect(migrated.widgets.search).toEqual({ ...DEFAULT_SETTINGS.widgets.search, enabled: true });
  });

  it('normalizes HTTPS URLs and rejects embedded URL credentials', () => {
    const migrated = migrateSettings({
      sources: [{
        id: 'direct', name: 'Direct', type: 'direct', enabled: true, createdAt: 1, updatedAt: 2,
        entries: [
          { id: 'credentialed', url: 'https://user:password@images.example.test/photo.jpg' },
          { id: 'normal', url: 'https://images.example.test:443/photo.jpg' }
        ]
      }],
      shortcuts: [{ id: 'credentialed', title: 'Credentialed', url: 'https://user:password@site.example.test' }]
    });

    expect(migrated.sources).toEqual([expect.objectContaining({
      entries: [{ id: 'normal', url: 'https://images.example.test/photo.jpg' }]
    })]);
    expect(migrated.shortcuts).toEqual([]);
  });

  it('uses only positive safe integer JSON pages and finite discover filter numbers', () => {
    const migrated = migrateSettings({
      sources: [{
        id: 'api', name: 'API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1,
        endpoint: 'https://api.example.test', arrayPath: 'items', fields: { imageUrl: 'image' }, startingPage: 1.5
      }, {
        id: 'tmdb', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1,
        token: 'token', media: 'movie', feed: 'discover',
        discoverFilters: { year: 2026, nan: Number.NaN, infinity: Number.POSITIVE_INFINITY }
      }]
    });

    expect(migrated.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'json-api', startingPage: 1 }),
      expect.objectContaining({ type: 'tmdb', discoverFilters: { year: 2026 } })
    ]));
  });
});

function pngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], 29);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

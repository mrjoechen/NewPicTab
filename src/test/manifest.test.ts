import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SEARCH_ENGINES } from '../domain/search';

const manifestPath = resolve(process.cwd(), 'public/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  manifest_version: number;
  name: string;
  description: string;
  default_locale?: string;
  permissions: string[];
  host_permissions?: string[];
  optional_host_permissions: string[];
  optional_permissions?: string[];
  minimum_chrome_version?: string;
  content_security_policy?: { extension_pages?: string };
};

describe('extension manifest', () => {
  it('localizes extension metadata through Chrome locale resources', () => {
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.default_locale).toBe('en');
    for (const locale of ['en', 'zh_CN']) {
      const messages = JSON.parse(readFileSync(resolve(process.cwd(), `public/_locales/${locale}/messages.json`), 'utf8')) as Record<string, { message?: string }>;
      expect(messages.extensionName?.message).toBe('PicTab');
      expect(messages.extensionDescription?.message).toBeTruthy();
    }
  });

  it('declares required permissions without making geolocation optional', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('111');
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['favicon', 'geolocation', 'storage', 'unlimitedStorage'])
    );
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      'https://api.themoviedb.org/*',
      'https://image.tmdb.org/*',
      'https://api.open-meteo.com/*',
      'https://geocoding-api.open-meteo.com/*',
      'https://api.bigdatacloud.net/*'
    ]));
    expect(manifest.optional_host_permissions).toContain('https://*/*');
    expect(manifest.optional_permissions ?? []).not.toContain('geolocation');
  });

  it('bundles every built-in search engine icon', () => {
    for (const engine of Object.values(SEARCH_ENGINES)) {
      expect(engine.iconUrl).toMatch(/^\/assets\/search-engines\/[a-z]+\.ico$/);
      expect(existsSync(resolve(process.cwd(), 'public', engine.iconUrl.slice(1)))).toBe(true);
    }
  });

  it('loads extension images only from bundled, blob, or data sources', () => {
    const policy = manifest.content_security_policy?.extension_pages;
    expect(policy).toContain("img-src 'self' blob: data:");
    expect(policy).not.toMatch(/img-src[^;]*https:/);
  });
});

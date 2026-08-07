import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifestPath = resolve(process.cwd(), 'public/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  manifest_version: number;
  permissions: string[];
  host_permissions?: string[];
  optional_host_permissions: string[];
  optional_permissions?: string[];
  minimum_chrome_version?: string;
  content_security_policy?: { extension_pages?: string };
};

describe('extension manifest', () => {
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

  it('allows only explicit search favicon endpoints for remote images', () => {
    expect(manifest.content_security_policy?.extension_pages).toContain("img-src 'self' blob: data:");
    expect(manifest.content_security_policy?.extension_pages).toContain('https://www.google.com/favicon.ico');
    expect(manifest.content_security_policy?.extension_pages).toContain('https://www.bing.com/favicon.ico');
    expect(manifest.content_security_policy?.extension_pages).toContain('https://duckduckgo.com/favicon.ico');
    expect(manifest.content_security_policy?.extension_pages).toContain('https://www.baidu.com/favicon.ico');
    expect(manifest.content_security_policy?.extension_pages).not.toContain('https://www.google.com/s2/favicons');
    expect(manifest.content_security_policy?.extension_pages).not.toContain('https://*');
  });
});

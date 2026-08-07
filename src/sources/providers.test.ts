import { describe, expect, it } from 'vitest';
import { PROVIDERS } from './providers';

describe('provider descriptors', () => {
  it('publishes immutable official TMDB attribution and onboarding links', () => {
    const tmdb = PROVIDERS.tmdb;
    expect(tmdb).toMatchObject({ enabled: true, guideUrl: 'https://developer.themoviedb.org/v4/docs/getting-started', applyUrl: 'https://www.themoviedb.org/settings/api', attributionUrl: 'https://www.themoviedb.org/about/logos-attribution', attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.' });
    expect(() => { (tmdb as { enabled: boolean }).enabled = false; }).toThrow();
  });
  it('keeps Unsplash and Pexels disabled with official policy links and wallpaper restrictions', () => {
    for (const provider of [PROVIDERS.unsplash, PROVIDERS.pexels]) {
      expect(provider.enabled).toBe(false);
      expect(provider.guideUrl).toMatch(/^https:\/\//);
      expect(provider.restrictionReason?.toLowerCase()).toContain('wallpaper');
      expect('applyUrl' in provider).toBe(false);
      expect(Object.keys(provider)).not.toContain('key');
    }
  });
});

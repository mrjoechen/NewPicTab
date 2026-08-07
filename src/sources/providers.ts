export interface ProviderDescriptor {
  readonly enabled: boolean;
  readonly guideUrl: string;
  readonly applyUrl?: string;
  readonly attribution?: string;
  readonly attributionUrl?: string;
  readonly restrictionReason?: string;
}

function immutable<T extends ProviderDescriptor>(value: T): Readonly<T> { return Object.freeze({ ...value }); }

/** Provider policy metadata only; adapters own all network access and credentials. */
export const PROVIDERS = Object.freeze({
  tmdb: immutable({
    enabled: true,
    guideUrl: 'https://developer.themoviedb.org/v4/docs/getting-started',
    applyUrl: 'https://www.themoviedb.org/settings/api',
    attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    attributionUrl: 'https://www.themoviedb.org/about/logos-attribution',
  }),
  unsplash: immutable({
    enabled: false,
    guideUrl: 'https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines',
    restrictionReason: 'Unsplash API images are disabled because its guidelines restrict using content as wallpapers.',
  }),
  pexels: immutable({
    enabled: false,
    guideUrl: 'https://www.pexels.com/api/documentation/',
    restrictionReason: 'Pexels API images are disabled because its terms restrict using content as wallpapers.',
  }),
} as const);

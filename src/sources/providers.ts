export interface ProviderDescriptor {
  readonly enabled: boolean;
  readonly guideUrl: string;
  readonly applyUrl?: string;
  readonly attribution?: string;
  readonly attributionUrl?: string;
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
} as const);

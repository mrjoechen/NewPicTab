import type { SourceConfig } from './types';
import { sha256Hex } from '../lib/crypto';

type RemoteSourceConfig = Exclude<SourceConfig, { type: 'local' }>;

/** Hash only retrieval identity, excluding cosmetic and lifecycle fields. */
export async function sourceConfigFingerprint(config: RemoteSourceConfig): Promise<string> {
  return sha256Hex(stableJson(retrievalIdentity(config)));
}

function retrievalIdentity(config: RemoteSourceConfig): unknown {
  switch (config.type) {
    case 'webdav': return { type: config.type, url: canonicalUrl(config.url), folderPath: config.folderPath ?? [], username: config.username, password: config.password, includeSubdirectories: config.includeSubdirectories };
    case 'json-api': return { type: config.type, endpoint: canonicalUrl(config.endpoint), headers: config.headers, arrayPath: config.arrayPath, fields: config.fields, startingPage: config.startingPage, pageParam: config.pageParam, authorizedImageOrigins: [...config.authorizedImageOrigins].sort() };
    case 'direct': return { type: config.type, entries: config.entries.map(({ id, url, label }) => ({ id, url: canonicalUrl(url), label })) };
    case 'tmdb': return { type: config.type, token: config.token, media: config.media, feed: config.feed, discoverFilters: config.discoverFilters };
  }
}

function canonicalUrl(value: string): string { try { return new URL(value).href; } catch { return value; } }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

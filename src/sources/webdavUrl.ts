export const MAX_WEB_DAV_DIRECTORY_NAME_LENGTH = 120;

export interface CanonicalWebDavDirectory {
  url: URL;
  segments: string[];
}

/** Canonical WebDAV directory URLs never carry user information, query, or fragment capabilities. */
export function canonicalWebDavDirectory(input: string | URL): CanonicalWebDavDirectory | undefined {
  let url: URL;
  try { url = new URL(input.toString()); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  const segments: string[] = [];
  for (const raw of url.pathname.split('/')) {
    if (!raw) continue;
    const segment = decodeSafeWebDavPathSegment(raw);
    if (segment === undefined) return undefined;
    segments.push(segment);
  }
  url.pathname = canonicalDirectoryPath(segments);
  return { url, segments };
}

export function canonicalWebDavChildDirectory(input: string | URL, relativeSegments: readonly string[]): string | undefined {
  const base = canonicalWebDavDirectory(input);
  if (!base) return undefined;
  for (const segment of relativeSegments) {
    if (!isSafeWebDavDirectoryName(segment)) return undefined;
  }
  base.url.pathname = canonicalDirectoryPath([...base.segments, ...relativeSegments]);
  return base.url.href;
}

/** Decodes repeatedly so encoded and double-encoded traversal cannot become a later path interpretation. */
export function decodeSafeWebDavPathSegment(raw: string): string | undefined {
  let value = raw;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { return undefined; }
    if (decoded === value) return isSafeDecodedSegment(value) ? value : undefined;
    value = decoded;
  }
  return undefined;
}

export function isSafeWebDavDirectoryName(value: string): boolean {
  return value.length <= MAX_WEB_DAV_DIRECTORY_NAME_LENGTH && decodeSafeWebDavPathSegment(value) === value;
}

function isSafeDecodedSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function canonicalDirectoryPath(segments: readonly string[]): string {
  return segments.length ? `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}/` : '/';
}

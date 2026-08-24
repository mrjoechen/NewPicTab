const IMAGE_TYPE_ALIASES = new Map<string, string>([
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/x-png', 'image/png'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
  ['image/avif', 'image/avif'],
  ['image/bmp', 'image/bmp'],
  ['image/x-ms-bmp', 'image/bmp']
]);

const IMAGE_EXTENSION_TYPES = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp']
]);

export function canonicalRemoteImageContentType(value: string | undefined): string | undefined {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type ? IMAGE_TYPE_ALIASES.get(type) : undefined;
}

export function remoteImageContentTypeFromUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const extension = url.pathname.split('.').pop()?.toLowerCase();
    return extension ? IMAGE_EXTENSION_TYPES.get(extension) : undefined;
  } catch {
    return undefined;
  }
}

export function cacheableWebDavImageContentType(value: string | undefined, imageUrl: string | undefined): string | undefined {
  const canonical = canonicalRemoteImageContentType(value);
  if (canonical) return canonical;
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'application/octet-stream' && imageUrl ? remoteImageContentTypeFromUrl(imageUrl) : undefined;
}

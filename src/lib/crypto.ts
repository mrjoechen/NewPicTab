const encoder = new TextEncoder();

/** Lower-case SHA-256 hex. Inputs may be sensitive; only the digest is returned. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function opaqueImageId(sourceScope: string, canonicalIdentity: string): Promise<string> {
  return `img_${await sha256Hex(JSON.stringify([sourceScope, canonicalIdentity]))}`;
}

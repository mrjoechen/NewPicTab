const SHORTCUT_COLORS = ['#496a72', '#5d6478', '#765f6c', '#596d58', '#76664d', '#4d6678', '#6c5d78'];
const SAFE_ICON = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/]+={0,2})$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_CHARACTERS = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
export const MAX_SHORTCUT_ICON_BYTES = 128 * 1024;
export const MAX_SHORTCUT_ICON_DIMENSION = 1_024;
export const MAX_SHORTCUTS = 24;
export const SHORTCUT_DOCK_SCALE_MIN = 0.85;
export const SHORTCUT_DOCK_SCALE_MAX = 1.35;
export const SHORTCUT_DOCK_SCALE_STEP = 0.05;

export function validateShortcutTitle(value: string): string | null {
  const title = value.trim();
  if (!title) return '请输入名称。';
  if (CONTROL_CHARACTERS.test(title)) return '名称不能包含控制字符。';
  if (title.length > 80) return '名称不能超过 80 个字符。';
  return null;
}

export function canonicalShortcutTitle(value: string): string | null {
  return validateShortcutTitle(value) ? null : value.trim();
}

export function validateShortcutUrl(value: string): string | null {
  if (CONTROL_CHARACTERS.test(value) || ENCODED_CONTROL_CHARACTERS.test(value)) return '网址不能包含控制字符。';
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { return '请输入有效的网址。'; }
  if (parsed.protocol !== 'https:') return '网址必须使用 HTTPS。';
  if (parsed.username || parsed.password) return '网址不能包含用户名或密码。';
  return null;
}

export function canonicalShortcutUrl(value: string): string | null {
  if (validateShortcutUrl(value)) return null;
  return new URL(value).toString();
}

export function boundedShortcutDockScale(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  const bounded = Math.min(SHORTCUT_DOCK_SCALE_MAX, Math.max(SHORTCUT_DOCK_SCALE_MIN, value));
  return Math.round(bounded * 100) / 100;
}

export function isSafeShortcutIcon(value: string | undefined): value is string {
  if (!value || CONTROL_CHARACTERS.test(value)) return false;
  const match = SAFE_ICON.exec(value);
  if (!match) return false;
  const type = match[1]!.toLowerCase();
  const payload = match[2]!;
  if (payload.length % 4 !== 0) return false;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const byteLength = Math.floor(payload.length * 3 / 4) - padding;
  if (byteLength <= 0 || byteLength > MAX_SHORTCUT_ICON_BYTES) return false;
  let bytes: Uint8Array;
  try {
    const binary = atob(payload);
    if (binary.length !== byteLength) return false;
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  const dimensions = shortcutIconDimensions(bytes, type);
  return Boolean(dimensions && dimensions.width <= MAX_SHORTCUT_ICON_DIMENSION && dimensions.height <= MAX_SHORTCUT_ICON_DIMENSION);
}

/** Inspects image bytes without decoding pixels or depending on DOM APIs. */
export function shortcutIconDimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  if (type === 'image/png') return pngDimensions(bytes);
  if (type === 'image/jpeg') return jpegDimensions(bytes);
  if (type === 'image/webp') return webpDimensions(bytes);
  return null;
}

export function firstGrapheme(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '?';
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return segmenter.segment(normalized)[Symbol.iterator]().next().value?.segment ?? '?';
  }
  return Array.from(normalized)[0] ?? '?';
}

export function shortcutColor(id: string): string {
  let hash = 2_166_136_261;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return SHORTCUT_COLORS[(hash >>> 0) % SHORTCUT_COLORS.length]!;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 45 || !matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return null;
  if (readUint32(bytes, 8) !== 13 || !matches(bytes, 12, [73, 72, 68, 82])) return null;
  const dimensions = validDimensions(readUint32(bytes, 16), readUint32(bytes, 20));
  if (!dimensions) return null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) return null;
    if (matches(bytes, offset + 4, [73, 69, 78, 68])) return length === 0 && end === bytes.length ? dimensions : null;
    offset = end;
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let dimensions: { width: number; height: number } | null = null;
  let offset = 2;
  while (offset + 4 <= bytes.length - 2) {
    while (offset < bytes.length - 2 && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length - 2) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length - 2) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      dimensions = validDimensions((bytes[offset + 5]! << 8) | bytes[offset + 6]!, (bytes[offset + 3]! << 8) | bytes[offset + 4]!);
      if (!dimensions) return null;
    }
    if (marker === 0xda) return dimensions;
    offset += length;
  }
  return dimensions;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || !matches(bytes, 0, [82, 73, 70, 70]) || !matches(bytes, 8, [87, 69, 66, 80])) return null;
  if (readUint32LE(bytes, 4) + 8 !== bytes.length) return null;
  const chunkLength = readUint32LE(bytes, 16);
  if (20 + chunkLength + (chunkLength % 2) > bytes.length) return null;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8X' && chunkLength >= 10) return validDimensions(1 + readUint24LE(bytes, 24), 1 + readUint24LE(bytes, 27));
  if (chunk === 'VP8 ' && chunkLength >= 10 && matches(bytes, 23, [157, 1, 42])) return validDimensions(((bytes[27]! << 8) | bytes[26]!) & 0x3fff, ((bytes[29]! << 8) | bytes[28]!) & 0x3fff);
  if (chunk === 'VP8L' && chunkLength >= 5 && bytes[20] === 47) {
    const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    const height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    return validDimensions(width, height);
  }
  return null;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}
function readUint32(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); }
function readUint32LE(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
function readUint24LE(bytes: Uint8Array, offset: number): number { return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16); }
function validDimensions(width: number, height: number): { width: number; height: number } | null { return width > 0 && height > 0 ? { width, height } : null; }

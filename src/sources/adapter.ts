export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageEntryBase {
  /** Stable within its source, including across refreshes. */
  id: string;
  sourceId: string;
  dimensions?: ImageDimensions;
  previewColor?: string;
  description?: string;
  author?: string;
  sourceUrl?: string;
  authorUrl?: string;
  attribution?: string;
}

export type ImageEntry = ImageEntryBase & (
  | { url: string; localBlobKey?: never }
  | { url?: never; localBlobKey: string }
  | { url?: never; localBlobKey?: never; remoteCacheEntryId: string; /** Opaque SHA-256 config namespace. */ remoteCacheFingerprint: string }
);

export type SourceErrorCode =
  | 'validation'
  | 'permission'
  | 'auth'
  | 'network'
  | 'http'
  | 'rate-limit'
  | 'empty'
  | 'parse'
  | 'decode'
  | 'unknown';

export interface SourceError {
  code: SourceErrorCode;
  /** A safe user-facing message; never include credentials or raw server output. */
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** HTTP status for a non-auth, non-rate-limit response. */
  status?: number;
  /** Safe mapping context for an invalid response item. */
  field?: 'imageUrl' | 'width' | 'height' | 'width-height' | 'sourcePage';
  itemIndex?: number;
  reason?: 'missing' | 'invalid-url' | 'invalid-dimensions';
}

export type ConfigValidationResult = { ok: true } | { ok: false; error: SourceError };
export type SafeImagePreview = Pick<ImageEntryBase, 'id' | 'sourceId' | 'description' | 'author' | 'dimensions' | 'previewColor'>;
export interface SafeWebDavDirectory {
  /** Opaque identity only; never a WebDAV URL or path. */
  id: string;
  /** Bounded plain text for display. */
  name: string;
  /** A strictly validated child path relative to the directory that was tested. */
  relativeSegments: string[];
}
export type ProtectedConnectionTestResult =
  | { ok: true; protected: true; imageOrigins: string[]; count: number; preview: SafeImagePreview[]; directories?: SafeWebDavDirectory[]; entries?: never; message?: string; warnings?: SourceError[] }
  | { ok: false; protected: true; imageOrigins: string[]; count: number; preview: SafeImagePreview[]; directories?: SafeWebDavDirectory[]; entries?: never; error: SourceError; warnings?: SourceError[] };
export type PublicConnectionTestResult =
  | { ok: true; protected?: false; imageOrigins?: never; count?: never; preview?: never; message?: string; entries?: ImageEntry[]; warnings?: SourceError[] }
  | { ok: false; protected?: false; imageOrigins?: never; count?: never; preview?: never; error: SourceError; entries?: ImageEntry[]; warnings?: SourceError[] };
export type ConnectionTestResult = ProtectedConnectionTestResult | PublicConnectionTestResult;

export type ListImagesResult =
  | { ok: true; images: [ImageEntry, ...ImageEntry[]]; /** Full safe metadata count, not merely this materialized window. */ totalCount?: number; offset?: number; /** Number of metadata records consumed, including records that could not be materialized. */ consumedCount?: number; /** Cursor for the next metadata window. */ nextOffset?: number; hasMore?: boolean; /** Recoverable per-item diagnostics. */ warnings?: SourceError[] }
  | { ok: false; images: []; error: SourceError; warnings?: SourceError[] };

export interface SourceAdapter<C> {
  validateConfig(config: unknown): ConfigValidationResult;
  testConnection(config: C): Promise<ConnectionTestResult>;
  listImages(config: C): Promise<ListImagesResult>;
  refreshMetadata(config: C): Promise<void>;
  getAttribution(entry: ImageEntry): Promise<string | undefined>;
  deleteSource(sourceId: string): Promise<void>;
  dispose(): Promise<void> | void;
}

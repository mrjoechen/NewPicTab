# Complete Playback Pool Design

## Goal

Guarantee that sequential and shuffle playback select from a complete source catalog rather than from the small set of image bytes currently cached by a tab. Keep remote image storage bounded by preparing only the selected image and a small lookahead, even when a WebDAV source contains a very large number of images.

## Definitions

- **Catalog** means ordered image metadata and stable IDs. It does not contain image bytes.
- **Complete snapshot** means discovery reached the end of the configured source without truncation, timeout, or an unvisited WebDAV directory.
- **Playback round** means one traversal of every catalog entry: catalog order for sequential mode and one complete permutation for shuffle mode.
- **Prepared image** means its validated bytes are present in `RemoteCache`; it need not have an object URL in a tab.
- **Eligible image** means an entry accepted by source discovery and the remote image policy. A corrupt, oversized, unauthorized, or permanently unavailable file cannot be promised a successful paint, but it remains observable as a failed attempt and is reconsidered in a later round or catalog generation.

## Requirements

- Candidate selection is based only on a complete catalog snapshot. Cache membership must never add, remove, reorder, or wrap playback candidates.
- The first activation of a remote source without a complete snapshot keeps the bundled/current background visible until discovery completes.
- Refresh builds a shadow snapshot. A prior complete snapshot remains playable until the shadow snapshot completes, then the new generation becomes active atomically.
- Sequential mode reserves every catalog ordinal once before starting another round.
- Shuffle mode reserves every catalog ordinal once in a seeded permutation before starting another round.
- Playback state survives MV3 worker restarts and new-tab lifecycles.
- Concurrent tabs may finish painting out of wall-clock order, but claims are atomically ordered and unique within a round.
- A round cannot wrap while an entry from that round is still reserved, retrying, or otherwise unresolved.
- A retryable fetch, cache, or decode failure does not permanently remove an entry from the playback pool.
- `previous` is tab-local navigation through displayed history and must not rewind the shared cross-tab cursor.
- Remote sequential and shuffle modes prepare the selected image plus the next two logical candidates.
- Lookahead preparation is best-effort and must never advance the cursor or block displaying an already prepared selected image.
- Cache Storage is bounded by both 250 MiB total bytes and 36 image entries; an individual image remains limited to 16 MiB.
- A tab owns at most three remote object URLs: current, transition previous, and the candidate currently decoding.
- Source credentials, authorization headers, private response bodies, and unsafe signed URLs never cross the runtime-message seam or enter logs/cache keys.
- Existing local image storage is user-owned source data, not remote cache. Local playback uses the same complete-round planner but is not subject to remote cache eviction.

## Considered Approaches

1. **Background playback pool over a complete catalog (selected).** A deep background module owns catalog generations, ordering, reservations, retry state, byte preparation, and lookahead. The page asks for one navigation result and does not know catalog offsets or cache windows. This gives the strongest correctness and keeps protected source details behind the existing runtime-message seam.
2. **Send all metadata to every tab.** The hook could plan complete rounds locally, but large catalogs would create large messages and duplicate memory. It would also expose protected locators and make cross-tab atomic claims difficult.
3. **Keep the current window protocol and improve prefetch.** Waiting for the next 12-entry window fixes some sequential races, but shuffle and new-tab selection would still only know a cache subset. Cache eviction would continue to change the logical pool, so this cannot satisfy the requirement.

## Module and Seams

Add a deep `RemotePlaybackPool` module behind the background runtime-message seam. Its external interface is intentionally small:

```ts
interface RemotePlaybackPool {
  prepare(request: PlaybackPrepareRequest): Promise<PlaybackPrepareResult>;
  settle(request: PlaybackSettleRequest): Promise<PlaybackSettleResult>;
  refresh(config: RemoteSourceConfig): Promise<void>;
  remove(sourceId?: string): Promise<void>;
}
```

The implementation hides:

- active and shadow catalog generations;
- resumable WebDAV discovery checkpoints;
- sequential ordinals and shuffle permutations;
- idempotent request IDs, reservations, leases, and expiry;
- retry classification and round barriers;
- authenticated fetches, redirect validation, content policy, and cache admission;
- lookahead preparation, LRU eviction, and cache pressure;
- worker restart, source refresh, delete, and clear races.

The module depends on internal seams with production and in-memory test adapters:

- `CatalogRepository`: IndexedDB and memory adapters;
- `PlaybackStateRepository`: IndexedDB and memory adapters;
- `ImageByteStore`: `RemoteCache` and memory adapters;
- source discovery/fetch adapters: WebDAV, Direct, JSON API, TMDB, and deterministic fakes;
- clock and RNG dependencies for lease expiry, retry timing, and shuffle seeds.

The page receives a `PlaybackClient` adapter over runtime messages. `useBackgroundRotation` retains React lifecycle, keyboard/timer coalescing, decode, and transition state, but no longer owns remote catalog windows or shuffle bags.

## Runtime Interface

```ts
type PlaybackIntent =
  | { kind: 'advance'; direction: 'next'; order: RotationOrder }
  | { kind: 'history'; imageId: string };

interface PlaybackPrepareRequest {
  playback: 'prepare';
  config: RemoteSourceConfig;
  sessionId: string;
  requestId: string;
  intent: PlaybackIntent;
}

type PlaybackPrepareResult =
  | {
      ok: true;
      state: 'ready';
      reservationId: string;
      generation: string;
      round: number;
      totalCount: number;
      image: CacheBackedImageEntry;
      warnings?: SourceError[];
    }
  | {
      ok: true;
      state: 'waiting';
      reason: 'catalog-discovery' | 'candidate-retry' | 'round-barrier' | 'cache-pressure';
      retryAfterMs: number;
      discoveredCount?: number;
      warnings?: SourceError[];
    }
  | { ok: false; error: SourceError; warnings?: SourceError[] };

interface PlaybackSettleRequest {
  playback: 'settle';
  sessionId: string;
  requestId: string;
  reservationId: string;
  outcome: 'displayed' | 'decode-failed' | 'abandoned';
}
```

`requestId` is generated once per logical navigation. Message timeout and retry reuse the same ID, making `prepare` idempotent. A ready reservation expires after two minutes if it is not settled. Expiry returns the candidate to the same round; it does not consume it or open the next round.

History preparation validates and prepares the requested stable ID but never changes the shared sequential/shuffle cursor. The page stores only bounded occurrence history and releases object URLs that are no longer current, previous, or decoding.

## Catalog Discovery

Direct, JSON API, and TMDB discovery may produce a complete snapshot in one adapter call. WebDAV discovery becomes resumable:

- scan breadth-first using canonical directory URLs;
- persist the queue, visited directories, discovered entries, warnings, and generation after each completed directory;
- use a bounded work slice shorter than the runtime callback deadline;
- treat the current 20,000-resource value as a work-slice guard, not proof that the source ended;
- keep the 16 MiB XML response limit for each directory;
- resume from the saved checkpoint after a timeout or MV3 worker restart;
- publish only after the queue is empty and the final directory is processed;
- never replace an active complete snapshot with partial discovery.

There is no arbitrary total-image cutoff for an otherwise valid finite source. If metadata persistence reaches browser quota, or one directory cannot be safely parsed within the response limit, discovery becomes explicitly blocked and the old snapshot remains active. A first-time source stays on the bundled background rather than pretending the partial catalog is complete.

Catalog metadata is O(N) and may be large; this is the deliberate cost of complete selection. Image bytes remain independently bounded. Safe WebDAV locators may be persisted without credentials, query, or fragment. JSON API catalogs containing volatile or signed URLs remain memory-only and are rediscovered after a worker restart.

## Ordering and Shared Playback State

Each complete catalog generation has immutable, contiguous ordinals and unique stable IDs.

Sequential state stores the next ordinal and the current round. Shuffle state stores a seed, round, and next permutation position. A deterministic seeded Fisher-Yates permutation is rebuilt in memory from catalog length after a worker restart; persisted state remains O(1). Starting a new shuffle round chooses a new seed and prevents the first ID from matching the prior round's last displayed ID when more than one entry exists.

The following invariants are mandatory:

1. Every ordinal can have at most one active reservation in a round.
2. Lookahead never creates a reservation and never advances a position.
3. The next-unreserved high-water position advances when a unique reservation is created; a slow reservation does not prevent another tab from reserving a later position.
4. Retryable failures remain attached to their original reservation and return `waiting` with bounded backoff.
5. Decode failure settles the reservation as failed for the current round; the ID remains eligible in later rounds.
6. A new round starts only after every ordinal in the current round is displayed or conclusively failed and no reservation remains active.
7. Cache eviction cannot alter any ordinal, seed, position, reservation, or history record.
8. Refresh creates a new generation; stale asynchronous work cannot write into it.

Claims are serialized only for the short state transaction. Network fetch, cache write, page materialization, and decode happen outside the state lock. Concurrent tabs therefore receive unique later reservations without one slow download holding either the lock or the reservation high-water mark. The round barrier still waits for every reservation in that round to settle or expire before permitting wraparound.

## Byte Preparation and Eviction

For each advance request, the pool resolves the selected ordinal and the next two logical ordinals in that round. It must prepare the selected image before returning `ready`. The two lookahead images are fetched with best-effort concurrency of two; their failures create diagnostics but do not move or fail their future playback positions.

`RemoteCache` gains an entry-count budget in addition to its existing byte budget:

- maximum total bytes: 250 MiB;
- maximum entries: 36;
- maximum individual entry: 16 MiB;
- selected image and active reservations are hard-protected while being prepared;
- current/previous references supplied by active tabs are temporary protected leases;
- lookahead is soft and may be evicted first;
- all other entries use global LRU order across sources;
- admission must finish at or below both hard budgets, otherwise it fails without publishing an unreadable descriptor.

Cache hits still update LRU access time. The cache entry-count limit prevents a source containing thousands of small files from being cached in full, while the byte limit handles a smaller number of large files.

Object URLs are not lookahead storage. A tab materializes only the selected candidate, keeps the prior displayed image through its transition, and releases every other lease. This caps tab-owned object URLs at three independently of catalog or Cache Storage size.

## Playback Data Flow

1. `App` opens a remote playback session for the active source.
2. Initial/new-tab/manual/interval navigation creates one `requestId` and calls `prepare`.
3. If no complete catalog exists, discovery advances and returns `waiting`; the current or bundled background remains visible.
4. The page retries the same request after `retryAfterMs` or an explicit catalog wake-up.
5. The pool atomically reserves the next full-catalog candidate, prepares its bytes, and starts best-effort lookahead.
6. The page materializes one cache descriptor, decodes it, and calls `settle`.
7. `displayed` publishes current/previous and commits the occurrence. `decode-failed` releases the URL and continues the same logical navigation with the next eligible candidate. `abandoned` releases the reservation for the same round.
8. Interval scheduling restarts only after a successful display; a pending catalog or candidate keeps the current image visible.

For local sources, the page uses the same pure complete-round planner over all local stable IDs and the existing local storage adapter. Its seed, round, position, and pending reservations use the persistent playback-state adapter so sequential and shuffle rounds also survive new tabs. The remote Cache Storage budgets do not apply because imported local images are source data. Bundled fallback remains a single-entry local pool.

## Failure and Recovery Behavior

- Retryable network, HTTP 5xx, rate-limit, or storage failures return `waiting`; they do not consume the candidate or cause wraparound.
- Authentication and permission failures block the source generation and preserve the currently displayed image.
- Unsupported content, oversized images, and deterministic invalid-image responses fail that candidate for the current round and continue to another candidate.
- Page decode failure is recorded only for the current round and URL version. A refreshed URL or later round can retry it.
- If every catalog entry fails in one round, the pool reports a bounded retry state instead of opening an immediate failure loop.
- Worker restart restores catalog, cursor, reservations, and retry timestamps. Expired reservations become available in their original round.
- Source refresh failure preserves the active complete snapshot and marks it stale.
- Source deletion and global data clearing cancel in-flight work and remove catalog, playback state, and source cache records best-effort without allowing late work to repopulate them.

## Migration

- Existing safe `CatalogRecord.images` arrays migrate as complete generation zero.
- Existing Chrome sequential cursor values seed the matching catalog ordinal once; after durable playback state is written, the legacy cursor is removed.
- Existing shuffle state cannot represent a complete cross-tab round, so shuffle begins a new seeded round while avoiding the legacy last displayed ID as the first candidate.
- Existing Cache Storage keys and byte records remain reusable; migration does not download or duplicate images.
- The old `source:list` request remains for settings preview and diagnostics, but no longer drives background playback.
- Remove App's remote window ownership, offset state, near-end prefetch, and `onEntriesExhausted` path after the new playback client is active.
- Remove remote selection from `useBackgroundRotation`; retain timer, keyboard, decode, direction, current/previous, and local planner behavior.

## Testing

Tests target the new playback-pool interface and observable UI behavior rather than its internal windows.

- Sequential property tests: for arbitrary catalog sizes and interleaved tabs, the first round reserves every ID exactly once before any repeat.
- Shuffle property tests: every round is a full permutation; worker restart continues the same seed/position; consecutive rounds avoid an immediate boundary repeat.
- Slow-tail test: the final candidate remains pending and a new claim waits at the round barrier instead of returning ordinal zero.
- Idempotency test: repeated `prepare` with one request ID returns the same reservation across callback timeout and worker restart.
- Failure tests: a single transient failure is retried; a decode failure does not disappear forever; all-failed rounds do not spin.
- Lookahead tests: selected plus two logical successors are prepared in both order modes, while cursor state advances only for the selected reservation.
- Cache tests: many small images never exceed 36 entries; large images never exceed 250 MiB; one image never exceeds 16 MiB; protected current/reservations survive and soft lookahead is evicted first.
- WebDAV tests: more than 20,000 resources, multiple work slices, timeout resume, worker restart resume, deep BFS, cycles, partial directory failures, and oversized XML never publish a partial snapshot as complete.
- Refresh tests: old snapshot continues during a shadow scan; success swaps atomically; failure preserves old playback.
- Security tests: credentials, Authorization values, signed locators, and raw protected errors never appear in runtime responses, persisted public fields, cache keys, or logs.
- App tests: first-time discovery keeps fallback visible, pending navigation does not wrap, current survives retry, source switch releases leases, and interval/manual/new-tab use the same full pool.
- End-to-end test: a remote catalog larger than the byte-cache entry limit completes sequential and shuffle rounds while observed cache records stay within both budgets.

Run focused red/green tests for each behavior, then the complete typecheck, Vitest suite, production build, and extension end-to-end suite.

## Non-Goals

- No user-configurable cache size or lookahead count in this change.
- No guarantee that an invalid or permanently inaccessible file can render; the guarantee is complete selection and honest failure handling for every eligible catalog entry.
- No strict wall-clock paint ordering across concurrent tabs; ordering is defined by atomic reservations.
- No full-image preloading, thumbnail generation, offline pinning of an entire source, or unbounded object-URL history.
- No changes to source configuration UI, transition visuals, clock, weather, search, or shortcuts.

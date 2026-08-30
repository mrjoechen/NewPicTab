# Complete Playback Pool Design

## Goal

Guarantee that sequential and shuffle playback select from a complete source catalog rather than from the small set of image bytes currently cached by a tab. Keep remote image storage bounded by preparing only the selected image and a small lookahead, even when a WebDAV source contains a very large number of images. When the browser is offline or the configured remote source is transport-unreachable, keep playback visible by temporarily selecting only from validated images already present in the bounded cache.

## Definitions

- **Catalog** means ordered image metadata and stable IDs. It does not contain image bytes.
- **Complete snapshot** means discovery reached the end of the configured source without truncation, timeout, or an unvisited WebDAV directory.
- **Playback round** means one traversal of every catalog entry: catalog order for sequential mode and one complete permutation for shuffle mode.
- **Prepared image** means its validated bytes are present in `RemoteCache`; it need not have an object URL in a tab.
- **Cache fallback round** means one session-local traversal of the validated cache records currently available for the active source after an offline hint or transport failure. It is an availability mechanism, not a complete-catalog playback round, and never advances complete-catalog state.
- **Eligible image** means an entry accepted by source discovery and the remote image policy. A corrupt, oversized, unauthorized, or permanently unavailable file cannot be promised a successful paint, but it remains observable as a failed attempt and is reconsidered in a later round or catalog generation.

## Requirements

- Normal candidate selection is based only on a complete catalog snapshot. Cache membership must never add, remove, reorder, or wrap complete-catalog playback candidates; the explicitly separate cache fallback is the only cache-subset selection path.
- The first activation of a remote source without a complete snapshot keeps the bundled/current background visible until discovery completes, unless network unavailability activates a non-empty cache fallback for the exact source configuration.
- Refresh builds a shadow snapshot. A prior complete snapshot remains playable until the shadow snapshot completes, then the new generation becomes active atomically.
- Sequential mode reaches a displayed or conclusively failed outcome for every catalog ordinal before starting another round. An unresolved ordinal may have multiple preparation attempts but is never displayed twice in the same round.
- Shuffle mode follows one seeded permutation to a displayed or conclusively failed outcome for every catalog ordinal before starting another round. Retryable preparation attempts do not add another permutation position.
- Playback state survives MV3 worker restarts and new-tab lifecycles.
- Concurrent tabs may finish painting out of wall-clock order, but claims are atomically ordered and unique within a complete-catalog round. Cache fallback is session-local, so different tabs may display the same cached image.
- A round cannot wrap while an entry from that round is still reserved, retrying, or otherwise unresolved.
- A retryable fetch, cache, or decode failure does not permanently remove an entry from the playback pool.
- `previous` is tab-local navigation through displayed history and must not rewind the shared cross-tab cursor.
- Remote sequential and shuffle modes prepare the selected image plus the next two logical candidates.
- Lookahead preparation is best-effort and must never advance the cursor or block displaying an already prepared selected image.
- When an offline hint or typed transport failure prevents normal preparation, playback selects from validated cache records for the active source instead of blanking the page or repeatedly attempting uncached candidates.
- Sequential cache fallback attempts every image in its cache snapshot once in stable catalog order before repeating. Shuffle cache fallback attempts every image in a seeded permutation of that snapshot once before repeating. When more than one readable image exists, a new fallback round avoids an immediate boundary repeat.
- A fallback round starts after the currently displayed ID when it appears in the sequential snapshot, and shuffle moves that ID away from the first position when alternatives exist. A sole cached current image is reused without a transition rather than blanking or repeatedly decoding it.
- Cache fallback never consumes, settles, reorders, or opens a round in complete-catalog playback state. A catalog reservation interrupted by network loss returns unchanged to its original round and is prioritized on the next normal advance after recovery.
- Images displayed by cache fallback may appear again later in the resumed complete-catalog round because emergency display does not count as catalog settlement.
- Cache fallback performs no discovery, download, or bulk cache fill. If no usable cached image exists, the current displayed image or bundled background remains visible.
- A selected complete-catalog candidate whose bytes are already cached remains a normal catalog result even while offline. Cache-only fallback begins only when the next required catalog candidate cannot be prepared from existing bytes.
- Cache Storage is bounded by both 250 MiB total bytes and 36 image entries; an individual image remains limited to 16 MiB.
- A tab owns at most three remote object URLs: current, transition previous, and the candidate currently decoding.
- Source credentials and authorization headers enter the background only inside a validated request from this extension under the existing sender policy. They, private response bodies, and unsafe signed URLs never return in runtime responses or enter logs, cache keys, playback state, or public catalog fields.
- Existing local image storage is user-owned source data, not remote cache. Local playback uses the same complete-round planner but is not subject to remote cache eviction.

## Considered Approaches

1. **Background playback pool over a complete catalog (selected).** A deep background module owns catalog generations, ordering, reservations, retry state, byte preparation, and lookahead. The page asks for one navigation result and does not know catalog offsets or cache windows. This gives the strongest correctness and keeps protected source details behind the existing runtime-message seam.
2. **Send all metadata to every tab.** The hook could plan complete rounds locally, but large catalogs would create large messages and duplicate memory. It would also expose protected locators and make cross-tab atomic claims difficult.
3. **Keep the current window protocol and improve prefetch.** Waiting for the next 12-entry window fixes some sequential races, but shuffle and new-tab selection would still only know a cache subset. Cache eviction would continue to change the logical pool, so this cannot satisfy the requirement.

## Module and Seams

Add a deep `RemotePlaybackPool` module behind the background runtime-message seam. Its external interface is intentionally small:

```ts
interface RemotePlaybackPool {
  openSession(request: PlaybackOpenSessionRequest): Promise<PlaybackOpenSessionResult>;
  prepare(request: PlaybackPrepareRequest): Promise<PlaybackPrepareResult>;
  settle(request: PlaybackSettleRequest): Promise<PlaybackSettleResult>;
  hintConnectivity(request: PlaybackConnectivityHintRequest): Promise<void>;
  closeSession(sessionToken: string): Promise<void>;
  refresh(config: RemoteSourceConfig): Promise<void>;
  remove(sourceId?: string): Promise<void>;
}
```

The implementation hides:

- active and shadow catalog generations;
- resumable WebDAV discovery checkpoints;
- sequential ordinals and shuffle permutations;
- idempotent request IDs, reservations, leases, and expiry;
- typed transport classification, a source-level connectivity backoff/circuit, retry policy, and round barriers;
- authenticated fetches, redirect validation, content policy, and cache admission;
- lookahead preparation, LRU eviction, and cache pressure;
- worker restart, source refresh, delete, and clear races.

The module depends on internal seams with production and in-memory test adapters:

- `CatalogRepository`: IndexedDB and memory adapters;
- `PlaybackStateRepository`: IndexedDB and memory adapters;
- `ImageByteStore`: `RemoteCache` and memory adapters, including `listReadable(sourceId, fingerprint)` for fallback selection;
- source discovery/fetch adapters: WebDAV, Direct, JSON API, TMDB, and deterministic fakes;
- clock and RNG dependencies for lease expiry, retry timing, and shuffle seeds.

`ImageByteStore` extends the existing `RemoteCache.listSource(sourceId, fingerprint)` index query rather than creating a second byte index. Every successful cache admission already records the stable image ID, opaque source identity, byte-cache key, safe descriptor, and access time; the new adapter may join an active catalog ordinal at query time. Eviction and source deletion remove the index record, and startup reconciliation drops index records whose bytes no longer exist. The query never returns source credentials, authorization headers, signed remote locators, or raw response data.

The page receives a `PlaybackClient` adapter over runtime messages. `useBackgroundRotation` retains React lifecycle, keyboard/timer coalescing, decode, and transition state, but no longer owns remote catalog windows or shuffle bags.

## Runtime Interface

```ts
type PlaybackIntent =
  | { kind: 'advance'; direction: 'next'; order: RotationOrder }
  | { kind: 'history'; imageId: string };

interface PlaybackOpenSessionRequest {
  playback: 'open-session';
  config: RemoteSourceConfig;
  sessionId: string;
  onlineHint: boolean;
}

type PlaybackOpenSessionResult =
  | {
      ok: true;
      sessionToken: string;
      sourceEpoch: string;
      activeCatalogGeneration?: string;
    }
  | { ok: false; error: SourceError };

interface PlaybackPrepareRequest {
  playback: 'prepare';
  sessionToken: string;
  requestId: string;
  intent: PlaybackIntent;
}

interface PlaybackConnectivityHintRequest {
  playback: 'connectivity-hint';
  sessionToken: string;
  online: boolean;
}

interface PlaybackCloseSessionRequest {
  playback: 'close-session';
  sessionToken: string;
}

type PlaybackPrepareResult =
  | {
      ok: true;
      state: 'ready';
      selection: 'catalog';
      reservationId: string;
      catalogGeneration: string;
      catalogRound: number;
      catalogTotalCount: number;
      image: CacheBackedImageEntry;
      warnings?: SourceError[];
    }
  | {
      ok: true;
      state: 'ready';
      selection: 'cache-fallback';
      fallbackReason: 'offline-hint' | 'transport-failure';
      reservationId: string;
      fallbackSnapshotId: string;
      fallbackRound: number;
      fallbackCount: number;
      image: CacheBackedImageEntry;
      warnings?: SourceError[];
    }
  | {
      ok: true;
      state: 'waiting';
      reason: 'catalog-discovery' | 'candidate-retry' | 'round-barrier' | 'cache-pressure' | 'cache-fallback-empty';
      retryAfterMs: number;
      discoveredCount?: number;
      warnings?: SourceError[];
    }
  | { ok: true; state: 'reopen-required' }
  | { ok: false; error: SourceError; warnings?: SourceError[] };

interface PlaybackSettleRequest {
  playback: 'settle';
  sessionToken: string;
  requestId: string;
  reservationId: string;
  outcome: 'displayed' | 'decode-failed' | 'abandoned';
}

type PlaybackSettleResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'stale-session' | 'stale-generation' | 'invalid-reservation' };
```

`openSession` computes the exact source fingerprint, binds the opaque `sessionToken` to `(sessionId, sourceId, fingerprint, sourceEpoch)`, and keeps the source config only in worker memory. The current monotonic source epoch and non-secret binding are durable: reopening the same session/config after a worker restart reuses that epoch and rebinds its request/fallback state to a new token. A config change increments the epoch, even if the user later switches back to an older fingerprint, and rejects delayed prepare, settle, or connectivity messages from the old token. The `PlaybackClient` transparently reopens with the page-held config after a worker restart returns `reopen-required`; credentials are never added to durable session state.

`requestId` is generated once per logical navigation. Message timeout and retry reuse the same ID, making `prepare` idempotent. A ready reservation is an unguessable token bound server-side to its session token, epoch, generation or fallback snapshot, and selection kind; settle validates that binding rather than trusting page-supplied kind fields. A reservation expires after two minutes if it is not settled. Expiry returns the candidate to the same round; it does not consume it or open the next round.

The top-level `selection` discriminator gives catalog and fallback counts different field names, so TypeScript and the UI cannot accidentally present `fallbackCount` as the source's full image count.

A `cache-fallback` reservation is a separate, session-local lease. Settling it updates displayed history and the fallback cursor only; it never writes the complete-catalog cursor or round. Its expiry returns the cached candidate to the same fallback round. When connectivity is known to be unavailable and a complete catalog exists, the pool may claim the next catalog candidate and read only its cache record. A hit remains a normal catalog reservation; a miss is released unchanged into the original round's retry queue and becomes the source's connectivity blocker. If a fetch discovers network loss after a claim, it performs the same release. While that blocker exists, further fallback advances create no catalog claims. A successful recovery probe clears connectivity state; the next normal advance prioritizes the returned catalog candidate without forcing an immediate visual change at the moment connectivity returns.

The fallback snapshot, cursor, request mapping, and leases are stored under `sessionId + sourceId + fingerprint + sourceEpoch` in `PlaybackStateRepository` with TTL cleanup. This state contains at most the 36 bounded cached IDs and no source config or credentials. It preserves `requestId` idempotency across MV3 worker restarts while a tab is alive without copying the full catalog or pinning the fallback snapshot indefinitely.

The page sends the current browser connectivity hint when a session opens and forwards later `online`/`offline` changes through `hintConnectivity`. A hint is accepted only for the live session token and its bound source epoch, so delayed events from an old configuration cannot affect the new source. `navigator.onLine === false` is an immediate hint, while the background retains typed transport results for DNS, connection, and deadline failures instead of flattening every exception into the public `network` code. The hint is not proof of reachability: returning online is confirmed only by successful retry of the exact blocked image fetch or discovery work. Source-switch/delete/clear cancellation, runtime callback timeout, HTTP 4xx, HTTP 5xx, rate limits, policy rejection, decode failure, and storage pressure do not activate cache fallback. User-facing diagnostics say “source unreachable; using cached images” for transport failures and say “offline” only when the browser hint is false.

An atomic catalog-generation swap keeps the source epoch and live sessions but routes every new prepare to the new generation. It cancels old-generation connectivity blockers and invalidates remaining fallback snapshots so they rebuild against the new catalog. An already returned old-generation reservation may settle only in its old namespace and can update tab-local displayed history, never the new generation's cursor or round. The currently displayed Blob remains visible through the swap.

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

There is no arbitrary total-image cutoff for an otherwise valid finite source. If metadata persistence reaches browser quota, or one directory cannot be safely parsed within the response limit, discovery becomes explicitly blocked and the old snapshot remains active. A first-time source without readable exact-fingerprint cache stays on the bundled background rather than pretending the partial catalog is complete; cache fallback remains allowed during connectivity failure and is explicitly labeled incomplete.

Catalog metadata is O(N) and may be large; this is the deliberate cost of complete selection. Image bytes remain independently bounded. Safe WebDAV locators may be persisted without credentials, query, or fragment. JSON API catalogs containing volatile or signed URLs remain memory-only and are rediscovered after a worker restart.

## Ordering and Shared Playback State

Each complete catalog generation has immutable, contiguous ordinals and unique stable IDs.

Sequential state stores the next ordinal and the current round. Shuffle state stores a seed, round, and next permutation position. A deterministic seeded Fisher-Yates permutation is rebuilt in memory from catalog length after a worker restart; persisted state remains O(1). Starting a new shuffle round chooses a new seed and prevents the first ID from matching the prior round's last displayed ID when more than one entry exists.

The following invariants are mandatory:

1. Every ordinal can have at most one active reservation in a round.
2. Lookahead never creates a reservation and never advances a position.
3. The next-unreserved high-water position advances when a unique reservation is created; a slow reservation does not prevent another tab from reserving a later position.
4. Retryable non-connectivity failures remain attached to their original reservation and return `waiting` with bounded backoff. A transport failure returns the unresolved ordinal to its original round before cache fallback begins.
5. Decode failure settles the reservation as failed for the current round; the ID remains eligible in later rounds.
6. A new round starts only after every ordinal in the current round is displayed or conclusively failed and no reservation remains active.
7. Cache eviction cannot alter any ordinal, seed, position, reservation, or history record.
8. Refresh creates a new generation; stale asynchronous work cannot write into it.
9. Cache-fallback reservations and cursors are namespaced separately and cannot satisfy or mutate a complete-catalog reservation.

Claims are serialized only for the short state transaction. Network fetch, cache write, page materialization, and decode happen outside the state lock. Concurrent tabs therefore receive unique later reservations without one slow download holding either the lock or the reservation high-water mark. The round barrier still waits for every reservation in that round to settle or expire before permitting wraparound.

## Byte Preparation and Eviction

For each advance request, the pool resolves the selected ordinal and the next two logical ordinals in that round. It must prepare the selected image before returning `ready`. The two lookahead images are fetched with best-effort concurrency of two; their failures create diagnostics but do not move or fail their future playback positions.

`RemoteCache` gains an entry-count budget in addition to its existing byte budget:

- maximum total bytes: 250 MiB;
- maximum entries: 36;
- maximum individual entry: 16 MiB;
- selected image and active reservations are hard-protected only until the page has materialized an owned `Response`/`Blob`;
- displayed current/previous object URLs need no cache pin because their Blob bytes remain valid after Cache Storage eviction;
- lookahead is soft and may be evicted first;
- all other entries use global LRU order across sources;
- admission must finish at or below both hard budgets, otherwise it fails without publishing an unreadable descriptor.

Cache hits still update LRU access time. The cache entry-count limit prevents a source containing thousands of small files from being cached in full, while the byte limit handles a smaller number of large files.

The current `RemoteCache.put` reads the remote response body while holding its global queue/lock, which would let a slow download block cache fallback. `ImageByteStore` changes that boundary: streaming read, size/content validation, and construction of the bounded prepared body happen outside the write lock. A short exclusive commit admits already prepared bytes, updates metadata/LRU, and enforces both budgets. `get` and `listReadable` use a read snapshot and do not wait for ingestion; they recheck the cache/source epoch before returning. Clear, source delete, and refresh increment the relevant epoch first, so a concurrent stale read or staged write cannot publish after invalidation. Enumeration still tolerates an eviction race by re-reading the selected cache key during materialization.

The fallback candidate query is restricted to fully admitted records with safe descriptors for the exact active `sourceId + fingerprint`, and it confirms that bytes are still readable both while enumerating and again while materializing. When an active complete catalog exists, candidates are intersected with that catalog generation and sequential order uses catalog ordinals. Without a complete snapshot, the pool may use records tied to the exact source configuration revision and sorts sequential fallback by stable opaque image ID. A fallback round snapshots cache membership when the round begins: entries added later join the next fallback round, while an entry evicted before materialization is skipped with a diagnostic. Cache membership changes may reduce offline availability but never change the primary playback round.

Object URLs are not lookahead storage. A tab materializes only the selected candidate, keeps the prior displayed image through its transition, and releases every other lease. This caps tab-owned object URLs at three independently of catalog or Cache Storage size.

`PlaybackClient.dispose` revokes its object URLs and sends `closeSession` best-effort. Active preparation and fallback leases expire after two minutes even when close is lost to a tab crash; fallback state has the same TTL cleanup. Because displayed images hold no cache pin, an abandoned session cannot permanently consume the 36-entry cache budget.

## Playback Data Flow

1. `App` opens a remote playback session for the active source.
2. Initial/new-tab/manual/interval navigation creates one `requestId` and calls `prepare`.
3. If no complete catalog exists, discovery advances and returns `waiting`; the current or bundled background remains visible.
4. The page retries the same request after `retryAfterMs` or an explicit catalog wake-up.
5. The pool atomically reserves the next full-catalog candidate, prepares its bytes, and starts best-effort lookahead.
6. The page materializes one cache descriptor, decodes it, and calls `settle`.
7. `displayed` publishes current/previous and commits the occurrence. `decode-failed` releases the URL and continues the same logical navigation with the next eligible candidate. `abandoned` releases the reservation for the same round.
8. Interval scheduling restarts only after a successful display; a pending catalog or candidate keeps the current image visible.

If connectivity is unavailable during steps 3-5, the pool enters cache fallback for that session. Manual and interval `next` requests walk the session's cache-only sequential round or shuffle permutation at the configured cadence, while `previous` continues to use tab-local displayed history. The selected fallback image is materialized and settled through the same page seam with `selection === 'cache-fallback'`. An `online` event schedules immediate retry of the blocked fetch or discovery slice, and bounded background backoff provides recovery when the browser hint is inaccurate or no page event fires. Successful retry exits fallback and allows the next scheduled or manual navigation to return to complete-catalog playback; recovery alone does not replace the currently displayed fallback image or launch a separate full scan.

Cache fallback lookup and materialization run through the playback pool's short state and byte-store seams; they are never queued behind WebDAV discovery or a remote image fetch. Discovery, probing, and downloading remain outside the source-state transaction, so a long or stalled scan cannot prevent immediate use of already cached bytes.

For local sources, the page uses the same pure complete-round planner over all local stable IDs and the existing local storage adapter. Its seed, round, position, and pending reservations use the persistent playback-state adapter so sequential and shuffle rounds also survive new tabs. The remote Cache Storage budgets do not apply because imported local images are source data. Bundled fallback remains a single-entry local pool.

## Failure and Recovery Behavior

- Retryable HTTP 5xx, rate-limit, storage, and non-connectivity source failures return `waiting`; they do not consume the candidate or cause wraparound.
- Confirmed or transport-classified network unavailability may return a ready cache-fallback candidate instead of `waiting`; ordinary server and application errors remain on the normal retry path.
- Cache fallback retries a decode failure with the next cached candidate. If every cached candidate fails or disappears, playback freezes on the last successfully displayed image (or bundled background) and periodically probes for recovery without a tight loop.
- Cache fallback preserves the same 250 MiB, 36-entry, and 16 MiB limits. It never pins an entire source or exempts cached images from normal global LRU eviction; only active preparation/materialization is briefly protected, and displayed Blobs require no cache protection.
- Authentication and permission failures block the source generation and preserve the currently displayed image.
- Unsupported content, oversized images, and deterministic invalid-image responses fail that candidate for the current round and continue to another candidate.
- Page decode failure is recorded only for the current round and URL version. A refreshed URL or later round can retry it.
- If every catalog entry fails in one round, the pool reports a bounded retry state instead of opening an immediate failure loop.
- Worker restart restores catalog, primary cursor, fallback snapshot/position, reservations, and retry timestamps. Expired reservations become available in their original namespace and round.
- Source refresh failure preserves the active complete snapshot and marks it stale.
- Source deletion and global data clearing cancel in-flight work and remove catalog, playback state, and source cache records best-effort without allowing late work to repopulate them.

## Migration

- Legacy `CatalogRecord` has no trustworthy completeness proof. Only a Direct record whose validated IDs exactly equal the current configured Direct entries may migrate as complete generation zero. Legacy WebDAV, JSON API, and TMDB records are never promoted to a complete active catalog; they may provide exact-fingerprint cache fallback and stable ordering hints while a new generation is discovered to completion.
- Existing Chrome sequential cursor values seed the matching catalog ordinal once; after durable playback state is written, the legacy cursor is removed.
- Existing shuffle state cannot represent a complete cross-tab round, so shuffle begins a new seeded round while avoiding the legacy last displayed ID as the first candidate.
- Existing Cache Storage keys and byte records remain reusable; migration does not download or duplicate images.
- Existing cache metadata remains the fallback index. Legacy records without a safe descriptor are still readable by a known catalog ID but are not enumerable as fallback candidates; unsafe or unbounded Direct entry IDs are mapped to opaque candidate IDs before new metadata is persisted or sent over runtime messages.
- The old `source:list` request remains for settings preview and diagnostics, but no longer drives background playback.
- Replace the current whole-operation same-source queue with short catalog/playback state transactions. WebDAV discovery and remote fetches run outside those transactions, so cache fallback cannot wait behind network work.
- Remove App's remote window ownership, offset state, near-end prefetch, and `onEntriesExhausted` path after the new playback client is active.
- Remove remote selection from `useBackgroundRotation`; retain timer, keyboard, decode, direction, current/previous, and local planner behavior.

## Testing

Tests target the new playback-pool interface and observable UI behavior rather than its internal windows.

- Sequential property tests: for arbitrary catalog sizes and interleaved tabs, the first completed round records every ID exactly once as displayed or conclusively failed before any displayed ID repeats; concurrent active reservations remain unique even when preparation retries.
- Shuffle property tests: every round is a full permutation; worker restart continues the same seed/position; consecutive rounds avoid an immediate boundary repeat.
- Slow-tail test: the final candidate remains pending and a new claim waits at the round barrier instead of returning ordinal zero.
- Idempotency test: repeated `prepare` with one request ID returns the same reservation across callback timeout and worker restart.
- Failure tests: a single transient failure is retried; a decode failure does not disappear forever; all-failed rounds do not spin.
- Lookahead tests: selected plus two logical successors are prepared in both order modes, while cursor state advances only for the selected reservation.
- Offline sequential tests: transport loss selects every fallback-snapshot image once in stable order before repeating, performs no fetch, and fallback settlement does not move the complete-catalog cursor.
- Offline shuffle tests: one cache snapshot is a full permutation without repeats; a new cache member waits for the next fallback round; an evicted member is skipped safely.
- Offline restart test: reopening the same session/config after an MV3 restart preserves the fallback permutation position and returns the same reservation for a retried request ID.
- Offline catalog-hit test: cached complete-catalog successors continue settling in primary order without network until the first uncached candidate activates fallback.
- Offline isolation tests: records from another source/configuration cannot be selected; cache index records never expose credentials or signed locators.
- Offline first-use test: without a complete catalog, transport loss may use only readable records under the exact current fingerprint and labels the result as a cache subset rather than a complete source.
- Offline recovery tests: a fetch failure returns the catalog candidate unchanged to its round, repeated offline advances create no catalog claims, successful probing does not force a visual switch, and the next normal advance prioritizes the returned candidate.
- Offline empty/decode tests: no usable cached bytes preserves current/bundled display, all cached decode failures do not spin, and browser online/offline hints cannot misclassify HTTP or policy errors as connectivity loss.
- Offline latency tests: a stalled WebDAV discovery cannot delay a cache-fallback result; source-switch/delete/clear aborts and runtime callback timeouts do not open the connectivity circuit.
- Session epoch tests: delayed hint/settle/close messages from a prior config epoch are harmless; an atomic catalog refresh invalidates old blockers and rebuilds fallback without mutating the new round.
- Legacy migration tests: a timed-out or 20,000-entry WebDAV v1 record never becomes complete or starts a primary round; only a provably exact Direct record can migrate complete.
- Cache tests: many small images never exceed 36 entries; large images never exceed 250 MiB; one image never exceeds 16 MiB; active preparation survives and soft lookahead is evicted first; displayed/closed sessions leave no permanent cache pin.
- Byte-store concurrency tests: a slow streamed admission does not block `listReadable` or a cache hit, while delete/clear epochs prevent stale staged bytes or fallback reads from publishing afterward.
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
- No full-image preloading, thumbnail generation, offline pinning of an entire source, guarantee that uncached source images are available offline, or unbounded object-URL history.
- No changes to source configuration UI, transition visuals, clock, weather, search, or shortcuts.

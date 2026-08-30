# Complete Playback Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sequential and shuffle playback select every image from a proven-complete source catalog, prepare only the selected image plus two successors, keep remote bytes/object URLs bounded, and fall back to exact-source readable cache entries when the browser or source transport is unavailable.

**Architecture:** Add a background-owned `RemotePlaybackPool` behind strict runtime messages. It atomically reserves positions from durable complete-catalog rounds, performs discovery and byte preparation outside state locks, and owns a separate session-local cache-fallback namespace. WebDAV discovery becomes resumable and only publishes after BFS exhaustion. The new-tab page receives one materializable candidate at a time and retains only React lifecycle, decode, timer, keyboard, transition, and bounded tab-local history responsibilities.

**Tech Stack:** TypeScript 7, React 19, Chrome Extension MV3 runtime messaging, IndexedDB, Cache Storage, Vitest 4 with `fake-indexeddb`, Playwright, Vite 8.

**Spec:** [`docs/superpowers/specs/2026-08-31-complete-playback-pool-design.md`](../specs/2026-08-31-complete-playback-pool-design.md)

## Global Constraints

- Preserve all pre-existing staged, unstaged, and untracked user changes. In particular, do not discard the current edits in `src/newtab/App.tsx`, `src/newtab/App.test.tsx`, `src/newtab/hooks/useBackgroundRotation.ts`, or `src/newtab/hooks/useBackgroundRotation.test.ts`; replace their temporary exhaustion workaround only when the new path is covered.
- Follow strict TDD. For every behavior below, add the focused test, run it and observe the expected failure, then write only enough production code to make it pass. Record unexpected failures before changing implementation.
- Do not add dependencies. Do not persist or return credentials, authorization headers, signed locators, raw protected errors, response bodies, or synthetic Cache Storage keys.
- A primary playback candidate may come only from a `completeness: 'complete'` catalog generation. A cache subset is legal only in the top-level `selection: 'cache-fallback'` branch.
- All discovery, network fetch, streaming response validation, Cache Storage reads, and image decode happen outside catalog/playback-state transactions and outside the existing whole-source queue.
- Keep durable metadata O(N), shuffle state O(1), Cache Storage at or below 250 MiB and 36 entries, each remote image at or below 16 MiB, lookahead exactly two, and tab-owned remote object URLs at or below three.
- Configuration changes use monotonically new opaque source epochs, including A -> B -> A. A catalog refresh changes generation, not source epoch. Delete/clear advance invalidation fences before asynchronous cleanup.
- `requestId` is stable for one logical navigation. Callback retry, `waiting`, decode failure, and worker reopen reuse it; a new manual/interval navigation creates a new ID.
- Never run a focused task's commit command until its focused tests pass and `git diff --check` is clean. Stage only files named by that task.

---

### Task 1: Freeze playback wire contracts and deterministic round planning

**Files:**
- Create: `src/background/playbackMessages.ts`
- Create: `src/background/playbackMessages.test.ts`
- Create: `src/domain/playbackRound.ts`
- Create: `src/domain/playbackRound.test.ts`
- Modify: `src/sources/adapter.ts`

**Interfaces:**
- Produces the single shared runtime contract imported by the worker and new tab.
- Produces a pure round plan used by remote and local playback; it performs no I/O and mutates no cursor.

- [ ] **Step 1: Add failing runtime-contract tests**

Add table-driven tests that accept only the five exact requests below and reject missing fields, local configs, invalid orders/outcomes, extra union combinations, blank IDs/tokens, and non-boolean online hints. Add compile-time assertions that catalog and fallback results cannot expose each other's count fields.

```ts
type RemoteSourceConfig = Exclude<SourceConfig, { type: 'local' }>;

type PlaybackIntent =
  | { kind: 'advance'; direction: 'next'; order: RotationOrder }
  | { kind: 'history'; imageId: string };

type PlaybackBackgroundRequest =
  | { playback: 'open-session'; config: RemoteSourceConfig; sessionId: string; onlineHint: boolean }
  | { playback: 'prepare'; sessionToken: string; requestId: string; intent: PlaybackIntent }
  | { playback: 'settle'; sessionToken: string; requestId: string; reservationId: string; outcome: 'displayed' | 'decode-failed' | 'abandoned' }
  | { playback: 'connectivity-hint'; sessionToken: string; online: boolean }
  | { playback: 'close-session'; sessionToken: string };

type PlaybackOpenSessionResult =
  | { ok: true; sessionToken: string; sourceEpoch: string; activeCatalogGeneration?: string }
  | { ok: false; error: SourceError };

type PlaybackSettleResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'stale-session' | 'stale-generation' | 'invalid-reservation' };

type PlaybackConnectivityResult = { ok: true } | { ok: false; reason: 'stale-session' };
type PlaybackCloseSessionResult = { ok: true };
```

The response union must exactly preserve the spec's top-level branches:

```ts
type PlaybackPrepareResult =
  | { ok: true; state: 'ready'; selection: 'catalog'; reservationId: string; catalogGeneration: string; catalogRound: number; catalogTotalCount: number; image: CacheBackedImageEntry; warnings?: SourceError[] }
  | { ok: true; state: 'ready'; selection: 'cache-fallback'; fallbackReason: 'offline-hint' | 'transport-failure'; reservationId: string; fallbackSnapshotId: string; fallbackRound: number; fallbackCount: number; image: CacheBackedImageEntry; warnings?: SourceError[] }
  | { ok: true; state: 'waiting'; reason: 'catalog-discovery' | 'candidate-retry' | 'round-barrier' | 'cache-pressure' | 'cache-fallback-empty'; retryAfterMs: number; discoveredCount?: number; warnings?: SourceError[] }
  | { ok: true; state: 'reopen-required' }
  | { ok: false; error: SourceError; warnings?: SourceError[] };
```

Define the catalog/runtime split exactly; catalog locators never cross the runtime seam, and runtime metadata omits `sourceUrl`/`authorUrl`:

```ts
type SafePlaybackImageMetadata = Pick<ImageEntryBase,
  'id' | 'sourceId' | 'dimensions' | 'previewColor' | 'description' | 'author' | 'attribution'>;

interface RemoteCatalogImageEntry extends SafePlaybackImageMetadata {
  /** Opaque digest-derived candidate ID, never the user Direct ID or URL. */
  id: string;
  locator: { kind: 'http-url'; url: string };
}

interface CacheBackedImageEntry extends SafePlaybackImageMetadata {
  remoteCacheEntryId: string;
  remoteCacheFingerprint: string;
}
```

At this contract layer, use `expectTypeOf` and runtime guard tests to prove a cache-backed response cannot contain `locator`, `url`, `sourceUrl`, or `authorUrl`. Full signed Direct ID leakage coverage is added when the producer/storage seams exist in Tasks 5, 6, 11, and 16.

- [ ] **Step 2: Add failing round-plan tests**

Cover lengths 0, 1, 2, 37, sequential starts other than zero, a fixed shuffle seed across reconstruction, full-permutation uniqueness, `avoidFirstOrdinal`, and successors that stop at the current round boundary.

```ts
expect(createPlaybackRoundPlan({ order: 'sequential', round: 4, totalCount: 4, startOrdinal: 2 })
  .positions()).toEqual([2, 3, 0, 1]);

const first = createPlaybackRoundPlan({ order: 'shuffle', round: 7, totalCount: 37, startOrdinal: 0, seed: 1234 });
const restored = createPlaybackRoundPlan({ order: 'shuffle', round: 7, totalCount: 37, startOrdinal: 0, seed: 1234 });
expect(restored.positions()).toEqual(first.positions());
expect(new Set(first.positions())).toEqual(new Set(Array.from({ length: 37 }, (_, index) => index)));
expect(first.successors(35, 2)).toHaveLength(1);
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/playbackMessages.test.ts src/domain/playbackRound.test.ts`

Expected: both suites fail because the new modules and exported types do not exist.

- [ ] **Step 4: Implement strict guards and the pure planner**

Implement `isPlaybackBackgroundRequest(value: unknown)` without coercion. Implement sequential modular ordering and seeded Fisher-Yates using a local deterministic uint32 generator. Rebuild the permutation in memory; persist only the seed and next position. `successors(position, count)` must slice only positions after the selected position and never wrap.

```ts
export interface PlaybackRoundPlan {
  readonly totalCount: number;
  ordinalAt(position: number): number | undefined;
  positions(): number[];
  successors(position: number, count: number): number[];
}

export function createPlaybackRoundPlan(descriptor: PlaybackRoundDescriptor): PlaybackRoundPlan;
export function createShuffleSeed(randomUint32: () => number): number;
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/playbackMessages.test.ts src/domain/playbackRound.test.ts`

Expected: both suites pass.

Run: `git add src/background/playbackMessages.ts src/background/playbackMessages.test.ts src/domain/playbackRound.ts src/domain/playbackRound.test.ts src/sources/adapter.ts && git commit -m "feat: define complete playback protocol"`

---

### Task 2: Add an atomic durable playback-state repository

**Files:**
- Create: `src/storage/playbackStateRepository.ts`
- Create: `src/storage/playbackStateRepository.test.ts`

**Interfaces:**
- Consumes stable round keys and wire IDs from Task 1.
- Produces synchronous atomic state mutation for source binding, catalog rounds, reservations, retry queues, and session-local fallback state.

- [ ] **Step 1: Write a shared failing contract suite**

Run the same tests against an in-memory adapter and IndexedDB adapter. Prove two concurrent transactions do not lose increments, a transaction resolves only after `oncomplete`, a thrown mutation writes nothing, structured-clone isolation holds, and `delete`/`clear` remove their exact scopes.

```ts
const increments = await Promise.all([
  repository.transact('source-a', incrementRevision),
  repository.transact('source-a', incrementRevision)
]);
expect(increments.sort()).toEqual([1, 2]);
expect((await repository.get('source-a'))?.revision).toBe(2);
```

Add source-binding tests with monotonically increasing config revisions: first A creates epoch 1, reopening the same A/revision reuses it, newer A -> B -> A produces three different opaque epoch values with serials 1 -> 2 -> 3, an older A cannot displace B, and repository reconstruction preserves the latest binding. Add durable request tests proving the same request ID is bound to one immutable intent/order, repeated settlement returns the recorded result, displayed completes the request, decode failure advances its attempt number, and expired tombstones are cleaned only after their retry/idempotency window.

- [ ] **Step 2: Define the persisted state without secrets**

Use these top-level shapes; all mutation callbacks are synchronous so IndexedDB cannot auto-close during an `await`:

```ts
interface PlaybackSourceState {
  schemaVersion: 1;
  sourceId: string;
  revision: number;
  binding?: { fingerprint: string; sourceEpoch: string; epochSerial: number; configRevision: number };
  /** Canonical active pointer; catalog storage never owns a second active pointer. */
  activeCatalogGeneration?: string;
  refresh: { status: 'idle' | 'pending' | 'stale'; discoveryGeneration?: string; warning?: SourceError };
  connectivity?: { sourceEpoch: string; catalogGeneration?: string; blockedRoundKey?: string; blockedPosition?: number; imageId?: string; nextProbeAt: number; reason: 'offline-hint' | 'transport-failure' };
  lookaheadJobs: Record<string, { sourceEpoch: string; catalogGeneration: string; ordinal: number; status: 'pending' | 'running'; retryAt: number; expiresAt: number }>;
  rounds: Record<string, CatalogRoundState>;
  sessions: Record<string, PlaybackSessionState>;
  updatedAt: number;
}

interface PlaybackStateRepository {
  get(sourceId: string): Promise<PlaybackSourceState | undefined>;
  list(): Promise<PlaybackSourceState[]>;
  transact<T>(sourceId: string, mutation: (current: Readonly<PlaybackSourceState> | undefined) => { state: PlaybackSourceState | null; result: T }): Promise<T>;
  delete(sourceId: string): Promise<void>;
  clear(): Promise<void>;
}
```

`CatalogRoundState` stores generation, source epoch, order, round, seed/start ordinal, high-water position, settled/failed counts, last displayed ID, sorted unique retry positions, active reservations, and `nextRoundNotBefore`. Connectivity is deliberately source-level, not round/order-level, and references the unresolved round/position from `PlaybackSourceState.connectivity`, so one sequential transport failure prevents shuffle/another tab from opening new network claims.

Each `PlaybackSessionState.requests[requestId]` stores an immutable intent fingerprint, current attempt, phase (`claiming | ready | fallback-pending | next-attempt | completed`), active reservation ID if any, and completed prepare/settle tombstones. A repeated prepare/settle returns that durable result; reuse of the ID with another order/history ID is rejected. `fallback-pending` means the primary position is already durably returned to the source blocker and retry may create only a session-local fallback reservation. `PlaybackSessionState` also stores at most 36 fallback IDs/order positions, fallback leases, displayed ID, and sliding `lastActiveAt`/`idleExpiresAt`. Set `FALLBACK_SESSION_IDLE_TTL_MS` to 25 hours, exceeding the product's maximum 24-hour rotation interval; `closeSession` cleans immediately and fixed reservation leases remain two minutes. It must contain no config or locator.

Treat validated `SourceConfig.updatedAt` as the authoritative monotonic `configRevision`: an open with a lower revision is stale and cannot change binding; the same revision with another fingerprint is rejected; only a higher revision may create a new source epoch. Test two tabs where B supersedes A, the old A tab reopens without invalidating B, and a genuinely edited A with a higher revision is accepted.

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/storage/playbackStateRepository.test.ts`

Expected: module resolution fails.

- [ ] **Step 4: Implement memory and IndexedDB adapters**

Use database `newpictab-playback-state`, version 1, store `sources`, key path `sourceId`. In the IndexedDB adapter, call the synchronous mutation from `getRequest.onsuccess`, issue `put`/`delete` in that same readwrite transaction, and resolve only from `transaction.oncomplete`. Clone input and output state. Use `JSON.stringify([sourceEpoch, generation, order])` for round keys, never delimiter concatenation.

Export deterministic helpers:

```ts
export function bindSourceState(current: PlaybackSourceState | undefined, sourceId: string, fingerprint: string, configRevision: number, createEpoch: () => string, now: number): { state: PlaybackSourceState; binding: NonNullable<PlaybackSourceState['binding']>; changed: boolean; stale: boolean };
export function cleanupExpiredPlaybackState(state: PlaybackSourceState, now: number): PlaybackSourceState;
```

Cleanup returns expired catalog reservations to their original sorted retry queue and removes request/fallback records only after their recorded sliding idle deadline, without advancing either round.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/storage/playbackStateRepository.test.ts`

Run: `git add src/storage/playbackStateRepository.ts src/storage/playbackStateRepository.test.ts && git commit -m "feat: persist playback round state"`

---

### Task 3: Upgrade the catalog repository to proven complete generations

**Files:**
- Modify: `src/storage/catalogRepository.ts`
- Modify: `src/storage/catalogRepository.test.ts`
- Modify: `src/domain/sourceFingerprint.ts`
- Modify: `src/domain/sourceFingerprint.test.ts`

**Interfaces:**
- Consumes private catalog metadata from Task 1 and exact source fingerprints.
- Produces immutable ready generations, ordinal reads, normalized WebDAV checkpoints, fenced shadow publication, and explicit legacy reads. Task 2's `activeCatalogGeneration` is the only canonical active pointer.

- [ ] **Step 1: Write failing v2 repository and migration tests**

Create a real version-1 database fixture before opening version 2. Assert:

- no v1 WebDAV, JSON API, TMDB, or Direct record is returned as a ready generation; strict Direct promotion is owned and tested by Task 16 because it requires the current validated config;
- a previously ready generation remains readable while a shadow generation is built and after another generation becomes ready;
- publishing marks one immutable generation ready but never mutates the canonical playback-state active pointer;
- a stale source-epoch/discovery-generation fence cannot append a directory delta or publish;
- a late Direct, JSON API, or TMDB result that ignored abort cannot publish after config change, source delete, or global clear;
- final WebDAV publish deletes its checkpoint in the same transaction;
- unsafe query/fragment locators and JSON API catalogs are memory-only and never appear in IndexedDB.

- [ ] **Step 2: Replace the ambiguous record contract**

```ts
interface CatalogGenerationKey {
  sourceId: string;
  fingerprint: string;
  generation: string;
}

interface CatalogDiscoveryScope {
  sourceId: string;
  sourceType: Exclude<SourceType, 'local'>;
  fingerprint: string;
}

interface WebDavDiscoveryScope extends CatalogDiscoveryScope {
  sourceType: 'webdav';
}

interface DiscoveryFence {
  sourceEpoch: string;
  discoveryGeneration: string;
  invalidationSerial: number;
  checkpointRevision: number;
  queueHeadId?: string;
}

interface WebDavDirectoryDelta {
  completedHeadId: string;
  childDirectories: readonly { id: string; canonicalUrl: string }[];
  images: readonly RemoteCatalogImageEntry[];
  warnings: readonly SourceError[];
}

interface CompleteCatalogRecord {
  schemaVersion: 2;
  completeness: 'complete';
  sourceId: string;
  sourceType: Exclude<SourceType, 'local'>;
  fingerprint: string;
  generation: string;
  totalCount: number;
  completedAt: number;
  warnings?: SourceError[];
}

interface CatalogRepository {
  /** Compatibility facade used only by source:list settings preview/diagnostics. */
  get(sourceId: string, fingerprint: string): Promise<LegacyCatalogRecord | undefined>;
  /** Compatibility facade used only by source:list settings preview/diagnostics. */
  put(record: LegacyCatalogRecord): Promise<void>;
  getGeneration(key: CatalogGenerationKey): Promise<CompleteCatalogRecord | undefined>;
  getLatestReady(sourceId: string, fingerprint: string, sourceEpoch: string): Promise<CompleteCatalogRecord | undefined>;
  getEntries(key: CatalogGenerationKey, ordinals: readonly number[]): Promise<RemoteCatalogImageEntry[]>;
  getEntryById(key: CatalogGenerationKey, imageId: string): Promise<{ ordinal: number; entry: RemoteCatalogImageEntry } | undefined>;
  beginDiscovery(scope: CatalogDiscoveryScope, sourceEpoch: string, discoveryGeneration: string): Promise<DiscoveryFence>;
  publishComplete(record: CompleteCatalogRecord, entries: readonly RemoteCatalogImageEntry[], expected: DiscoveryFence): Promise<boolean>;
  getLegacy(sourceId: string, fingerprint: string): Promise<LegacyCatalogRecord | undefined>;
  getWebDavCheckpoint(scope: WebDavDiscoveryScope): Promise<WebDavDiscoveryCheckpoint | undefined>;
  commitWebDavDirectory(scope: WebDavDiscoveryScope, expected: DiscoveryFence, delta: WebDavDirectoryDelta): Promise<{ state: 'committed'; nextFence: DiscoveryFence } | { state: 'stale' }>;
  publishWebDavComplete(scope: WebDavDiscoveryScope, expected: DiscoveryFence, record: CompleteCatalogRecord): Promise<boolean>;
  deleteGeneration(key: CatalogGenerationKey): Promise<void>;
  delete(sourceId: string, fingerprint?: string): Promise<void>;
  clear(): Promise<void>;
}
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/storage/catalogRepository.test.ts src/domain/sourceFingerprint.test.ts`

Expected: old v1 APIs cannot represent generations, checkpoints, or strict migration.

- [ ] **Step 4: Implement normalized v2 storage**

Upgrade `newpictab-remote-catalog` to version 2. Keep the v1 `catalogs` store for one-time legacy reads; add `generations`, `discoveries`, `webdavDirectories`, and `catalogEntries`. Store queue rows and catalog entry rows separately so each completed directory is O(delta), publication is an O(1) ready-state flip, and pool preparation reads only selected + two successor ordinals instead of cloning all metadata. Every source type first creates a durable discovery fence. In one transaction, final publication validates `(sourceEpoch, discoveryGeneration, invalidationSerial, checkpointRevision, queueHeadId)` and the source tombstone, marks the immutable generation ready, and deletes directory/checkpoint rows while retaining its `catalogEntries`. Source delete/clear advances and retains the invalidation fence before deleting data rows, so a late non-WebDAV result cannot recreate data. Keep an equivalently fenced in-memory overlay for non-persistable complete catalogs.

`DiscoveryFence` is a compare-and-swap token containing `sourceEpoch`, `discoveryGeneration`, `invalidationSerial`, `checkpointRevision`, and exact `queueHeadId`. Two runners consuming the same queue head cannot both advance it. Add a crash test where a generation becomes ready but the worker stops before Task 2 activation; the next open/prepare finds that ready generation and idempotently activates it in one playback-state transaction, clearing old connectivity/fallback state atomically with the canonical pointer change.

Ensure source fingerprints include every playback-relevant config field but never expose credential values; the SHA-256 digest remains the only persisted namespace.

Keep the existing `get`/`put` preview facade and its v1 `CatalogRecord` type alias compiling for `background/index.ts`; mark it deprecated and ensure the playback pool never calls it. Run `npm run typecheck` before this task's commit so the staged repository upgrade does not leave the legacy settings path broken.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/storage/catalogRepository.test.ts src/domain/sourceFingerprint.test.ts`

Run: `npm run typecheck`

Run: `git add src/storage/catalogRepository.ts src/storage/catalogRepository.test.ts src/domain/sourceFingerprint.ts src/domain/sourceFingerprint.test.ts && git commit -m "feat: store complete catalog generations"`

---

### Task 4: Make WebDAV discovery a resumable BFS state machine

**Files:**
- Create: `src/sources/webdavDiscovery.ts`
- Create: `src/sources/webdavDiscovery.test.ts`
- Modify: `src/sources/webdav.ts`
- Modify: `src/sources/webdav.test.ts`
- Modify: `src/sources/webdavPolicy.ts`

**Interfaces:**
- Consumes Task 3 checkpoint transactions and existing safe WebDAV request/parser policy.
- Produces `complete`, `pending`, `blocked`, or typed `transport-unavailable`; only `complete` may publish a primary catalog.

- [ ] **Step 1: Add failing multi-slice and restart tests**

Use deterministic directory fixtures to prove:

- two or more slices whose combined resources exceed 20,000 eventually include every image, with no active catalog between slices;
- BFS order is stable and a canonical cyclic directory is fetched once;
- root completes and child times out, then a new discovery instance resumes at that child with no duplicate/omission;
- two concurrent/restarted runners read the same `checkpointRevision + queueHeadId`; exactly one directory delta commits and the loser reloads rather than skipping the next directory;
- a fetch that ignores abort cannot commit after source epoch/generation changes;
- one directory above the 16 MiB XML limit or an IndexedDB metadata quota failure is `blocked` and preserves the old active generation;
- transport, auth, parse, and partial-directory failures never publish discovered partial entries;
- serialized checkpoints contain no username, password, authorization, userinfo, query, or fragment.

The critical restart assertion should observe the same persisted queue head:

```ts
expect(first.state).toBe('pending');
expect(await catalogs.getLatestReady(sourceId, fingerprint, sourceEpoch)).toBeUndefined();
expect((await playbackStates.get(sourceId))?.activeCatalogGeneration).toBeUndefined();
const resumed = await createWebDavDiscovery(secondFetcher, catalogs).run(scope, config, budget);
expect(resumed).toMatchObject({ state: 'complete', catalog: { totalCount: expectedIds.length } });
expect(requestedDirectories).toEqual(['/root/', '/root/a/', '/root/b/']);
```

- [ ] **Step 2: Define the work-slice contract**

```ts
type WebDavDiscoveryResult =
  | { state: 'complete'; catalog: CompleteCatalogRecord }
  | { state: 'pending'; discoveredCount: number; retryAfterMs: number; warnings?: SourceError[] }
  | { state: 'transport-unavailable'; discoveredCount: number; failure: 'dns' | 'connection' | 'deadline'; retryAfterMs: number }
  | { state: 'blocked'; error: SourceError; discoveredCount: number };

interface WebDavDiscoveryBudget {
  maxResources: number;
  deadlineMs: number;
}
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/sources/webdavDiscovery.test.ts src/sources/webdav.test.ts`

Expected: the current adapter restarts from root, marks directories visited before a successful response, and treats the 20,000-resource guard as a truncated success.

- [ ] **Step 4: Implement one-directory atomic checkpoints**

Move BFS orchestration into `webdavDiscovery.ts`; keep WebDAV authentication, safe canonicalization, bounded XML fetch, and parsing in `webdav.ts`. Do not mark the queue head visited before its entire response is validated. After each successful directory, compare-and-swap the exact `checkpointRevision + queueHeadId`, then atomically mark it visited, append unique child directories, append unique image IDs with contiguous ordinals, and advance the queue head/revision. A stale runner reloads and never applies its delta to a newer head. Yield only between directories. Treat 20,000 as a slice yield guard, never a total limit. Leave a failed transport directory at the queue head. Classify auth/policy/oversized/unsafe parse as blocked.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/sources/webdavDiscovery.test.ts src/sources/webdav.test.ts src/storage/catalogRepository.test.ts`

Run: `git add src/sources/webdavDiscovery.ts src/sources/webdavDiscovery.test.ts src/sources/webdav.ts src/sources/webdav.test.ts src/sources/webdavPolicy.ts && git commit -m "feat: resume complete webdav discovery"`

---

### Task 5: Remove non-WebDAV catalog truncation and unify discovery outcomes

**Files:**
- Create: `src/background/catalogDiscovery.ts`
- Create: `src/background/catalogDiscovery.test.ts`
- Modify: `src/sources/direct.ts`
- Modify: `src/sources/direct.test.ts`
- Modify: `src/sources/jsonApi.ts`
- Modify: `src/sources/jsonApi.test.ts`
- Modify: `src/sources/tmdb.ts`
- Modify: `src/sources/tmdb.test.ts`

**Interfaces:**
- Consumes all source adapters and Task 4 WebDAV discovery.
- Produces one background-private catalog discovery seam that preserves typed transport failures.

- [ ] **Step 1: Add failing completeness tests**

For JSON API, return 501 valid unique items in a response under 5 MiB and assert all 501 enter the complete result without a truncation warning. Its protected `testConnection` must collect every exact image origin, including an origin that appears only on item 501, while limiting only the rendered `preview` to six; otherwise later playback cannot request permission for the full catalog. For TMDB, return more than 100 valid results and assert every returned API result is considered. For Direct, configure more than 200 valid entries and assert playback discovery accepts all of them in configured order; settings preview may still slice after discovery. Direct deduplication/validation must be deterministic. Give one Direct entry a long signed-URL user ID and assert the catalog stores only an opaque candidate ID plus the separately governed locator. Add facade tests showing only a complete result creates a fenced ready generation; pending/transport/blocked outcomes leave Task 2's prior canonical pointer untouched.

- [ ] **Step 2: Define the facade result**

```ts
type RemoteCatalogDiscoveryResult =
  | { state: 'complete'; catalog: CompleteCatalogRecord }
  | { state: 'pending'; discoveredCount: number; retryAfterMs: number; warnings?: SourceError[] }
  | { state: 'transport-unavailable'; failure: 'dns' | 'connection' | 'deadline'; retryAfterMs: number; discoveredCount?: number }
  | { state: 'blocked'; error: SourceError; warnings?: SourceError[] };

interface RemoteCatalogDiscovery {
  ensureComplete(config: RemoteSourceConfig, sourceEpoch: string, signal?: AbortSignal): Promise<RemoteCatalogDiscoveryResult>;
  refresh(config: RemoteSourceConfig, sourceEpoch: string, signal?: AbortSignal): Promise<RemoteCatalogDiscoveryResult>;
  cancel(sourceId?: string): void;
}
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/catalogDiscovery.test.ts src/sources/direct.test.ts src/sources/jsonApi.test.ts src/sources/tmdb.test.ts`

Expected: JSON API stops at 500, TMDB stops at 100, and there is no complete-only publication facade.

- [ ] **Step 4: Implement complete finite mapping and typed internal errors**

Remove JSON/TMDB `LIST_LIMIT` and Direct `MAX_ENTRIES` from normal playback discovery. Keep UI thumbnail limits only in connection-preview code. Generate every catalog candidate ID with `opaqueImageId(sourceId, stable identity)`; never use a user Direct ID or locator as playback/cache state identity. Keep the locator private and separate. Convert `HttpRequestError.kind === 'network' | 'timeout'` to internal transport outcomes; redirects, too-large responses, abort/source switch, HTTP 4xx/5xx, rate limits, parse, and policy failures must remain non-connectivity outcomes. Persist only safe Direct/TMDB/WebDAV generations; keep volatile/signed JSON API generations in the Task 3 memory overlay.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/catalogDiscovery.test.ts src/sources/direct.test.ts src/sources/jsonApi.test.ts src/sources/tmdb.test.ts`

Run: `git add src/background/catalogDiscovery.ts src/background/catalogDiscovery.test.ts src/sources/direct.ts src/sources/direct.test.ts src/sources/jsonApi.ts src/sources/jsonApi.test.ts src/sources/tmdb.ts src/sources/tmdb.test.ts && git commit -m "feat: discover complete remote catalogs"`

---

### Task 6: Enforce dual cache budgets and make readable-cache fallback non-blocking

**Files:**
- Create: `src/storage/imageByteStore.ts`
- Create: `src/storage/imageByteStore.test.ts`
- Modify: `src/storage/remoteCache.ts`
- Modify: `src/storage/remoteCache.test.ts`

**Interfaces:**
- Produces a narrow `ImageByteStore` used by the pool instead of exposing Cache Storage internals.
- Extends the existing byte limit with an entry-count limit and moves response streaming outside the exclusive commit.

- [ ] **Step 1: Add failing capacity tests**

Write 100 one-byte images and assert both committed metadata and physical Cache Storage end with at most 36 entries. Independently trigger the 250 MiB byte budget and 16 MiB per-entry budget with small injected limits. Pause several concurrent staged puts and assert committed physical keys plus reserved stages remain within both limits throughout. Cover replacement of the same logical entry, simultaneous count/byte pressure, protected selected admission rollback, many failed/aborted tickets leaving no quota reservation, and soft lookahead eviction before a newer ordinary LRU entry.

```ts
const store = createImageByteStore({
  cache: cacheApi,
  metadata,
  maxBytes: 1_000,
  maxEntries: 3,
  maxEntryBytes: 600
});
for (let index = 0; index < 10; index += 1) {
  const ticket = await store.beginAdmission('source', `image-${index}`, 'fingerprint', 'epoch-1', 'generation-1');
  expect(ticket).toBeDefined();
  expect(await store.reserveAdmission(ticket!, 1)).toBe('reserved');
  await store.admit(oneBytePreparedBody(index), {
    ticket: ticket!,
    descriptor: cachedDescriptor(index),
    priority: 'lookahead'
  });
}
const records = await metadata.listCommittedAndStaged();
expect(records).toHaveLength(3);
expect(records.reduce((sum, record) => sum + record.size, 0)).toBeLessThanOrEqual(1_000);
```

- [ ] **Step 2: Add failing concurrency, invalidation, and enumeration tests**

Pause a response stream halfway through preparation, then separately pause `CacheBackend.put` after the body is prepared. In both cases, require an existing `get` and `listReadable` to finish, and require `deleteSource`/`clear` to finish. Resume the work and assert its stale staged write cannot publish. Recreate the `RemoteCache` instance between invalidation and resume to prove the mutation fence is durable across MV3/page contexts, not an in-memory counter. Race clear cleanup with a new higher-fence admission and prove cleanup cannot delete the new record. Also prove `listReadable`:

- returns only exact `sourceId + fingerprint` fully admitted records whose bytes exist;
- excludes metadata-only/cache-only orphans and unsafe legacy descriptors;
- contains no cache key, URL, header, or locator;
- tolerates eviction after enumeration by returning a miss on the later materialization re-read.

- [ ] **Step 3: Define the byte-store seam**

```ts
export const DEFAULT_REMOTE_CACHE_BYTES = 250 * 1024 * 1024;
export const DEFAULT_REMOTE_CACHE_ENTRIES = 36;
export const DEFAULT_REMOTE_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;

interface ReadableCacheRecord {
  entryId: string;
  sourceId: string;
  fingerprint: string;
  size: number;
  lastAccessed: number;
  image: CacheBackedImageEntry;
}

interface CacheAdmissionTicket {
  stageId: string;
  physicalKey: string;
  sourceId: string;
  entryId: string;
  fingerprint: string;
  sourceEpoch: string;
  catalogGeneration: string;
  fence: { globalSerial: number; sourceSerial: number; admissionSerial: number };
}

interface CacheProtection {
  reservationId: string;
  expiresAt: number;
}

interface AdmissionGate {
  sourceId: string;
  gateRevision: number;
  sourceEpoch?: string;
  catalogGeneration?: string;
}

interface PreparedImageBody {
  blob: Blob;
  size: number;
  contentType: string;
}

interface ImageByteStore {
  get(sourceId: string, entryId: string, fingerprint: string): Promise<Response | undefined>;
  lookupAndProtect(sourceId: string, entryId: string, fingerprint: string, protection?: CacheProtection): Promise<{ state: 'hit'; image: CacheBackedImageEntry } | { state: 'miss' }>;
  listReadable(sourceId: string, fingerprint: string): Promise<ReadableCacheRecord[]>;
  beginAdmission(sourceId: string, entryId: string, fingerprint: string, sourceEpoch: string, catalogGeneration: string): Promise<CacheAdmissionTicket | undefined>;
  reserveAdmission(ticket: CacheAdmissionTicket, size: number): Promise<'reserved' | 'pressure' | 'stale'>;
  admit(prepared: PreparedImageBody, context: { ticket: CacheAdmissionTicket; descriptor: CacheBackedImageEntry; priority: 'selected' | 'lookahead'; protection?: CacheProtection }): Promise<{ cached: true; image: CacheBackedImageEntry } | { cached: false; reason: 'pressure' | 'stale' }>;
  releaseProtection(reservationId: string): Promise<void>;
  abortAdmission(ticket: CacheAdmissionTicket): Promise<void>;
  getAdmissionGate(sourceId: string): Promise<AdmissionGate>;
  compareAndSetAdmissionGate(expected: AdmissionGate, next: { sourceEpoch: string; catalogGeneration?: string }): Promise<{ state: 'updated'; gate: AdmissionGate } | { state: 'stale'; gate: AdmissionGate }>;
  remapLogicalId(sourceId: string, fingerprint: string, legacyEntryId: string, opaqueEntryId: string): Promise<'remapped' | 'missing' | 'conflict'>;
  advanceAdmissionFence(sourceId: string): Promise<void>;
  invalidateSource(sourceId: string): Promise<void>;
  clear(): Promise<void>;
}
```

- [ ] **Step 4: Verify RED**

Run: `npm test -- src/storage/remoteCache.test.ts src/storage/imageByteStore.test.ts`

Expected: current cache has no count budget, reads and deletion wait for the slow `put`, and `listSource` is not the safe non-blocking playback seam.

- [ ] **Step 5: Refactor ingestion into prepare and short commit phases**

Call `beginAdmission` before fetch/body streaming so its durable ticket spans the entire slow operation and binds `(sourceEpoch, catalogGeneration)`. Read the stream, validate content/size, canonicalize MIME, and construct the bounded Blob outside the mutation serial section. Before writing Cache Storage, `reserveAdmission(ticket, size)` atomically counts admitted physical keys plus all staged reservations against both hard budgets and selects logical victims; concurrent staged bodies therefore cannot collectively exceed 250 MiB/36 slots. Delete reserved victims outside the metadata lock, then write to the ticket's versioned physical staging key outside the lock. Finish with a short compare-and-swap commit: recheck the ticket fence/reservation and accepted generation gate, atomically point logical metadata at the staged physical key, and create selected protection in the same commit when requested. Delete superseded/stale physical keys outside the metadata lock; durable staging rows make cleanup restartable. Every fetch/validation/cancel/error path calls `abortAdmission`, and startup/operations expire orphan tickets. Never return `cached: true` while admitted + reserved staging exceeds either hard budget. Include replacement and many-failed-ticket tests, because old and staged physical versions both count until commit/cleanup.

For `get`/`listReadable`, snapshot metadata plus invalidation epoch under a short lock, perform `cache.match` outside it, and briefly recheck epoch/current metadata before returning. Enumeration does not update LRU; a successful materializing `get` does.

Upgrade `newpictab-remote-cache` metadata storage to include durable `cacheState` mutation fences, a revisioned accepted `(sourceEpoch, catalogGeneration)` admission gate per source, versioned staging rows, logical-to-physical metadata pointers, and `protections`. Eviction ignores only unexpired selected/reservation protections; lookahead is soft. `lookupAndProtect` adds selected/fallback protection in the same short commit that revalidates the hit, and selected `admit` publishes bytes plus protection atomically, before lookahead can evict them. Protection is released on settle/abandon/close or two-minute expiry. Config bind and generation activation compare-and-set the admission gate with the previously read `gateRevision` before the playback-state pointer CAS; a delayed old activation cannot roll a newer gate backward. This rejects old selected/lookahead tickets opened before or after shadow completion, while existing readable bytes remain reusable. If the worker crashes between gate change and pointer CAS, Task 8 recovery activation completes it. `remapLogicalId` atomically changes only metadata lookup identity and retains the existing hashed physical key for Task 16 migration. Add stale-setter, remap-collision, old-generation staged-work, displayed-Blob, and abandoned-session protection tests.

Preserve the existing `RemoteCache.put/get/listSource/deleteSource/clear` signatures as a compatibility facade for settings preview/diagnostics; implement the new `ImageByteStore` adapter beneath/alongside them and run `npm run typecheck` before commit.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- src/storage/remoteCache.test.ts src/storage/imageByteStore.test.ts`

Run: `npm run typecheck`

Run: `git add src/storage/remoteCache.ts src/storage/remoteCache.test.ts src/storage/imageByteStore.ts src/storage/imageByteStore.test.ts && git commit -m "feat: bound and unblock remote image cache"`

---

### Task 7: Extract secure selected-image preparation and typed transport classification

**Files:**
- Create: `src/background/imagePreparer.ts`
- Create: `src/background/imagePreparer.test.ts`
- Modify: `src/background/index.ts`
- Modify: `src/sources/http.ts`
- Modify: `src/sources/http.test.ts`

**Interfaces:**
- Consumes a worker-memory source config, private catalog entry, source epoch, and Task 6 byte store.
- Produces either a safe cache-backed runtime descriptor or a typed preparation outcome; it never advances playback state.

- [ ] **Step 1: Add failing cache-first and security tests**

Cover a cache hit with the fetcher set to throw, authenticated WebDAV fetch, authorized JSON/TMDB/Direct fetch, redirect rejection, MIME/size policy, and a descriptor containing no URL or cache key. Assert a hit remains `ready` while offline. Assert config credentials occur only in the outbound request and not in returned errors, diagnostics, persisted metadata, or logged arguments.

- [ ] **Step 2: Add failing classification tests**

Map DNS/connection/deadline failures to `transport-unavailable`; map source-switch abort, explicit cancellation, redirect, HTTP 401/403, 404, 429, 5xx, parse/policy errors, and storage pressure to their distinct non-connectivity outcomes. Runtime callback timeout belongs to Task 12 and never reaches this preparer. The public `SourceError` remains sanitized.

```ts
type ImagePreparationResult =
  | { state: 'ready'; image: CacheBackedImageEntry; cache: 'hit' | 'admitted' }
  | { state: 'cache-miss' }
  | { state: 'transport-unavailable'; failure: 'dns' | 'connection' | 'deadline'; retryAfterMs: number }
  | { state: 'retry'; error: SourceError; retryAfterMs: number }
  | { state: 'failed-current-round'; error: SourceError }
  | { state: 'cache-pressure'; retryAfterMs: number }
  | { state: 'stale' };

interface RemoteImagePreparer {
  prepare(input: { config: RemoteSourceConfig; fingerprint: string; sourceEpoch: string; catalogGeneration: string; entry: RemoteCatalogImageEntry; priority: 'selected' | 'lookahead'; network: 'allowed' | 'cache-only'; protection?: CacheProtection; signal?: AbortSignal }): Promise<ImagePreparationResult>;
  cancel(sourceId?: string): void;
}
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/imagePreparer.test.ts src/sources/http.test.ts`

Expected: preparation is embedded in the legacy dispatcher and flattened public network errors cannot support the required circuit decisions.

- [ ] **Step 4: Implement the preparer and migrate reusable policy**

Check `ImageByteStore.lookupAndProtect` before any fetch; a selected hit carries its reservation protection, while lookahead has none. With `network: 'cache-only'`, return `cache-miss` without discovery or fetch. On an allowed miss, obtain `beginAdmission` before starting fetch/body consumption, reuse the existing authorization/remote URL/content helpers from `background/index.ts`, and pass selected protection into the atomic admission. Attach an explicit cancellation cause before aborting so a source switch is not classified as a transport failure. Return only `CacheBackedImageEntry`. Leave legacy `source:list` calling the same preparer/cache policy for settings diagnostics until playback migration completes.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/imagePreparer.test.ts src/sources/http.test.ts src/background/index.test.ts`

Run: `git add src/background/imagePreparer.ts src/background/imagePreparer.test.ts src/background/index.ts src/sources/http.ts src/sources/http.test.ts && git commit -m "refactor: isolate remote image preparation"`

---

### Task 8: Implement sessions, source epochs, and sequential complete rounds

**Files:**
- Create: `src/background/remotePlaybackPool.ts`
- Create: `src/background/remotePlaybackPool.test.ts`

**Interfaces:**
- Consumes Tasks 1-7 repositories/discovery/preparer with injected clock, RNG, and ID factory.
- Produces the approved `RemotePlaybackPool` API without yet enabling fallback selection.

- [ ] **Step 1: Add failing session and epoch tests**

Assert:

- `openSession` validates the remote config, computes the exact fingerprint, and binds an opaque token to `(sessionId, sourceId, fingerprint, sourceEpoch)`;
- same session/config revision reuses the epoch, newer A -> B -> A creates new epochs, and a stale older tab cannot roll the authoritative binding backward;
- a newly constructed pool with the same repositories returns `reopen-required` for an old in-memory token, then rebinds the same durable session/request after `openSession`;
- delayed prepare/settle/hint/close from an old token is harmless;
- no complete catalog advances exactly one bounded discovery slice, returns `waiting/catalog-discovery`, and never reserves a partial entry; repeated prepare/open across reconstructed pools resumes the checkpoint until a ready generation is activated;
- a crash after ready publication but before pointer activation followed by an offline reopen performs the local CAS activation without calling discovery/network.
- a worker restart loses an active memory-only JSON/signed generation: open/prepare detects `getGeneration` is missing, atomically retires the dangling pointer/jobs without issuing new claims, preserves already returned reservations only for idempotent settle, rediscovers online, and while offline performs no network and returns a bounded wait until Task 10 adds cache fallback.

- [ ] **Step 2: Add failing sequential round tests**

With a complete 3-entry catalog and a fake preparer, repeat `prepare` -> `settle(displayed)` and assert IDs 0, 1, 2 occur before 0. Make entry 2 pending and assert the next claim returns `waiting/round-barrier`, not entry 0. Assert a retryable preparation keeps the same reservation/position and returns bounded `waiting/candidate-retry`; a deterministic unsupported/oversized preparation conclusively fails that position and continues the same logical navigation. Assert `decode-failed` counts as conclusively failed for this round, lets the same request ID obtain the next candidate, and becomes eligible next round; `abandoned` and lease expiry return the original position to the same round.

Add history tests: preparing `{ kind: 'history', imageId }` validates the ID in the immutable generation, prepares/protects it, and settles in a history namespace without changing primary high-water, retry, settled, seed, or round state. An unknown/stale ID returns a safe error.

Add idempotent settlement/rebind tests: lose the settle callback, reconstruct the pool, reopen the same durable session, and replay `(requestId, reservationId, outcome)`. The new token may settle the durable reservation, repeated settle returns the same result, a displayed request cannot prepare again, and reuse of the ID with another intent is rejected.

```ts
const first = await pool.prepare(advance(sessionToken, 'request-1', 'sequential'));
const retried = await pool.prepare(advance(sessionToken, 'request-1', 'sequential'));
expect(retried).toEqual(first);
await pool.settle(settle(first, 'displayed'));
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/remotePlaybackPool.test.ts`

Expected: module resolution fails.

- [ ] **Step 4: Implement the three-phase reservation algorithm**

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

interface PlaybackWorkScheduler {
  schedule(nextWakeAt: number): Promise<void>;
  recalculate(states: readonly PlaybackSourceState[]): Promise<void>;
  cancel(): Promise<void>;
}
```

Before claiming, resolve the canonical Task 2 active pointer and verify `getGeneration` can still read it. If a memory-only generation vanished across worker restart, atomically clear the canonical pointer and its pending lookahead/new-claim state; keep already-ready reservation tombstones solely so a page can replay settle, and move other requests to rediscovery. Always activate an exact-epoch `getLatestReady` generation even if the page is now offline: read Task 6's admission gate, compare-and-set that exact `gateRevision` to the new `(sourceEpoch, generation)`, then compare-and-swap `activeCatalogGeneration` plus blocker/round cleanup in one playback-state transaction. A stale gate setter reloads/reconciles and can never roll a newer binding/generation backward. This enables cached primary successors and prevents old-generation admissions. If no ready generation exists and networking is allowed, call Task 5 `ensureComplete` for one bounded slice with the same pending request; pending schedules a durable retry and returns `waiting/catalog-discovery`. If a crash occurs between gate change and pointer activation, the next open/prepare performs the same idempotent activation, including an offline reopen. In this task, offline/circuit-open with no ready generation skips `ensureComplete` and returns bounded waiting; Task 10 replaces that branch with exact-fingerprint fallback.

For an active generation, `prepare` then: (1) in a short state transaction clean expired leases, validate the request's immutable intent/attempt, return an idempotent existing claim, prefer sorted retry positions, otherwise atomically increment the high-water position and create a two-minute reservation; (2) outside the transaction read only selected + two successor ordinals and prepare selected bytes with reservation protection; (3) in another short transaction validate token/epoch/generation/reservation and mark it ready, retrying, failed, or stale, releasing protection on every stale path. Do not hold a transaction across any promise from discovery, catalog reads, cache, protection, or network.

For settle, validate the unguessable reservation's durable session-key binding (the live token may have been rebound after worker restart), record an idempotent settlement tombstone, and release byte protection. `displayed` and `decode-failed` increment settled; only decode failure increments failed. `abandoned` returns the position without settling. A settled failed attempt moves the durable request to `next-attempt` so the same logical request ID can claim its next candidate without losing retry idempotency. Open a new round only when high-water and settled counts equal total, with no reservation, retry, source-level blocker, or retry delay. Close/expiry also releases protection best-effort.

`refresh(config)` first advances Task 6's admission fence, creates `refresh.status = 'pending'`, and runs one bounded shadow slice while the old canonical generation continues serving. Every later open/prepare/connectivity wake opportunistically advances one more slice; pending shadow work is also registered with the durable scheduler wired in Task 11. Success switches the canonical pointer and clears old blocker/fallback/round initialization in the same playback-state transaction. Failure keeps the pointer and sets a safe persisted `refresh.status = 'stale'` warning returned by later prepare calls.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/remotePlaybackPool.test.ts src/storage/playbackStateRepository.test.ts`

Run: `git add src/background/remotePlaybackPool.ts src/background/remotePlaybackPool.test.ts && git commit -m "feat: reserve complete sequential playback rounds"`

---

### Task 9: Add cross-tab shuffle rounds, idempotency, barriers, and lookahead

**Files:**
- Modify: `src/background/remotePlaybackPool.ts`
- Modify: `src/background/remotePlaybackPool.test.ts`
- Modify: `src/domain/playbackRound.test.ts`

**Interfaces:**
- Extends Task 8 primary playback; no cache-fallback state is touched in this task.

- [ ] **Step 1: Add failing interleaving/property tests**

For generated catalog sizes 1 through 64 and deterministic interleavings of two sessions, assert each round's outcomes cover every ordinal exactly once before any new-round display. Add explicit cases where ordinal 0 preparation is slow while ordinal 1 becomes ready, a callback retries the same request after a pool reconstruction, and the final reservation stays open at the barrier.

- [ ] **Step 2: Add failing shuffle and lookahead tests**

Assert each shuffle round is a full permutation, reconstruction preserves seed/position, concurrent sessions never reserve the same ordinal, and a new round avoids the prior last displayed ID at its first position when total > 1. For both orders, assert the selected entry plus the next two logical same-round successors become de-duplicated durable lookahead jobs, but only the selected position changes reservation/cursor state. A selected hit/admission is atomically protected before any lookahead admission can evict it. A lookahead failure or worker suspension must not block ready selected output or change its future position; pool reconstruction plus a no-claim `hintConnectivity`/scheduler wake resumes pending warm jobs even after a successful `changeOn: 'new-tab'` display leaves no navigation pending.

```ts
expect(preparer.calls[0]).toMatchObject({ entry: { id: 'selected-id' }, priority: 'selected' });
expect(Object.values(stateAfter.lookaheadJobs).map(({ ordinal }) => ordinal).sort()).toEqual([
  successor1Ordinal,
  successor2Ordinal
]);
expect(roundAfter.highWaterPosition).toBe(roundBefore.highWaterPosition + 1);
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/remotePlaybackPool.test.ts src/domain/playbackRound.test.ts`

Expected: sequential-only pool has no shuffle seed restoration, concurrent claim coverage, or lookahead.

- [ ] **Step 4: Implement atomic unique claims and best-effort lookahead**

Use the deterministic plan from Task 1. Increment high-water inside the same transaction that creates a unique reservation so a slow fetch cannot duplicate the position. Resolve the selected ordinal and two same-round successors, persist de-duplicated warm jobs, then await selected cache hit/admission plus its atomic protection. Only after protection succeeds may the scheduler drain at most two lookahead jobs concurrently. Lookahead is soft and fenced by source epoch/catalog generation/admission fence; ready returns without waiting for downloads. Pending jobs survive MV3 suspension and are resumed by later open/prepare or Task 11's durable wake, so pre-caching is reliable without delaying an already prepared selected image. If all entries fail, set a bounded `nextRoundNotBefore` instead of immediately opening another all-failed round.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/remotePlaybackPool.test.ts src/domain/playbackRound.test.ts`

Run: `git add src/background/remotePlaybackPool.ts src/background/remotePlaybackPool.test.ts src/domain/playbackRound.test.ts && git commit -m "feat: add shared shuffle rounds and lookahead"`

---

### Task 10: Add exact-source offline cache fallback and recovery

**Files:**
- Modify: `src/background/remotePlaybackPool.ts`
- Modify: `src/background/remotePlaybackPool.test.ts`
- Modify: `src/storage/playbackStateRepository.test.ts`

**Interfaces:**
- Consumes Task 6 `listReadable` and Task 7 typed transport results.
- Produces the separate session-local `selection: 'cache-fallback'` path without mutating primary rounds.

- [ ] **Step 1: Add failing sequential and shuffle fallback tests**

For an exact source/fingerprint cache snapshot, prove sequential attempts each readable ID once in stable active-catalog order before repeat, and shuffle returns one full seeded permutation. A newly cached ID joins only the next fallback round; an evicted ID is safely skipped on materialization. After creating a fallback reservation, `lookupAndProtect` must protect that readable record before returning ready, even while another source admission evicts LRU entries. A new round avoids an immediate boundary repeat. Start after the currently displayed ID, and reuse a sole cached current image without a transition loop.

- [ ] **Step 2: Add failing primary-isolation tests**

Assert fallback settlement/expiry/decode failure never changes primary high-water, settled count, retry queue, seed, or round. A cached next primary candidate remains a normal `selection: 'catalog'` hit while offline. At the first uncached primary candidate, return it unchanged to a connectivity blocker before selecting fallback; repeated fallback advances create no additional primary claims. Start two cross-tab/order fetches before the circuit opens and fail both: the first failure wins the source-blocker CAS, the second returns its own position to its round retry queue and also enters fallback-pending without overwriting the blocker. A late success from another in-flight request may display normally but cannot clear that blocker.

- [ ] **Step 3: Add failing restart, recovery, empty, and classification tests**

Cover:

- pool reconstruction + session reopen preserves fallback permutation and same request reservation;
- after a worker restart loses a memory-only active generation, offline prepare uses only exact-fingerprint readable cache fallback and does not leave the canonical pointer dangling or call discovery/network;
- two fallback advances separated by the maximum configured 24-hour interval, including an MV3 restart, continue the same snapshot round; only reservation leases use a fixed two-minute expiry, while snapshot/cursor cleanup uses the 25-hour sliding idle expiry or explicit close;
- records from another source/fingerprint never appear;
- no active catalog may use only exact-fingerprint readable cache and labels the result as fallback, never full count;
- history of a prior fallback occurrence may prepare only that exact readable cache ID and cannot move either the fallback cursor or primary cursor;
- empty or all-decode-failed cache preserves current/bundled image and returns bounded `waiting/cache-fallback-empty` without a tight loop;
- `online` hint schedules a probe but does not switch the current image;
- successful retry clears the circuit and the next normal advance prioritizes the unresolved primary candidate;
- HTTP/auth/rate-limit/policy/decode/storage pressure/cancellation never activate fallback;
- stalled WebDAV discovery or image fetch does not delay `listReadable` fallback;
- while the browser hint is offline or the source circuit is open, discovery and fetch call counts remain exactly zero, including across another tab/order.

- [ ] **Step 4: Verify RED**

Run: `npm test -- src/background/remotePlaybackPool.test.ts src/storage/playbackStateRepository.test.ts`

Expected: the primary-only pool returns waiting/errors and has no isolated fallback round.

- [ ] **Step 5: Implement fallback snapshots and the connectivity circuit**

Key fallback state by `JSON.stringify([sessionId, sourceId, fingerprint, sourceEpoch])`, cap it at the 36 readable IDs, and renew its sliding idle expiry on every live request; only individual reservations have the fixed two-minute lease. When `onlineHint === false` or the source-level typed transport circuit is open, invoke Task 7 with `network: 'cache-only'` for the next primary candidate. A hit remains catalog selection; a miss atomically returns that primary position to the source-level blocker and changes the durable request phase to `fallback-pending`, then queries `listReadable` independently of discovery/download promises. A crash/retry in that phase can create only the fallback reservation, never resurrect a simultaneous primary result. Intersect with the active generation when present; otherwise sort opaque IDs. Create a fallback reservation from its `ReadableCacheRecord`, then call `ImageByteStore.lookupAndProtect` directly with that reservation—no catalog locator or network preparer is required. If it races with eviction and misses, conclusively skip only that fallback position and use the same request's next attempt. Create fallback request mappings in the session namespace only.

On a transport failure, compare-and-set the source-level blocker only when absent. The winner owns the exact unresolved round/position; every later in-flight failure returns its position to that round's sorted retry queue and cannot overwrite the blocker. Only a successful explicit probe of the blocker operation may clear it—unrelated late successes do not. Recovery performs no page-facing prepare or visual switch; the next advance takes the blocker position first, then other retry positions. Invalidate fallback snapshots/blockers on an atomic catalog-generation swap; allow an already returned old-generation reservation to settle only in its retired namespace. Delete a retired immutable generation only after all of its reservations settle/expire and no durable request mapping refers to it.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- src/background/remotePlaybackPool.test.ts src/storage/playbackStateRepository.test.ts src/storage/imageByteStore.test.ts`

Run: `git add src/background/remotePlaybackPool.ts src/background/remotePlaybackPool.test.ts src/storage/playbackStateRepository.test.ts && git commit -m "feat: play exact-source cache while offline"`

---

### Task 11: Route playback through the MV3 worker and fence maintenance races

**Files:**
- Create: `src/background/playbackRecoveryScheduler.ts`
- Create: `src/background/playbackRecoveryScheduler.test.ts`
- Modify: `src/background/messages.ts`
- Modify: `src/background/index.ts`
- Modify: `src/background/index.test.ts`
- Modify: `src/storage/maintenance.ts`
- Modify: `src/storage/maintenance.test.ts`
- Modify: `src/newtab/dataClear.test.ts`
- Modify: `src/newtab/dataClear.ts`
- Modify: `public/manifest.json`
- Modify: `src/test/manifest.test.ts`
- Modify: `src/test/setup.ts`

**Interfaces:**
- Consumes the shared Task 1 contract and constructs one production Task 10 pool.
- Keeps `source:list` solely for settings preview/diagnostics and routes every `playback:*` request outside `runForSource`.

- [ ] **Step 1: Add failing routing and sender-policy tests**

For each of the five playback requests, assert an authorized extension sender reaches the matching pool method exactly once and receives its typed result. Assert invalid envelopes and non-extension senders never call the pool. Assert playback responses pass the existing safe-clone/redaction boundary and contain no config, URL, header, cache key, raw failure, username, password, user Direct ID, or token other than the opaque session/reservation fields defined by the wire contract.

- [ ] **Step 2: Add failing non-blocking and maintenance tests**

Start a never-resolving legacy WebDAV `source:list`/discovery operation, then assert a playback cache-fallback prepare completes independently. Start staged discovery and staged cache admission, then run each operation below and assert its invalidation fence is advanced before cleanup and late work cannot repopulate state:

- `source:delete` removes source catalog, playback state, byte records, and adapter instance;
- `source:clear-source-cache` removes exact-source bytes while catalog remains usable online;
- `source:clear-cache` clears bytes globally without fabricating primary catalog state;
- `system:clear-all-data` clears catalog, playback state, cache, settings/local data through best-effort fan-out;
- `source:refresh` creates shadow discovery and preserves old active playback until success.

Add a partial-cleanup failure test proving all backends are attempted and the response names safe failed subsystem labels only.

Add scheduler tests: the earliest durable `nextProbeAt`/discovery/lookahead retry creates one fixed-name `chrome.alarms` wake without source/config data; the alarm broadcasts only `{ playbackEvent: 'retry-due' }` to extension pages; pool reconstruction reads Task 2 state and re-arms it; delete/clear cancels or recalculates it. This wake asks a live page to reopen with its in-memory config, so credentials never enter alarm names or durable scheduler records. If no extension page receives the event, cancel the immediate alarm/back off globally instead of repeatedly firing an overdue job; the next `openSession` re-arms due state. Extend the shared Chrome test mock with injected `alarms.create/clear/onAlarm` behavior and a no-receiver `runtime.lastError` case rather than using real time.

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/background/index.test.ts src/background/playbackRecoveryScheduler.test.ts src/storage/maintenance.test.ts src/newtab/dataClear.test.ts src/test/manifest.test.ts`

Expected: playback messages are unsupported and the current whole-source queue/epoch cannot fence every source/delete/clear race.

- [ ] **Step 4: Wire the pool with short orchestration boundaries**

Extend `BackgroundRequest`/`BackgroundResponse` by importing, not redeclaring, Task 1 unions. Construct catalog/state/byte/discovery/preparer/pool dependencies once in the worker. Route playback before legacy source routing and do not call `runForSource`. Add the `alarms` permission and a fixed-name recovery scheduler; on wake, broadcast the safe retry-due event so a live PlaybackClient reopens/probes with its page-held config. For delete/clear, call pool/source invalidation first, then perform independent cleanup promises and recalculate the alarm. For refresh, call `pool.refresh(config)`; keep the legacy preview refresh behavior only where settings needs it.

Do not delete `source:list` yet. Mark its call sites as preview/diagnostic only and ensure no new-tab playback request depends on offsets/windows.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/background/index.test.ts src/background/playbackRecoveryScheduler.test.ts src/storage/maintenance.test.ts src/newtab/dataClear.test.ts src/test/manifest.test.ts`

Run: `git add src/background/playbackRecoveryScheduler.ts src/background/playbackRecoveryScheduler.test.ts src/background/messages.ts src/background/index.ts src/background/index.test.ts src/storage/maintenance.ts src/storage/maintenance.test.ts src/newtab/dataClear.ts src/newtab/dataClear.test.ts public/manifest.json src/test/manifest.test.ts src/test/setup.ts && git commit -m "feat: expose background playback sessions"`

---

### Task 12: Add the new-tab PlaybackClient and enforce three remote object URLs

**Files:**
- Create: `src/newtab/playbackClient.ts`
- Create: `src/newtab/playbackClient.test.ts`
- Modify: `src/newtab/sourceClient.ts`
- Modify: `src/newtab/sourceClient.test.ts`

**Interfaces:**
- Consumes the Task 1 runtime contract and existing `RemoteCacheSession` materialization.
- Produces a page-level candidate that owns exactly one materialized lease and knows how to settle/release it, backed by one tab-global three-URL lease manager shared across source/client generations.

- [ ] **Step 1: Add failing open/reopen/idempotency tests**

Assert `open` sends config/sessionId/current online hint; `prepare` sends the live token and one logical request ID; `reopen-required` performs one reopen and one retry with the same request ID; a second reopen-required surfaces a bounded waiting/error instead of looping. Assert settle carries the exact token, request, reservation, and outcome. If the worker restarts between decode and settle, a `stale-session` settle response reopens once and replays the same `(requestId, reservationId, outcome)`; a second result returns the durable idempotent settlement. A page-side runtime callback timeout retries the same request and never locally activates fallback. With no pending navigation, a retry-due event must reopen if needed and send a no-visual connectivity hint that pumps due lookahead/shadow/recovery work.

- [ ] **Step 2: Add failing cancellation and URL ownership tests**

Assert a delayed ready response after abort/source switch is settled `abandoned` and never materialized. Assert a cache eviction race during materialization settles `abandoned`. Assert successful materialization owns a Blob before `displayed` settlement releases background cache protection, so later Cache Storage eviction cannot blank current/previous. Two old/new PlaybackClients share one manager: with current and previous leases retained, allow one decoding lease and reject/defer a fourth URL across both clients. Closing/disposing the old worker session must not revoke a displayed lease transferred to the hook; releasing old previous permits the next materialization. Only tab unmount disposes the shared manager and revokes every remaining URL.

```ts
interface PreparedPlaybackCandidate {
  image: BackgroundImage;
  selection: 'catalog' | 'cache-fallback';
  catalogTotalCount?: number;
  fallbackCount?: number;
  fallbackReason?: 'offline-hint' | 'transport-failure';
  warnings?: SourceError[];
  settle(outcome: 'displayed' | 'decode-failed' | 'abandoned'): Promise<boolean>;
  release(): void;
}

interface PlaybackNavigationSession {
  prepare(requestId: string, intent: PlaybackIntent, signal?: AbortSignal): Promise<{ state: 'ready'; candidate: PreparedPlaybackCandidate } | Extract<PlaybackPrepareResult, { state: 'waiting' }> | { state: 'error'; error: SourceError }>;
  hintConnectivity?(online: boolean): Promise<void>;
  subscribeRetryDue(listener: () => void): () => void;
  dispose(): void;
}

interface PlaybackLeaseManager {
  readonly maxOwnedUrls: 3;
  materializeCache(entry: CacheBackedImageEntry): Promise<PlaybackImageLease | undefined>;
  materializeBlob(image: Omit<BackgroundImage, 'url'>, blob: Blob): Promise<PlaybackImageLease | undefined>;
  release(lease: PlaybackImageLease): void;
  dispose(): void;
}
```

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/newtab/playbackClient.test.ts src/newtab/sourceClient.test.ts`

Expected: no playback client, shared three-lease manager, or object-URL-free preview materializer exists.

- [ ] **Step 4: Implement one-candidate materialization**

Construct one tab-level `PlaybackLeaseManager` with `maxOwnedUrls: 3` and inject it into every PlaybackClient generation. Convert the settings preview's at-most-six bounded thumbnails to data URLs (revoking any temporary URL immediately) so preview never consumes the playback object-URL budget. Keep page config/sessionId/online hint only in memory for worker reopen. Materialize only the one ready descriptor, transfer its lease to the returned candidate, retain its reservation binding in a closure, and make settle/release idempotent. Client `dispose()` invalidates pending work and best-effort closes only its worker session; it does not revoke leases already transferred to hook display state.

Listen for Task 11's safe retry-due event even when no navigation is pending. First transparently reopen if necessary and send `connectivity-hint` with the current in-memory online hint; the pool uses this no-visual call to probe a due blocker or pump one shadow-discovery/lookahead slice without creating a playback claim. Then notify `subscribeRetryDue` listeners so a pending hook request may retry immediately. Local/bundled sessions implement a no-op subscription. Remove `refreshSource`'s forced first playback window load; refresh only sends `source:refresh`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/newtab/playbackClient.test.ts src/newtab/sourceClient.test.ts`

Run: `git add src/newtab/playbackClient.ts src/newtab/playbackClient.test.ts src/newtab/sourceClient.ts src/newtab/sourceClient.test.ts && git commit -m "feat: materialize bounded playback candidates"`

---

### Task 13: Give local/bundled sources the same persistent round planner

**Files:**
- Create: `src/newtab/localPlaybackSession.ts`
- Create: `src/newtab/localPlaybackSession.test.ts`
- Modify: `src/storage/playbackStateRepository.ts`
- Modify: `src/storage/playbackStateRepository.test.ts`
- Modify: `src/storage/imageDb.ts`
- Modify: `src/storage/imageDb.test.ts`
- Modify: `src/sources/local.ts`
- Modify: `src/sources/local.test.ts`

**Interfaces:**
- Consumes complete local entry metadata, Task 1 round planning, and Task 2 atomic state transactions.
- Produces the same `PlaybackNavigationSession` page seam without applying remote cache budgets to user-owned blobs.

- [ ] **Step 1: Add failing local complete-round tests**

Use two session instances over one repository. Assert sequential and shuffle each settle all stable local IDs once before repeat, reconstruction continues the same seed/position, concurrent tabs reserve distinct positions, and local decode failure is eligible next round. A changed ordered ID fingerprint starts a new generation while a delayed old reservation cannot mutate it. A single bundled image uses the same session seam and does not transition repeatedly to itself.

- [ ] **Step 2: Add failing local resource-lifecycle tests**

Assert the local source's user-owned Blob records are never written to `RemoteCache` and are not subject to 36-entry eviction. Playback lists metadata without eagerly creating object URLs, fetches only the selected Blob by `(sourceId, imageId)`, and uses the tab-global lease manager. On source switch, closing the local session keeps transferred current/previous leases alive; the hook's later `release` revokes them. Delayed local reads cannot paint a deleted/changed generation.

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/newtab/localPlaybackSession.test.ts src/storage/playbackStateRepository.test.ts src/storage/imageDb.test.ts src/sources/local.test.ts`

Expected: the existing page shuffle bag and cursor do not persist a complete shuffle round or reservations.

- [ ] **Step 4: Implement the local coordinator**

Add `listLocalMetadata(sourceId)` and `getLocal(sourceId, imageId)` to `imageDb` so playback does not read/create URLs for every Blob. Keep `LocalSourceAdapter.listImages` as the settings-preview compatibility path, but make App playback use the lazy APIs. Fingerprint the ordered stable ID list, store a local pseudo-generation and round state under an isolated `local` namespace in `PlaybackStateRepository`, and reuse `createPlaybackRoundPlan`. Local preparation reads only the selected Blob and materializes it through the shared `PlaybackLeaseManager`; the returned candidate owns a real ref-counted/revocable lease. Session dispose closes future work but never revokes a lease transferred to current/previous. Settle semantics match the primary catalog path. Add a one-entry in-memory bundled session using the same interface.

Keep the repository generic enough that background and new-tab contexts can open the same IndexedDB safely; do not add asynchronous work inside mutation callbacks.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/newtab/localPlaybackSession.test.ts src/storage/playbackStateRepository.test.ts src/storage/imageDb.test.ts src/sources/local.test.ts`

Run: `npm test -- src/background/remotePlaybackPool.test.ts`

Run: `git add src/newtab/localPlaybackSession.ts src/newtab/localPlaybackSession.test.ts src/storage/playbackStateRepository.ts src/storage/playbackStateRepository.test.ts src/storage/imageDb.ts src/storage/imageDb.test.ts src/sources/local.ts src/sources/local.test.ts && git commit -m "feat: persist complete local playback rounds"`

---

### Task 14: Refactor the rotation hook to consume prepared candidates

**Files:**
- Modify: `src/newtab/hooks/useBackgroundRotation.ts`
- Modify: `src/newtab/hooks/useBackgroundRotation.test.ts`
- Create: `src/newtab/hooks/useBackgroundRotation.playback.test.ts`

**Interfaces:**
- Consumes `PlaybackNavigationSession` from Tasks 12/13.
- Retains decode, timer, keyboard, current/previous transition state, and bounded occurrence history; owns no remote window/cursor/shuffle state.

- [ ] **Step 1: Add failing waiting/decode/settle tests**

Assert waiting retries the same request ID after `retryAfterMs` and keeps current visible. Decode failure calls `decode-failed`, releases its URL, and asks for the next candidate with the same logical request ID. Only a successfully decoded and successfully settled `displayed` candidate rotates current/previous and restarts the interval. Fallback and catalog candidates use the identical decode/settle path.

Keep a first-use discovery navigation alive across more than one `operationBudgetMs` and multiple WebDAV slices: each individual runtime/decode attempt is bounded, but `waiting/catalog-discovery` schedules the next retry until success, source switch, unmount, or a newer manual navigation supersedes it. A Task 11 recovery wake retries the pending request immediately with the same ID. With an old active catalog and pending shadow refresh, normal successful interval navigation continues while each call also advances shadow work.

- [ ] **Step 2: Add failing lease/history/cancellation tests**

Assert:

- at all times only current, transition previous, and decoding candidate leases are retained;
- publishing a new candidate releases the older previous before rotating ownership;
- ArrowLeft prepares `{ kind: 'history', imageId }` from bounded tab-local occurrence history and never sends advance;
- after previous, next first walks forward tab-local history, then sends a new advance;
- a repeated sole-current fallback candidate settles but causes no visual transition and releases the duplicate lease;
- source reset abandons decoding and clears history but retains current until the new source displays;
- unmount abandons pending work and releases current/previous/decoding leases;
- keyboard coalescing and interval waiting never create overlapping logical requests.

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/newtab/hooks/useBackgroundRotation.test.ts src/newtab/hooks/useBackgroundRotation.playback.test.ts`

Expected: the hook still owns `entries`, `ShuffleBag`, remote cursor windows, `incrementalEntries`, and `onEntriesExhausted`.

- [ ] **Step 4: Implement the provider-driven operation loop**

Replace selection options with:

```ts
interface UseBackgroundRotationOptions {
  playback: PlaybackNavigationSession;
  order: RotationOrder;
  changeOn: AppearanceSettings['changeOn'];
  intervalMinutes: number;
  generation: string | number;
  sourceResetKey: string | number;
  decodeImage?: (image: BackgroundImage, signal?: AbortSignal) => Promise<void>;
  decodeTimeoutMs?: number;
  operationBudgetMs?: number;
}
```

Generate a request ID once at the start of a logical operation. Apply `operationBudgetMs` to one runtime/decode attempt, not the total lifetime of a catalog-discovery wait. Loop on bounded waiting/decode-failed outcomes with abort-aware retry timers and the same ID; subscribe to the recovery-wake event to accelerate the current wait. Maintain at most 72 occurrence-history IDs, never old object URLs. Delete `incrementalEntries`, `onEntriesExhausted`, hook-owned remote shuffle bags/cursors, and their obsolete tests only after the new provider tests pass. Preserve the current dirty tests' transient-failure intent under the new seam.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/newtab/hooks/useBackgroundRotation.test.ts src/newtab/hooks/useBackgroundRotation.playback.test.ts src/newtab/localPlaybackSession.test.ts src/newtab/playbackClient.test.ts`

Before staging, run `git diff -- src/newtab/hooks/useBackgroundRotation.ts src/newtab/hooks/useBackgroundRotation.test.ts` and explicitly verify that the pre-existing transient-failure/exhaustion edits are represented by equivalent provider tests rather than silently overwritten. These files were dirty before this plan; stage only after that comparison.

Run: `git add src/newtab/hooks/useBackgroundRotation.ts src/newtab/hooks/useBackgroundRotation.test.ts src/newtab/hooks/useBackgroundRotation.playback.test.ts && git commit -m "refactor: drive rotation from playback sessions"`

---

### Task 15: Replace App's remote windows with one live playback session

**Files:**
- Modify: `src/newtab/App.tsx`
- Modify: `src/newtab/App.test.tsx`
- Modify: `src/newtab/components/SourceStatus.tsx`
- Modify: `src/newtab/components/SourceStatus.test.tsx`
- Modify: `src/newtab/i18n.tsx`
- Modify: `src/newtab/i18n.test.tsx`

**Interfaces:**
- Consumes remote/local/bundled playback sessions and the provider-driven hook.
- Removes all new-tab remote window ownership; settings preview continues using `source:list` independently.

- [ ] **Step 1: Replace old window tests with failing session-flow tests**

Add App tests for open -> prepare -> decode -> settle displayed, first-use discovery waiting preserving bundled/current, decode failure advancing without blanking, and a 25-entry sequence delivered entirely by pool responses with no playback `source:list` request. Add source switch tests where old delayed ready cannot publish, old session closes, and old current remains until the new source paints.

- [ ] **Step 2: Add failing offline/connectivity/count tests**

Assert an offline fallback candidate displays; its `fallbackCount` never writes `sourceCounts` or masquerades as total; transport fallback shows the safe stale diagnostic `图片源不可达，正在使用缓存图片`; an explicit browser-offline hint uses `离线，正在使用缓存图片`; an `online` event sends a hint only to the live session and does not force a visual change; the next navigation resumes the blocked primary candidate. Local sources must send no playback runtime messages.

Assert auth/permission/policy errors never enter fallback and keep current visible. A failed shadow refresh continues playing the old catalog and renders its persisted safe stale warning; a later successful refresh clears stale state and changes generation only on the next navigation, not immediately.

- [ ] **Step 3: Verify RED**

Run: `npm test -- src/newtab/App.test.tsx src/newtab/components/SourceStatus.test.tsx src/newtab/i18n.test.tsx`

Expected: App still loads/publishes 12-entry windows and cannot distinguish catalog total from fallback count.

- [ ] **Step 4: Implement session ownership and delete window machinery**

Generate one page `sessionId` and one tab-global `PlaybackLeaseManager`. Inject that same manager into every old/new remote, local, or bundled session so source transition cannot exceed three total URLs. For an active remote source, create/open `PlaybackClient(config, sessionId, navigator.onLine)` and forward `online`/`offline` events only while its generation is live. Closing the old session does not release its current lease; the hook releases that lease only after the new source paints. On App unmount, let the hook release display state before disposing the global manager. Feed exactly one live navigation session into the hook.

Delete `REMOTE_WINDOW_SIZE`, `MAX_REMOTE_WINDOWS`, `RemoteWindow`, `WindowLoadOwner`, `windowState`, `remoteWindows`, `retiredWindows`, protected-entry bookkeeping, `publishWindow`, `loadRemoteWindow`, near-end prefetch, `requestMoreRotationEntries`, cursor validation, and `onEntriesExhausted`. Keep source settings preview/test/refresh UI intact. Update counts only from catalog-ready `catalogTotalCount`; fallback only marks degraded/stale availability.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- src/newtab/App.test.tsx src/newtab/components/SourceStatus.test.tsx src/newtab/i18n.test.tsx src/newtab/hooks/useBackgroundRotation.playback.test.ts`

Before staging, run `git diff -- src/newtab/App.tsx src/newtab/App.test.tsx` and verify every pre-existing remote exhaustion/cache-only regression scenario was deliberately migrated or superseded by a named session/fallback test. Do not discard unrelated hunks.

Run: `git add src/newtab/App.tsx src/newtab/App.test.tsx src/newtab/components/SourceStatus.tsx src/newtab/components/SourceStatus.test.tsx src/newtab/i18n.tsx src/newtab/i18n.test.tsx && git commit -m "feat: use complete playback pool in new tab"`

---

### Task 16: Finish legacy migration, end-to-end coverage, and full verification

**Files:**
- Create: `src/background/legacyPlaybackMigration.ts`
- Create: `src/background/legacyPlaybackMigration.test.ts`
- Delete after migration ownership moves: `src/newtab/backgroundCursor.ts`
- Delete after migration ownership moves: `src/newtab/backgroundCursor.test.ts`
- Modify: `src/background/remotePlaybackPool.ts`
- Modify: `src/background/remotePlaybackPool.test.ts`
- Modify: `e2e/extension.spec.ts`

**Interfaces:**
- Consumes old cursor/cache/catalog records once and produces only v2 state.
- Produces browser-level proof that catalogs may exceed byte cache limits without shrinking the selection pool.

- [ ] **Step 1: Add failing legacy migration tests**

Seed the existing Chrome sequential cursor key. On the first matching complete generation, assert the new sequential round starts after that ID and removes the old key only after durable state commits. For shuffle, use the old last-displayed ID only as `avoidFirstOrdinal` and start a fresh seeded round. Assert a timed-out or 20,000-entry v1 WebDAV record never starts a primary round; only an exact ordered Direct v1 record may become generation zero. Existing exact-fingerprint cache metadata/bytes remain reusable without copy or download. For an unsafe/long legacy Direct ID, rewrite only its cache metadata logical ID to the new opaque candidate while retaining the same physical hashed byte key; assert the raw ID appears in neither catalog/state/runtime/new metadata nor logs.

- [ ] **Step 2: Implement one-time migration and remove dead cursor ownership**

Implement three idempotent migration phases in `legacyPlaybackMigration.ts`:

1. Read a v1 catalog only through `getLegacy`. Reject every non-Direct source. For Direct, validate the current authoritative config/fingerprint and require its ordered legacy IDs to equal the v1 ordered IDs exactly; then derive new opaque IDs/locators and publish fenced `legacy-direct-0` entries. A partial/invalid match never publishes.
2. Before publication, call Task 6 `remapLogicalId` for each exact-fingerprint legacy cache record so metadata uses the opaque ID while the physical hashed key/bytes remain unchanged. Treat `remapped` and already-remapped state idempotently; a conflict blocks promotion, and a missing cache record simply means that image will download later. Persist a migration phase marker so a worker restart resumes without copying bytes.
3. Read the legacy cursor through a narrow injected store, create the v2 round in one playback-state transaction, then delete the legacy key. Keep deletion retryable if the storage callback fails.

Move the exact legacy cursor key/parser into `legacyPlaybackMigration.ts`, verify no production import remains, and delete `backgroundCursor.ts` plus its obsolete implementation tests.

- [ ] **Step 3: Add the failing large-catalog E2E**

Adjust `installDirectRuntimeFixture()` so it intercepts only settings preview messages; `playback:*` must reach the real service worker. Route 40 unique Direct image URLs to a valid 1x1 PNG. Then assert:

- sequential's first 40 displayed stable IDs are the complete unique set before any repeat;
- shuffle's first 40 are another complete unique set;
- Cache Storage metadata/bytes remain at or below 36 entries, 250 MiB total, and 16 MiB each throughout;
- after caching a subset and going offline, next displays exact-source cached images without blanking;
- restoring online does not immediately switch the image, and the next navigation resumes the unresolved primary candidate;
- a second configured source's cached bytes are never selected.

- [ ] **Step 4: Verify focused migration and E2E GREEN**

Run: `npm test -- src/background/legacyPlaybackMigration.test.ts src/background/remotePlaybackPool.test.ts`

Run: `npm run build && npm run test:e2e -- e2e/extension.spec.ts`

Expected: migration tests and the large-catalog/offline browser flow pass. Confirm no old imports remain with `rg "backgroundCursor|RotationCursorStore|onEntriesExhausted|REMOTE_WINDOW_SIZE" src`.

- [ ] **Step 5: Run security and placeholder scans**

Run: `rg -n "TODO|FIXME|placeholder|Only the first (500|100)|onEntriesExhausted|REMOTE_WINDOW_SIZE" src e2e`

Expected: no new implementation placeholder, truncation warning, or old playback-window symbol remains. Existing unrelated TODO/FIXME lines, if any, must be inspected and documented rather than mechanically removed.

Run: `git diff --check HEAD`

- [ ] **Step 6: Run the complete verification matrix**

Run each command separately so a failure is attributable:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: TypeScript succeeds; every Vitest suite passes; Vite produces the extension; all Playwright specs pass.

- [ ] **Step 7: Review storage and worktree scope**

Inspect Cache Storage and IndexedDB names/versions in tests and verify no credential-bearing field was added. Run `git status --short` and confirm only files named by this plan plus the user's pre-existing unrelated changes are present. Do not stage the untracked prior plan or unrelated user edits accidentally.

- [ ] **Step 8: Commit final migration and E2E coverage**

Stage only the migration, intentional cursor deletion/modification, pool test additions, and E2E file, then run:

`git commit -m "test: verify complete bounded playback"`

---

## Completion Criteria

- Every sequential/shuffle primary round uses a proven-complete catalog and settles every ordinal before wrap; concurrent tabs receive unique reservations and restarts preserve progress.
- Selected plus two logical successors are prepared, but neither lookahead nor cache eviction changes the selection pool.
- Offline/transport-unreachable playback uses only readable exact-source cache records, keeps primary state unchanged, and resumes the blocked candidate only on a later navigation after recovery.
- WebDAV scanning resumes across slices/restarts and publishes only after queue exhaustion; legacy partial catalogs never become primary.
- Remote storage remains within 250 MiB, 36 entries, and 16 MiB per entry, and the new tab owns no more than three remote object URLs.
- App playback no longer sends `source:list` windows, while settings preview/diagnostics still work.
- Typecheck, all unit/integration tests, production build, and Playwright E2E all pass.

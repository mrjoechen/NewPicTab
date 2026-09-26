# WebDAV Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the newly accepted WebDAV image formats displayable, represent unknown cached catalog totals honestly, and bound WebDAV work inside the UI message deadlines.

**Architecture:** Put image MIME normalization and WebDAV timing budgets in small shared policy modules so discovery, caching, and UI deadlines cannot drift. Keep the existing window cursor fields, but omit `totalCount` when metadata is unknown and teach the new-tab consumer to preserve that unknown state. Add an overall WebDAV scan deadline that returns already discovered images with a warning instead of continuing after the caller has timed out.

**Tech Stack:** TypeScript 7, Vitest 4, React 19, Chrome extension runtime messaging, Cache Storage/IndexedDB.

**Spec:** User request and review findings from 2026-08-24; no separate external spec file.

## Global Constraints

- Preserve all existing staged and unstaged user changes; do not commit, reset, or rewrite unrelated work.
- Follow strict TDD: each behavior test must be observed failing for the expected reason before production code changes.
- Do not add dependencies.
- Keep protected WebDAV URLs and credentials out of runtime responses, cache keys, logs, and DOM state.
- `totalCount`, when present, remains the exact full metadata count defined by `src/sources/adapter.ts`.
- The WebDAV overall scan deadline must be lower than the live-list callback deadline, and the ordinary callback deadline must exceed one WebDAV request deadline.

---

### Task 1: Align WebDAV discovery and remote-cache image policy

**Files:**
- Create: `src/sources/remoteImagePolicy.ts`
- Modify: `src/sources/webdav.ts`
- Modify: `src/storage/remoteCache.ts`
- Test: `src/storage/remoteCache.test.ts`
- Test: `src/background/index.test.ts`

**Interfaces:**
- Produces: shared helpers that recognize supported remote image MIME aliases, canonicalize them, and infer a canonical type for a supported WebDAV URL when the response is `application/octet-stream`.
- Consumes: `RemoteCache.put(sourceId, entryId, response, sourceType, entry, ...)` already receives the source type and original entry URL needed to constrain generic MIME fallback to WebDAV.

- [x] **Step 1: Write failing cache-policy tests**

Add table-driven tests proving `RemoteCache.put` accepts and canonicalizes `image/jpg`, `image/pjpeg`, `image/x-png`, `image/bmp`, and `image/x-ms-bmp`. Add a WebDAV-only test proving `application/octet-stream` is accepted for a `.bmp` entry and rejected for an unsupported extension.

- [x] **Step 2: Write a failing dispatcher integration test**

Use the real in-memory `RemoteCache` and a WebDAV adapter result containing a BMP entry. Return `application/octet-stream` from the image fetcher and assert the dispatcher returns a materializable cached entry rather than a network failure.

- [x] **Step 3: Verify RED**

Run: `npm test -- src/storage/remoteCache.test.ts src/background/index.test.ts`

Expected: the new MIME/cache tests fail with `cached: false` or a network result because the current cache allowlist rejects the new formats.

- [x] **Step 4: Implement the shared image policy**

Create a focused policy module that maps aliases to canonical image MIME values and maps supported extensions to canonical values. In `RemoteCache.prepare`, accept canonical/alias image responses for all remote sources; only infer from a generic MIME when `sourceType === 'webdav'` and the entry URL has a supported extension. Store the normalized `Content-Type`. Make `WebDavSourceAdapter.isImage` consume the same supported type/extension policy.

- [x] **Step 5: Verify GREEN**

Run: `npm test -- src/storage/remoteCache.test.ts src/background/index.test.ts src/sources/webdav.test.ts`

Expected: all focused tests pass with pristine output.

### Task 2: Represent unknown cached catalog totals without fabrication

**Files:**
- Modify: `src/background/index.ts`
- Modify: `src/background/index.test.ts`
- Modify: `src/newtab/App.tsx`
- Modify: `src/newtab/App.test.tsx`

**Interfaces:**
- Produces: remote cursor responses with exact `totalCount` when catalog metadata exists, and no `totalCount` plus `hasMore: true` when only a non-empty cache window is known.
- Consumes: the existing optional `ListImagesResult.totalCount` contract.

- [x] **Step 1: Write failing producer and consumer tests**

Change the unknown-metadata background test to assert `totalCount` is absent while `offset`, `consumedCount`, `nextOffset`, and `hasMore` remain valid. Add an App test that accepts such a cache-only cursor, displays the cached image, and leaves the Sources count as `图片数量待加载` after the live request fails.

- [x] **Step 2: Verify RED**

Run: `npm test -- src/background/index.test.ts src/newtab/App.test.tsx`

Expected: the background test sees the fabricated count and the App rejects the response or publishes a fabricated count.

- [x] **Step 3: Implement honest unknown-count cursors**

Make `cachedCatalogWindow` conditionally include `totalCount` only when catalog metadata supplied it. For unknown metadata, return a non-empty window with `hasMore: true`. Update App window state, count publication, and remote cursor validation so an omitted count is valid only with a coherent cursor and `hasMore: true`; preserve exact-count consistency checks when the count exists.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- src/background/index.test.ts src/newtab/App.test.tsx`

Expected: both focused files pass with pristine output.

### Task 3: Put WebDAV work inside explicit caller deadlines

**Files:**
- Create: `src/sources/webdavPolicy.ts`
- Modify: `src/sources/webdav.ts`
- Modify: `src/sources/webdav.test.ts`
- Modify: `src/newtab/sourceClient.ts`
- Modify: `src/newtab/sourceClient.test.ts`

**Interfaces:**
- Produces: shared request, scan, and caller deadline constants satisfying `request < ordinary callback` and `scan < live-list callback`.
- Produces: `WebDavAdapterOptions.scanTimeoutMs?: number` for deterministic deadline testing.

- [x] **Step 1: Write failing outer-deadline test**

Use fake timers to return a successful `source: 'test'` callback just after 30 seconds and assert `sendBackgroundRequest` still returns that success instead of the fallback.

- [x] **Step 2: Write failing overall-scan test**

Return one root image plus child directories, hang a child request until the shared scan controller aborts, and assert `listImages` returns the root image with a retryable warning before visiting further children.

- [x] **Step 3: Verify RED**

Run: `npm test -- src/newtab/sourceClient.test.ts src/sources/webdav.test.ts`

Expected: the slow successful callback loses to the current 30-second outer timer, and the adapter has no overall scan deadline.

- [x] **Step 4: Implement shared timing policy and overall scan cancellation**

Use shared policy constants for the adapter request timeout and UI callback deadlines. Add a lower overall scan deadline in `WebDavSourceAdapter.load`; when it fires, abort the active request, stop traversal, and return already discovered images with a bounded retryable warning. If no image was discovered, return a retryable network failure. Clear all timers in `finally`.

- [x] **Step 5: Verify GREEN**

Run: `npm test -- src/newtab/sourceClient.test.ts src/sources/webdav.test.ts`

Expected: both focused files pass with pristine output.

### Task 4: Full verification and build

**Files:**
- Verify only; no additional production scope.

**Interfaces:**
- Consumes: all completed task outputs.
- Produces: a build ready for manual user testing.

- [x] **Step 1: Run whitespace validation**

Run: `git diff --check HEAD`

- [x] **Step 2: Run the complete project check**

Run: `npm run check`

Expected: typecheck succeeds, all Vitest tests pass, and Vite production build succeeds.

- [x] **Step 3: Confirm review scope**

Run: `git status --short` and confirm only the pre-existing pending change plus files named by this plan are modified.

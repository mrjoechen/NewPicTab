# PicTab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Chrome Manifest V3 new-tab extension with user-managed image sources, configurable transitions, clock/date/weather/search/shortcuts, and a minimal right-side settings drawer.

**Architecture:** A React new-tab application renders the experience and invokes permission prompts directly from user gestures. A Manifest V3 service worker owns remote requests and provider adapters. Versioned settings live in `chrome.storage.local`, local image blobs and large metadata live in IndexedDB, and remote image responses use a bounded cache with a bundled fallback.

**Tech Stack:** React, TypeScript, Vite, Chrome Manifest V3 APIs, IndexedDB, Cache Storage, Vitest, Testing Library, Playwright Chromium.

---

## File Map

The implementation creates these focused units:

- `package.json`: scripts and pinned project dependencies.
- `vite.config.ts`: multi-entry build for `newtab.html` and the service worker.
- `public/manifest.json`: MV3 new-tab override and least-privilege permissions.
- `public/assets/fallback.svg`: bundled offline background.
- `newtab.html`: new-tab HTML entry.
- `src/newtab/main.tsx`: React bootstrap.
- `src/newtab/App.tsx`: top-level composition only.
- `src/newtab/styles.css`: visual system and responsive layout.
- `src/newtab/components/BackgroundStage.tsx`: two-layer image display and transitions.
- `src/newtab/components/ClockWeather.tsx`: clock, date, and weather presentation.
- `src/newtab/components/SearchBox.tsx`: configurable search form.
- `src/newtab/components/ShortcutDock.tsx`: shortcut launcher.
- `src/newtab/settings/SettingsDrawer.tsx`: drawer shell and navigation.
- `src/newtab/settings/SourcesPanel.tsx`: source list, activation, and editor routing.
- `src/newtab/settings/AppearancePanel.tsx`: background order, interval, and transition controls.
- `src/newtab/settings/WidgetsPanel.tsx`: clock/date/weather/search toggles and settings.
- `src/newtab/settings/ShortcutsPanel.tsx`: shortcut CRUD and reordering.
- `src/newtab/settings/AboutPanel.tsx`: privacy, TMDB attribution, and disabled provider notices.
- `src/domain/types.ts`: shared settings and image-source types.
- `src/domain/defaults.ts`: versioned defaults.
- `src/domain/migrate.ts`: defensive schema migration.
- `src/domain/rotation.ts`: sequential/shuffle navigation and fallback selection.
- `src/storage/settingsStore.ts`: Chrome storage boundary.
- `src/storage/imageDb.ts`: IndexedDB image/blob repository.
- `src/storage/remoteCache.ts`: bounded remote Cache Storage boundary.
- `src/sources/adapter.ts`: provider adapter interface and normalized errors.
- `src/sources/direct.ts`: direct URL adapter.
- `src/sources/jsonApi.ts`: constrained JSON API adapter and path parser.
- `src/sources/local.ts`: local-image adapter.
- `src/sources/webdav.ts`: WebDAV listing and authentication adapter.
- `src/sources/tmdb.ts`: TMDB feed, genre, Discover, and backdrop adapter.
- `src/background/index.ts`: service worker message dispatcher.
- `src/background/messages.ts`: typed UI/background messages.
- `src/weather/openMeteo.ts`: city search and current-weather adapter.
- `src/lib/chrome.ts`: promise-based Chrome API wrappers and test fallbacks.
- `src/test/setup.ts`: DOM and Chrome mocks.
- `src/**/*.test.ts(x)`: colocated unit/component tests.
- `e2e/extension.spec.ts`: unpacked-extension acceptance tests.
- `playwright.config.ts`: extension test configuration.
- `README.md`: installation, use, permissions, privacy, and API guidance.

## Task 1: Buildable Manifest V3 Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `public/manifest.json`
- Create: `public/assets/fallback.svg`
- Create: `newtab.html`
- Create: `src/newtab/main.tsx`
- Create: `src/newtab/App.tsx`
- Create: `src/newtab/App.test.tsx`
- Create: `src/newtab/styles.css`
- Create: `src/background/index.ts`
- Create: `src/test/setup.ts`

- [ ] **Step 1: Create the package manifest and install dependencies**

Write `package.json` with this complete script surface:

```json
{
  "name": "pictab",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "check": "npm run typecheck && npm test && npm run build"
  }
}
```

Run:

```bash
npm install react react-dom
npm install -D typescript vite @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom @types/chrome @playwright/test
```

Expected: `package-lock.json` is created and `npm audit` completes without an install error.

- [ ] **Step 2: Write the first failing shell acceptance check**

Run before creating the build files:

```bash
npm run build
```

Expected: FAIL because `tsconfig.json` and Vite entries do not exist.

- [ ] **Step 3: Add compiler, build, test, manifest, and entries**

Use a strict TypeScript config with `DOM`, `ES2022`, and `chrome` types. Configure Vite with two Rollup inputs:

```ts
// vite.config.ts
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        newtab: resolve(rootDir, 'newtab.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
```

Use these exact test/compiler settings:

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["chrome", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "e2e", "vite.config.ts", "vitest.config.ts", "playwright.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
  },
});
```

```ts
// src/test/setup.ts
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

Object.assign(globalThis, {
  chrome: {
    runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(), set: vi.fn(), clear: vi.fn() }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    permissions: { request: vi.fn(), contains: vi.fn(), remove: vi.fn() },
  },
});
```

Create a minimal MV3 manifest:

```json
{
  "manifest_version": 3,
  "name": "PicTab",
  "version": "0.1.0",
  "description": "A quiet, configurable photo new tab.",
  "minimum_chrome_version": "111",
  "permissions": ["storage", "unlimitedStorage", "geolocation"],
  "optional_host_permissions": ["https://*/*"],
  "chrome_url_overrides": { "newtab": "newtab.html" },
  "background": { "service_worker": "background.js", "type": "module" }
}
```

Use this self-contained fallback so offline first paint never depends on a remote asset:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#6f8790"/><stop offset=".48" stop-color="#334a51"/><stop offset="1" stop-color="#10191d"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <circle cx="650" cy="660" r="520" fill="#b8d0cf" opacity=".16"/>
</svg>
```

Create `App.tsx` with a visible product heading over the bundled fallback and make the service worker register an empty `runtime.onMessage` listener. Add a full-viewport reset in `styles.css`; do not add settings or source logic yet. Add this smoke test so Vitest has a real suite:

```tsx
// src/newtab/App.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the PicTab name over the fallback', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'PicTab' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Verify the skeleton**

Run:

```bash
npm run check
```

Expected: type checking, the App smoke test, and the Vite production build pass; `dist/manifest.json`, `dist/newtab.html`, and `dist/background.js` exist.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts public newtab.html src
git commit -m "build: scaffold PicTab MV3 extension"
```

## Task 2: Versioned Settings and Domain Model

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/defaults.ts`
- Create: `src/domain/migrate.ts`
- Create: `src/domain/migrate.test.ts`
- Create: `src/storage/settingsStore.ts`
- Create: `src/storage/settingsStore.test.ts`
- Create: `src/lib/chrome.ts`

- [ ] **Step 1: Write failing migration and persistence tests**

Cover defaults, partial older settings, invalid enum values, credential locality, and change subscriptions:

```ts
it('preserves valid fields and replaces invalid transition values', () => {
  const migrated = migrateSettings({ version: 0, appearance: { transition: 'spin' } });
  expect(migrated.version).toBe(1);
  expect(migrated.appearance.transition).toBe('fade');
});

it('returns the active source id from local storage', async () => {
  chrome.storage.local.get = vi.fn().mockResolvedValue({ pictab: { ...DEFAULT_SETTINGS, activeSourceId: 'nas' } });
  await expect(settingsStore.load()).resolves.toMatchObject({ activeSourceId: 'nas' });
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- src/domain/migrate.test.ts src/storage/settingsStore.test.ts`

Expected: FAIL because the modules are missing.

- [ ] **Step 3: Define discriminated source types and defaults**

Define `SourceConfig` as a discriminated union of `local`, `webdav`, `direct`, `json-api`, and `tmdb`. Define:

```ts
export type TransitionName = 'fade' | 'slide' | 'ken-burns' | 'none';
export type RotationOrder = 'sequential' | 'shuffle';

export interface PicTabSettings {
  version: 1;
  activeSourceId: string | null;
  sources: SourceConfig[];
  appearance: {
    transition: TransitionName;
    transitionMs: number;
    order: RotationOrder;
    changeOn: 'new-tab' | 'interval';
    intervalMinutes: number;
  };
  widgets: WidgetSettings;
  shortcuts: Shortcut[];
}
```

Use deterministic defaults: fade, 1200 ms, shuffle, new-tab, clock/date on, weather/search/shortcuts off, and no source.

- [ ] **Step 4: Implement defensive migration and storage wrapper**

`migrateSettings` must treat unknown input as untrusted, clamp duration/interval values, validate URLs, preserve recognized source records, and return a complete version-1 object. `settingsStore` exposes `load`, `save`, `update`, and `subscribe`; all writes use `chrome.storage.local` under one `pictab` key.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/domain/migrate.test.ts src/storage/settingsStore.test.ts`

Expected: PASS.

```bash
git add src/domain src/storage/settingsStore.ts src/storage/settingsStore.test.ts src/lib/chrome.ts
git commit -m "feat: add versioned local settings model"
```

## Task 3: Rotation and Indexed Image Persistence

**Files:**
- Create: `src/domain/rotation.ts`
- Create: `src/domain/rotation.test.ts`
- Create: `src/storage/imageDb.ts`
- Create: `src/storage/imageDb.test.ts`
- Create: `src/sources/adapter.ts`
- Create: `src/sources/local.ts`
- Create: `src/sources/local.test.ts`

- [ ] **Step 1: Write failing rotation and database tests**

```ts
it('wraps sequential navigation', () => {
  expect(nextIndex({ length: 3, current: 2, direction: 1, order: 'sequential' })).toBe(0);
});

it('falls back without returning a failed id', () => {
  expect(selectFallback(['a', 'b'], new Set(['a']), 'bundled')).toBe('b');
});

it('stores local blobs under a source id', async () => {
  await imageDb.putLocal('travel', { id: 'one', blob: new Blob(['x'], { type: 'image/jpeg' }), name: 'one.jpg' });
  await expect(imageDb.listLocal('travel')).resolves.toHaveLength(1);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/domain/rotation.test.ts src/storage/imageDb.test.ts src/sources/local.test.ts`

Expected: FAIL because rotation and IndexedDB boundaries do not exist.

- [ ] **Step 3: Implement deterministic rotation and normalized entries**

Define `ImageEntry` and `SourceError` in `adapter.ts`. Implement `nextIndex`, an injectable Fisher-Yates shuffle bag, invalid-entry exclusion, and the exact fallback chain: requested, another cached entry, last successful entry, bundled fallback.

- [ ] **Step 4: Implement IndexedDB and local adapter**

Use a single `pictab` database with versioned `localImages` and `sourceMetadata` object stores. Store `{ sourceId, id, name, type, size, blob, createdAt }`; expose `putLocal`, `listLocal`, `deleteLocal`, and `deleteSource`. The local adapter maps records to `blob:` URLs owned and revoked by the new-tab session.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/domain/rotation.test.ts src/storage/imageDb.test.ts src/sources/local.test.ts`

Expected: PASS including empty-source behavior.

```bash
git add src/domain/rotation* src/storage/imageDb* src/sources/adapter.ts src/sources/local*
git commit -m "feat: persist local images and rotate backgrounds"
```

## Task 4: Direct URL and Generic JSON Sources

**Files:**
- Create: `src/sources/direct.ts`
- Create: `src/sources/direct.test.ts`
- Create: `src/sources/jsonPath.ts`
- Create: `src/sources/jsonPath.test.ts`
- Create: `src/sources/jsonApi.ts`
- Create: `src/sources/jsonApi.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Test partial direct-URL success and constrained JSON traversal:

```ts
it('keeps valid direct images when one URL fails', async () => {
  const adapter = createDirectAdapter(async (url) => url.endsWith('bad.jpg') ? false : true);
  const result = await adapter.testConnection(directConfig(['https://a.test/good.jpg', 'https://a.test/bad.jpg']));
  expect(result.entries.map((entry) => entry.url)).toEqual(['https://a.test/good.jpg']);
  expect(result.warnings).toHaveLength(1);
});

it('reads arrays without evaluating code', () => {
  expect(readJsonPath({ data: { items: [{ image: 'a' }] } }, 'data.items')).toEqual([{ image: 'a' }]);
  expect(() => readJsonPath({}, 'constructor.constructor')).toThrow('Unsupported path segment');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/sources/direct.test.ts src/sources/jsonPath.test.ts src/sources/jsonApi.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement direct URLs and safe JSON mapping**

Only accept HTTPS URLs. `readJsonPath` accepts dot-separated object keys and numeric bracket indices, rejects prototype-related segments, and never calls `eval` or `Function`. The JSON adapter supports GET, static headers, array path, field mappings, optional page parameter, and maps up to six entries in its connection preview.

- [ ] **Step 4: Verify and commit**

Run the focused suite again; expect PASS for malformed JSON, non-array results, missing mapped URLs, partial direct failures, and header forwarding.

```bash
git add src/sources/direct* src/sources/jsonPath* src/sources/jsonApi*
git commit -m "feat: add direct and generic JSON image sources"
```

## Task 5: WebDAV Source and Optional Host Permission

**Files:**
- Create: `src/sources/webdav.ts`
- Create: `src/sources/webdav.test.ts`
- Create: `src/lib/permissions.ts`
- Create: `src/lib/permissions.test.ts`

- [ ] **Step 1: Write failing PROPFIND and permission tests**

Use a realistic multistatus fixture with a directory, encoded filename, non-image file, and nested image. Verify Basic auth encoding uses UTF-8-safe conversion and never appears in thrown messages.

```ts
it('requests exactly the configured origin', async () => {
  chrome.permissions.request = vi.fn().mockResolvedValue(true);
  await requestOriginPermission('https://dav.example.com/photos');
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://dav.example.com/*'] });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/sources/webdav.test.ts src/lib/permissions.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the WebDAV adapter**

Send `PROPFIND` with `Depth: 1` by default, request `resourcetype`, `getcontenttype`, and `getcontentlength`, parse XML with `DOMParser`, resolve `href` against the configured directory, and retain supported image MIME types/extensions. If recursion is enabled, breadth-first scan child directories with a hard cap of 2,000 resources and surface a truncation warning.

- [ ] **Step 4: Implement permission prompting at the UI boundary**

`requestOriginPermission` validates HTTPS, converts a URL to `origin/*`, and calls `chrome.permissions.request`. It must be invoked from the source editor's button handler; tests verify denial returns a typed `permission-denied` result and no fetch starts.

- [ ] **Step 5: Verify and commit**

Run the focused tests; expect PASS for auth failure, malformed XML, empty directory, encoded paths, recursion cap, and permission denial.

```bash
git add src/sources/webdav* src/lib/permissions*
git commit -m "feat: add permission-scoped WebDAV sources"
```

## Task 6: TMDB Adapter and Provider Compliance

**Files:**
- Create: `src/sources/tmdb.ts`
- Create: `src/sources/tmdb.test.ts`
- Create: `src/sources/providers.ts`
- Create: `src/sources/providers.test.ts`

- [ ] **Step 1: Write failing TMDB tests**

Test Bearer authentication, connection testing, official genres, feed paths, Discover query serialization, and removal of entries without `backdrop_path`:

```ts
it('normalizes only TMDB backdrops', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ results: [
    { id: 1, title: 'One', backdrop_path: '/one.jpg' },
    { id: 2, title: 'Two', backdrop_path: null }
  ] }));
  const entries = await tmdb.listImages(config);
  expect(entries).toEqual([expect.objectContaining({ id: 'tmdb:movie:1' })]);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/sources/tmdb.test.ts src/sources/providers.test.ts`

Expected: FAIL with missing provider modules.

- [ ] **Step 3: Implement TMDB connection and classifications**

Use API Read Access Token as a Bearer header. Test with `/3/configuration`, build image URLs from configuration, fetch `/3/genre/movie/list` or `/3/genre/tv/list`, and support the exact feeds in the design. Serialize only TMDB-documented Discover filters. Preserve rate-limit and authentication status in normalized errors.

- [ ] **Step 4: Encode provider availability**

Export immutable TMDB provider metadata with its official onboarding and attribution links.

- [ ] **Step 5: Verify and commit**

Run the focused tests; expect PASS for token masking, official category retrieval, filters, pagination, missing images, and provider metadata immutability.

```bash
git add src/sources/tmdb* src/sources/providers*
git commit -m "feat: add compliant TMDB image source"
```

## Task 7: Service Worker Messaging and Bounded Remote Cache

**Files:**
- Create: `src/background/messages.ts`
- Modify: `src/background/index.ts`
- Create: `src/background/index.test.ts`
- Create: `src/storage/remoteCache.ts`
- Create: `src/storage/remoteCache.test.ts`

- [ ] **Step 1: Write failing message and cache tests**

Define messages for `source:test`, `source:list`, `source:refresh`, `weather:city-search`, and `weather:current`. Test that unknown messages return a structured error and credentials are removed from diagnostic output. Test least-recently-used eviction preserves the current and prefetched-next image.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/background/index.test.ts src/storage/remoteCache.test.ts`

Expected: FAIL because dispatch and cache modules are missing.

- [ ] **Step 3: Implement typed dispatch**

Create a discriminated `BackgroundRequest`/`BackgroundResponse` union. Register one async dispatcher, select adapters through a source-type registry, catch thrown values once, and return `SourceError` without passwords, authorization headers, tokens, or arbitrary response bodies.

- [ ] **Step 4: Implement remote cache bounds**

Cache image responses only when the adapter permits it. Store access metadata in IndexedDB, enforce a default 250 MB target, and evict least-recently-used entries while protecting the current and next keys. Respect TMDB cache removal on source deletion.

- [ ] **Step 5: Verify and commit**

Run the focused tests and `npm run build`; expect PASS and a generated `dist/background.js` with no Node globals.

```bash
git add src/background src/storage/remoteCache*
git commit -m "feat: route source requests through service worker"
```

## Task 8: Background Stage and Motion

**Files:**
- Create: `src/newtab/components/BackgroundStage.tsx`
- Create: `src/newtab/components/BackgroundStage.test.tsx`
- Create: `src/newtab/hooks/useBackgroundRotation.ts`
- Create: `src/newtab/hooks/useBackgroundRotation.test.ts`
- Modify: `src/newtab/App.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write failing UI and scheduling tests**

Test two image layers, successful decode before swap, arrow navigation, interval cleanup, new-tab-only behavior, and reduced-motion override:

```tsx
it('disables motion when the user prefers reduced motion', () => {
  mockMatchMedia(true);
  render(<BackgroundStage current={one} previous={two} transition="ken-burns" transitionMs={1400} />);
  expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'none');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/newtab/components/BackgroundStage.test.tsx src/newtab/hooks/useBackgroundRotation.test.ts`

Expected: FAIL with missing components.

- [ ] **Step 3: Implement two-layer rendering and transition state**

Render previous/current absolute layers with `background-image`, cover sizing, adaptive scrim, and transition data attributes. Preload with `new Image()` and `decode()`, retain the old image on error, and mark failed IDs for the current source generation.

- [ ] **Step 4: Implement rotation hook and polished CSS**

The hook coordinates source entries, current index, arrow keys, interval timers, and cleanup. CSS supplies full-viewport Fade, directional Slide, Ken Burns keyframes, None, a dark readability scrim, and responsive behavior. Do not render permanent previous/next buttons.

- [ ] **Step 5: Verify and commit**

Run focused tests, type checking, and build; expect PASS with no timer leaks or React warnings.

```bash
git add src/newtab/components/BackgroundStage* src/newtab/hooks src/newtab/App.tsx src/newtab/styles.css
git commit -m "feat: render immersive animated backgrounds"
```

## Task 9: Right-Side Settings Drawer and Source Management

**Files:**
- Create: `src/newtab/settings/SettingsDrawer.tsx`
- Create: `src/newtab/settings/SettingsDrawer.test.tsx`
- Create: `src/newtab/settings/SourcesPanel.tsx`
- Create: `src/newtab/settings/SourcesPanel.test.tsx`
- Create: `src/newtab/settings/SourceEditor.tsx`
- Create: `src/newtab/settings/AppearancePanel.tsx`
- Modify: `src/newtab/App.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write failing drawer and source-flow tests**

Test open/close, Escape, focus trap/restore, background inertness, immediate source activation, same-type multiple sources, permission denial, connection preview, local-file deletion warning, and settings persistence.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/newtab/settings/SettingsDrawer.test.tsx src/newtab/settings/SourcesPanel.test.tsx`

Expected: FAIL with missing settings components.

- [ ] **Step 3: Implement drawer shell and navigation**

Use a modal dialog semantics with a fixed right panel, backdrop click close, Escape close, initial focus, tab loop, and focus restoration. Navigation contains Sources, Background & motion, Time & date, Weather, Search, Shortcuts, and About. Keep the settings trigger low-emphasis at bottom-left.

- [ ] **Step 4: Implement source cards and editors**

Cards show name, type, entry count, status, and active state. The add flow first selects a provider, then shows its exact fields. Connection testing must precede TMDB category selection; WebDAV/generic origins request permission from the test button handler. Saving activates the first source if none is active. Delete confirmation names the affected local data.

- [ ] **Step 5: Implement appearance controls and verify**

Bind transition, duration, order, new-tab/interval mode, interval minutes, and "Change image" to settings/rotation. Run focused tests and `npm run build`; expect PASS.

```bash
git add src/newtab/settings src/newtab/App.tsx src/newtab/styles.css
git commit -m "feat: add live settings drawer and source management"
```

## Task 10: Clock, Date, and Open-Meteo Weather

**Files:**
- Create: `src/weather/openMeteo.ts`
- Create: `src/weather/openMeteo.test.ts`
- Create: `src/newtab/components/ClockWeather.tsx`
- Create: `src/newtab/components/ClockWeather.test.tsx`
- Create: `src/newtab/settings/WidgetsPanel.tsx`
- Create: `src/newtab/settings/WidgetsPanel.test.tsx`
- Modify: `src/background/messages.ts`
- Modify: `src/background/index.ts`
- Modify: `src/newtab/App.tsx`

- [ ] **Step 1: Write failing weather and widget tests**

Cover city search, coordinate selection, weather-code mapping, stale cached values, manual setup with no geolocation request, explicit location permission, 12/24-hour format, optional seconds, independent date visibility, and reduced weather animation.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/weather/openMeteo.test.ts src/newtab/components/ClockWeather.test.tsx src/newtab/settings/WidgetsPanel.test.tsx`

Expected: FAIL with missing weather modules.

- [ ] **Step 3: Implement Open-Meteo adapter**

Use the official geocoding and forecast HTTPS endpoints. Normalize `{ location, temperature, weatherCode, isDay, fetchedAt }`, map documented WMO codes to a small icon/text set, and return cached data with `stale: true` after a network failure. Request the Open-Meteo origins only when weather is enabled/configured.

- [ ] **Step 4: Implement clock/weather UI and settings**

Use one aligned minute timer when seconds are off and a one-second timer when enabled. Format through `Intl.DateTimeFormat`. Weather remains one restrained line. Chrome requires the `geolocation` permission to be declared statically, but PicTab calls `navigator.geolocation` only inside the explicit "Use current location" button click after explaining why; switching to a city stops using stored live coordinates.

- [ ] **Step 5: Verify and commit**

Run focused tests with fake timers, then `npm run build`; expect PASS with timers cleaned up on unmount.

```bash
git add src/weather src/newtab/components/ClockWeather* src/newtab/settings/WidgetsPanel* src/background src/newtab/App.tsx
git commit -m "feat: add configurable clock date and weather"
```

## Task 11: Search and Shortcut Dock

**Files:**
- Create: `src/newtab/components/SearchBox.tsx`
- Create: `src/newtab/components/SearchBox.test.tsx`
- Create: `src/newtab/components/ShortcutDock.tsx`
- Create: `src/newtab/components/ShortcutDock.test.tsx`
- Create: `src/newtab/settings/ShortcutsPanel.tsx`
- Create: `src/newtab/settings/ShortcutsPanel.test.tsx`
- Modify: `src/newtab/settings/WidgetsPanel.tsx`
- Modify: `src/newtab/App.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write failing search and shortcut tests**

Test predefined engines, required `{query}` in custom templates, whitespace-only submission, URL encoding, independent visibility, shortcut add/edit/delete/reorder, generated letter tiles, custom local icons, and refusal of non-HTTPS shortcut URLs.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/newtab/components/SearchBox.test.tsx src/newtab/components/ShortcutDock.test.tsx src/newtab/settings/ShortcutsPanel.test.tsx`

Expected: FAIL with missing components.

- [ ] **Step 3: Implement search**

Build the target URL by replacing exactly one `{query}` with `encodeURIComponent(trimmedQuery)`. Navigate through `window.location.assign`; never log or persist the query. Include Google, Bing, DuckDuckGo, and a validated custom HTTPS template.

- [ ] **Step 4: Implement shortcuts and edit panel**

Render a translucent bottom-center dock only when enabled and non-empty. Generated tiles use the first grapheme and a stable color derived from the shortcut ID. Store optional custom icons as local data, expose accessible names, and support keyboard-based move up/down controls in edit mode.

- [ ] **Step 5: Verify and commit**

Run focused tests, accessibility queries, and build; expect PASS.

```bash
git add src/newtab/components/SearchBox* src/newtab/components/ShortcutDock* src/newtab/settings/ShortcutsPanel* src/newtab/settings/WidgetsPanel.tsx src/newtab/App.tsx src/newtab/styles.css
git commit -m "feat: add configurable search and shortcuts"
```

## Task 12: First-Run, Errors, Privacy, and About

**Files:**
- Create: `src/newtab/components/FirstRun.tsx`
- Create: `src/newtab/components/FirstRun.test.tsx`
- Create: `src/newtab/components/SourceStatus.tsx`
- Create: `src/newtab/components/SourceStatus.test.tsx`
- Create: `src/newtab/settings/AboutPanel.tsx`
- Create: `src/newtab/settings/AboutPanel.test.tsx`
- Create: `src/lib/redact.ts`
- Create: `src/lib/redact.test.ts`
- Modify: `src/newtab/settings/SettingsDrawer.tsx`
- Modify: `src/newtab/App.tsx`

- [ ] **Step 1: Write failing resilience and compliance tests**

Test fallback display with no source/offline source, no modal error over the resting page, redaction of tokens/passwords/Authorization headers, TMDB notice and official links, and clear-all-data confirmation.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/newtab/components/FirstRun.test.tsx src/newtab/components/SourceStatus.test.tsx src/newtab/settings/AboutPanel.test.tsx src/lib/redact.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement quiet resilience**

First run shows the bundled fallback plus one compact invitation to add a source; after dismissal, configuration stays in settings. Source errors appear only in the source card/panel. Redaction recursively replaces keys matching token, password, secret, authorization, or api-key patterns before diagnostics are rendered or copied.

- [ ] **Step 4: Implement About and data clearing**

Show version, repository/license link, no-telemetry statement, local credential risk, and TMDB approved attribution text/logo treatment. "Clear all PicTab data" lists settings, local images, remote cache, weather cache, and credentials, then deletes each only after explicit confirmation.

- [ ] **Step 5: Verify and commit**

Run all unit tests and build; expect PASS and no secret values in snapshots/output.

```bash
git add src/newtab/components/FirstRun* src/newtab/components/SourceStatus* src/newtab/settings/AboutPanel* src/newtab/settings/SettingsDrawer.tsx src/lib/redact* src/newtab/App.tsx
git commit -m "feat: add resilient first run and privacy controls"
```

## Task 13: Extension E2E, Documentation, and Final Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/extension.spec.ts`
- Create: `README.md`
- Modify: `package.json`
- Modify: `public/manifest.json`

- [ ] **Step 1: Write failing unpacked-extension E2E tests**

Launch persistent Chromium with:

```ts
const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
```

Test new-tab override, fallback first paint, settings drawer, local/direct source activation, reload persistence, widget toggles, shortcuts, transition attributes, offline fallback, and disabled provider notices. Keep network provider tests deterministic with route fixtures; reserve one manual checklist for real WebDAV/TMDB credentials.

- [ ] **Step 2: Verify the E2E test initially fails**

Run:

```bash
npm run build
npm run test:e2e
```

Expected: FAIL until extension discovery, stable selectors, and any missing acceptance behavior are completed.

- [ ] **Step 3: Complete manifest metadata and README**

Document:

- Development installation and `npm run check`.
- Chrome `chrome://extensions` → Developer mode → Load unpacked → select `dist`.
- Every permission and when optional origin/geolocation access is requested.
- WebDAV app-password recommendation and local credential risk.
- TMDB application links, token entry, connection test, category selection, attribution, and non-commercial status.
- Direct URL/generic JSON examples with safe HTTPS endpoints and field paths.
- Privacy/no-telemetry statement and data clearing.

Update manifest description and commands only when backed by implemented UI; do not add broad static host permissions.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: all commands PASS. Then load `dist` in a clean Chrome profile and manually verify one real WebDAV connection, one real TMDB connection, manual city weather, optional geolocation, arrow navigation, all four transitions, and clear-all-data.

- [ ] **Step 5: Commit the verified release candidate**

```bash
git add README.md package.json package-lock.json public/manifest.json playwright.config.ts e2e src
git commit -m "test: verify PicTab extension end to end"
```

## Execution Notes

- Follow tasks in order because later UI tasks consume stable domain and adapter boundaries from earlier tasks.
- Never place real WebDAV credentials or API tokens in tests, fixtures, screenshots, commits, or console output.
- Use provider fixtures for automated tests and user-supplied credentials only for the final local manual check.
- Re-check official provider terms before enabling a currently disabled provider or changing distribution from non-commercial.
- After each task, update its checkboxes and run the focused tests before committing.

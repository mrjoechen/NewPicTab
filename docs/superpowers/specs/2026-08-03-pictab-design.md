# PicTab Chrome Extension Design

Date: 2026-08-03
Status: Approved design, pending implementation plan
Distribution: Open source, non-commercial

## 1. Product Summary

PicTab is a Chrome Manifest V3 extension that replaces the browser's new-tab page with a quiet, full-screen photo experience. Users create named image sources, activate one source at a time, and control the visibility of the clock, date, weather, search, and shortcut dock. All editing stays inside a right-side settings drawer so the resting new-tab page contains no unnecessary information.

The visual direction follows the supplied reference: an immersive image fills the viewport, the clock is the dominant element, secondary content is restrained, and controls disappear when they are not needed.

## 2. Goals

- Replace the Chrome new-tab page with a fast, uncluttered photo canvas.
- Let users add multiple independently configured image sources and switch the active source immediately.
- Support WebDAV, locally uploaded images, direct image URLs, generic JSON image APIs, and TMDB.
- Offer Fade, Slide, Ken Burns, and no-animation background transitions.
- Make clock, date, weather, search, and shortcuts independently configurable and optional.
- Use manual city entry for weather by default, with browser geolocation available only after explicit user action.
- Keep credentials on the current browser profile and never transmit them to PicTab-owned infrastructure.
- Remain usable offline or when a remote source fails.
- Stay within the documented terms of third-party APIs.

## 3. Non-Goals

- No PicTab account, cloud backend, analytics, telemetry, or cross-device image synchronization.
- No social feed, news, quotes, tasks, recommendations, ads, or other dashboard content.
- No remote code execution or arbitrary user-provided JavaScript in generic API mappings.
- No commercial distribution in the first release.

## 4. Confirmed Product Decisions

### 4.1 New-Tab Layout

- The background image always covers the viewport and uses a subtle adaptive dark overlay where needed for text legibility.
- Search is centered near the top when enabled.
- Time is centered and visually dominant when enabled.
- Date appears directly under the time when enabled.
- Weather appears as one restrained line under the date when enabled.
- User shortcuts appear in a compact translucent dock at the bottom center when enabled.
- A low-emphasis settings button sits at the bottom-left and reveals a right-side drawer.
- Closing the drawer returns to the clean new-tab page without leaving configuration controls visible.
- Disabled widgets leave no empty layout placeholders.
- Background source status and image counters are not shown on the resting page.

### 4.2 Background Interaction and Motion

- The active source chooses images in either sequential or shuffled order.
- Users can set an automatic change interval or change only when a new tab opens.
- Left and right arrow keys move to the previous and next image.
- A "Change image" command is available inside settings; navigation buttons do not remain visible over the image.
- Transition choices are:
  - Fade: cross-fade between two image layers; default.
  - Slide: horizontal transition based on navigation direction.
  - Ken Burns: slow scale and pan while the image is displayed, combined with a gentle cross-fade.
  - None: immediate replacement.
- Transition duration is configurable within a safe range.
- `prefers-reduced-motion` overrides animated transitions and uses an immediate or minimal fade change.
- Images are predecoded before transition whenever possible to prevent flashes and layout stalls.

### 4.3 Settings Drawer

The drawer uses six primary sections:

1. Image sources
2. Background and motion
3. Time and date
4. Weather
5. Search
6. Shortcuts

An About section contains version information, open-source links, privacy notes, third-party attributions, and API usage notices. Settings apply immediately so users can preview changes behind the drawer.

## 5. Image Source Model

An image source is a user-created, named instance. Examples include "Home NAS" (WebDAV), "Travel Photos" (local), and "Popular Movies" (TMDB). Multiple instances of the same source type are allowed.

Only one source is active at a time in the first release. Selecting another source activates its cached image immediately, then refreshes that source in the background. Every source owns its connection configuration, query/filter configuration, cache metadata, image order, current position, connection status, and last error.

Source cards expose these actions only inside settings:

- Activate
- Rename
- Edit configuration
- Test connection
- Refresh
- Clear cache
- Delete

Deleting a local source warns that its imported image blobs will also be removed. Removing WebDAV or API sources removes only PicTab configuration and cache, never remote content.

### 5.1 Shared Source Interface

Every adapter implements the same boundary:

- `validateConfig`: validate required user input without a network call.
- `testConnection`: verify credentials, permission, and a minimal response.
- `listImages`: return normalized, paginated image entries.
- `refreshMetadata`: update provider categories or directory metadata.
- `getAttribution`: return any attribution required for the About section or image context.
- `dispose`: remove adapter-owned cache and sensitive local fields when the source is deleted.

A normalized image entry contains a stable provider ID, display URL or local blob key, dimensions when available, optional preview color, optional description, optional author/source links, and attribution metadata.

### 5.2 Local Upload Source

- Accept multiple common browser-supported image formats through file selection or drag and drop.
- Store image blobs in extension-owned IndexedDB.
- Show a private thumbnail grid inside the source editor for removal and reordering.
- Never upload local images.
- Reject unreadable files individually while retaining valid selections.

### 5.3 WebDAV Source

Configuration fields:

- Source name
- HTTPS server/directory URL
- Username
- Password or app password
- Include subdirectories toggle

The connection flow requests optional host access only for the entered origin and only from a user-initiated action. A connection test performs an authenticated WebDAV request, validates the response, then scans supported image entries. Directory results normalize URL encoding and ignore non-image resources. The editor reports authentication failure, unsupported server behavior, permission denial, empty directories, and network failure separately.

Credentials remain in local extension storage and are never synchronized. The UI explicitly states that local browser storage is not a password vault and that anyone with access to the browser profile may be able to recover stored credentials.

### 5.4 Direct URL Source

- Accept one or more HTTPS image URLs.
- Allow an optional label for each URL.
- Validate syntax locally, then preview-load each item during connection testing.
- Keep working URLs even when some entries fail.

### 5.5 Generic JSON API Source

The first release supports read-only `GET` APIs with:

- HTTPS endpoint URL
- Optional static header name/value pairs
- JSON path to the result array
- Field mappings for image URL and optional stable ID, title, author, source page, width, and height
- Optional page parameter name and starting page

Paths use a constrained property/index syntax rather than executable expressions. The test step shows up to six parsed thumbnails and clear field-level errors before saving. API secrets and headers stay in local extension storage.

### 5.6 TMDB Source

TMDB is the only built-in third-party catalog adapter enabled in the first release.

Connection flow:

1. The user chooses TMDB and names the source.
2. The drawer explains that PicTab is open source and non-commercial, and that TMDB requires an account and API registration.
3. "Apply for API access" opens `https://www.themoviedb.org/settings/api` in a normal browser tab.
4. "View official guide" opens `https://developer.themoviedb.org/v4/docs/getting-started`.
5. The user pastes an API Read Access Token. PicTab masks it after entry.
6. "Test connection" sends an authenticated minimal request and reports success, invalid credentials, rate limiting, or network failure.
7. Only after a successful test does PicTab fetch official classifications and reveal category controls.

Available controls:

- Media type: movies or television.
- Official feeds: trending daily/weekly, popular, top rated, movie now playing, movie upcoming, TV airing today, or TV on the air.
- Discover mode: dynamically fetched genre list plus language, region, year/date, minimum rating, and supported sort order.
- Only results with a valid backdrop image are added to the rotation.
- Category names and genre IDs are fetched from TMDB rather than hard-coded as a permanent list.

The About section contains the required TMDB attribution and approved logo treatment. The implementation must be re-reviewed before any commercial distribution.

## 6. Time, Date, Weather, Search, and Shortcuts

### 6.1 Time and Date

- Independent master toggles for time and date.
- 12-hour or 24-hour time format.
- Seconds optional and disabled by default.
- Date format and locale follow the browser by default, with a small set of explicit display formats.
- Text size has restrained presets rather than arbitrary styling controls.

### 6.2 Weather

- Weather is disabled until configured.
- Default setup searches for a manually entered city and stores its selected coordinates.
- "Use current location" is optional and requests browser location only from that button click.
- Location access can be revoked by switching back to a city.
- Open-Meteo provides geocoding and current weather without a user API Key.
- The visible result is limited to location, temperature, condition icon/text, and an optional animation toggle.
- The last successful response remains available offline with a stale indicator inside settings, not on the resting page.

### 6.3 Search

- Search has an independent visibility toggle.
- Users can choose a predefined search engine or define a custom HTTPS query template containing a required placeholder.
- Submitting a query navigates directly to the selected engine; PicTab does not record or proxy search terms.
- The empty search field has low visual contrast and gains focus styling only when used.

### 6.4 Shortcuts

- The entire shortcut dock can be hidden.
- Users can add, rename, edit, reorder, and remove shortcuts.
- Each shortcut contains a title, HTTPS URL, and optional custom icon.
- If no custom icon exists, PicTab uses a restrained generated tile with the first character rather than depending on a remote favicon service.
- The dock supports a configurable maximum appropriate to the viewport and scrolls only inside edit mode.

## 7. Architecture

### 7.1 Technology

- React
- TypeScript
- Vite
- Chrome Manifest V3
- Chrome 111 or newer, matching the explicit Vite build target
- CSS variables and scoped component styles
- Vitest for unit/component tests
- Playwright with Chromium for end-to-end extension flows

### 7.2 Runtime Components

`newtab` application:

- Renders background layers and optional widgets.
- Owns transition timing, keyboard input, and the settings drawer.
- Reads a coherent settings snapshot at startup and reacts to storage changes.
- Uses locally available cached content first.

Manifest V3 service worker:

- Owns remote requests, provider adapters, granted-origin tracking, rate-limit metadata, and refresh scheduling.
- Normalizes provider responses into the shared image entry format.
- Keeps the UI free of provider-specific networking logic.

Permission requests themselves run directly from the settings control's click handler so Chrome can associate each request with an explicit user gesture. The service worker performs remote work only after the UI confirms the required origin grant.

Persistence layer:

- `chrome.storage.local` stores settings, source configuration, source order, the active source ID, and credential fields. Nothing is placed in sync storage in the first release.
- IndexedDB stores imported local image blobs and large source metadata.
- Cache Storage stores bounded remote image responses where provider terms permit caching.
- A versioned schema migration runs before state is exposed to the UI.

### 7.3 Data Flow

1. Chrome opens PicTab's new-tab document.
2. The app reads local settings, the active source, and its most recent usable image.
3. It paints the cached or bundled fallback image without waiting for network access.
4. The service worker refreshes weather and the active remote source when cache policy says they are stale.
5. New normalized image metadata is persisted and announced to the new-tab page.
6. The next transition preloads and decodes its image before becoming visible.
7. Settings changes persist immediately and update the current page through a single state channel.

## 8. Permissions and Privacy

- Use the minimum static extension permissions needed for new-tab replacement and local storage.
- Treat remote provider origins as optional host permissions wherever Chrome permits, requested only during a user-initiated connection or feature setup.
- Chrome requires the `geolocation` manifest permission to be declared statically for extension pages. PicTab must never call `navigator.geolocation` unless the user explicitly chooses "Use current location," and the UI must explain the permission before use.
- Do not include analytics, crash-reporting SDKs, tracking pixels, or a PicTab server.
- Mask credentials in the UI and never write them to logs, error messages, exported diagnostics, or synchronized storage.
- Document that local storage protects against network disclosure, not against access to the user's unlocked browser profile.
- Provide a "Clear all PicTab data" action with an explicit confirmation and a precise list of affected local data.

## 9. Failure Handling

The new-tab page must never become a blank error screen.

Fallback order for the active source:

1. Requested next image
2. Another valid cached image from the same source
3. The source's last successfully displayed image
4. A bundled PicTab fallback background

Errors appear as concise source status inside settings, with an expandable technical detail safe for copying. Authentication failures pause automatic retries until the user edits or retests credentials. Rate limits respect provider reset metadata when available. Network errors use bounded backoff. Image decode failures mark that entry invalid for the current cache generation.

If persisted settings are partially invalid after an update, the migration preserves recognized fields, replaces invalid values with documented defaults, and writes a recoverable backup snapshot before completing.

## 10. Performance and Accessibility

- Target an immediate cached first paint with no dependency on remote APIs.
- Keep two background layers mounted for transitions rather than rebuilding the page.
- Bound remote cache size and evict least-recently-used images while preserving the current and next image.
- Avoid loading original-size remote assets when a screen-appropriate provider size exists.
- Use semantic buttons and inputs, visible keyboard focus, accessible labels, and sufficient contrast over varied images.
- Trap focus inside the settings drawer while open and restore it to the settings button on close.
- Support Escape to close the drawer and arrow keys for image navigation without intercepting keys while editing text.
- Respect reduced motion throughout background and weather animation.

## 11. Testing and Acceptance Criteria

### 11.1 Unit and Component Tests

- Settings defaults, validation, persistence, and schema migration.
- Image source normalization for every enabled adapter.
- WebDAV response parsing and encoded paths.
- Generic JSON path and field mapping without executable expressions.
- TMDB feed, genre, filter, pagination, and missing-backdrop behavior.
- Sequential/shuffle navigation, interval scheduling, and fallback order.
- Search template validation and shortcut CRUD/reordering.
- Weather code mapping, manual city selection, optional location flow, and stale cache.
- Settings drawer focus behavior and independent widget toggles.

### 11.2 Browser Tests

- Load the unpacked extension and verify Chrome uses PicTab for a new tab.
- Complete first-run setup without network access and still see a valid fallback background.
- Add, test, activate, edit, and delete each enabled source type.
- Switch between two sources and see the selected source immediately.
- Enter an invalid credential and confirm the page stays usable.
- Configure a TMDB token, load official categories after successful testing, and render a backdrop.
- Toggle every widget and reload to verify local persistence.
- Add and reorder shortcuts, submit a search, and exercise keyboard navigation.
- Verify Fade, Slide, Ken Burns, None, and reduced-motion overrides.
- Verify manual city setup does not request geolocation and explicit geolocation does.

### 11.3 Completion Criteria

- `npm test`, type checking, production build, and browser end-to-end tests pass.
- The built `dist` folder loads through Chrome's "Load unpacked" flow without manifest or CSP errors.
- A clean browser profile can configure and use all enabled source types.
- Remote failure, invalid credentials, empty sources, offline mode, and corrupt settings all retain a usable new-tab page.
- Main-page resting state contains only the widgets the user enabled and the low-emphasis settings entry.
- README documents installation, permissions, local credential risks, and TMDB setup/attribution.

## 12. Official References

- Chrome extensions: `https://developer.chrome.com/docs/extensions/`
- TMDB getting started: `https://developer.themoviedb.org/v4/docs/getting-started`
- TMDB API settings: `https://www.themoviedb.org/settings/api`
- TMDB finding data: `https://developer.themoviedb.org/docs/finding-data`
- TMDB attribution FAQ: `https://developer.themoviedb.org/docs/faq`
- Open-Meteo documentation: `https://open-meteo.com/en/docs`

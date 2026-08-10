# PicTab

[简体中文](README.md) | English

PicTab is a minimal Chrome new-tab extension that keeps your images front and center. Mix local and remote image sources, then show only the clock, date, weather, search, and shortcuts you want.

> PicTab is open source under the [MIT License](LICENSE). You may use, copy, modify, and distribute it as long as the copyright and license notices are preserved.

## Features

- Use local images, WebDAV, direct HTTPS image URLs, generic JSON APIs, or TMDB.
- Browse images sequentially or randomly, changing them on each new tab or at a set interval.
- Choose from fade, slide, Ken Burns, or no transition; PicTab respects the system's reduced-motion preference.
- Enable or disable the clock, date, weather, search, and shortcuts independently.
- Search with Google, Bing, DuckDuckGo, Baidu, or a custom HTTPS search template.
- Add, reorder, and remove shortcuts, with optional local custom icons.
- No PicTab account, backend, ads, analytics, telemetry, or tracking.

## Installation

### Download from Releases

1. Open the [Releases page](https://github.com/mrjoechen/PicTab/releases).
2. Download the latest zip release package.
3. Unzip it to a local directory.
4. Open `chrome://extensions`.
5. Enable **Developer mode** in the top-right corner.
6. Click **Load unpacked**.
7. Select the unzipped extension directory.
8. Open a new tab.

> Chrome cannot load the zip file directly. Unzip it first, then select the extracted directory.

### Build from source

To build and install PicTab from source, you need:

- Chrome 111 or later
- Node.js `^20.19.0` or `>=22.12.0`
- npm

```bash
git clone https://github.com/mrjoechen/PicTab.git
cd PicTab
npm ci
npm run build
```

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the generated `dist` directory.
5. Open a new tab.

> Load `dist`, not the repository root.

## Image sources

| Type | Description |
| --- | --- |
| Local images | Supports JPEG, PNG, WebP, GIF, and AVIF; files stay in the current Chrome profile. |
| WebDAV | Reads an HTTPS WebDAV directory with optional subdirectories; use a least-privilege app password. |
| Direct image URLs | Add one or more complete HTTPS image URLs. |
| Generic JSON API | Map image URLs, titles, authors, and other fields from an HTTPS API response, with optional pagination and request headers. |
| TMDB | Browse movie or TV backdrops with your own API Read Access Token; no credentials are bundled. |

For user-configured WebDAV, direct URL, and JSON API sources, PicTab requests access only to the exact HTTPS origins needed when you test or enable the source. It does not receive access to the entire web at installation.

## Privacy and permissions

- Settings, credentials, images, and caches stay in the current Chrome profile. PicTab does not use Chrome Sync or upload them to a PicTab server.
- WebDAV passwords, JSON API headers, and TMDB tokens are stored in `chrome.storage.local`. This is not a password vault, so do not reuse your primary account password.
- PicTab contacts your selected image sources, TMDB, Open-Meteo, BigDataCloud, or search provider only when the corresponding feature is in use.
- Weather uses a manually selected city by default. Browser geolocation is requested only after you click **Use current location**, and BigDataCloud is then used to resolve a city name.
- **Settings → About → Clear all PicTab data** removes local settings, credentials, images, and caches. It does not delete remote content or revoke site permissions managed by Chrome.

To revoke site access, open `chrome://extensions` → PicTab → **Details** → **Site access**.

## Local development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start a standard Vite page preview; this is not the full extension environment. |
| `npm run build` | Type-check the project and create the loadable `dist` directory. |
| `npm test` | Run unit tests. |
| `npm run check` | Run type-checking, unit tests, and a production build. |
| `npm run e2e:install` | Install Playwright Chromium before the first E2E run. |
| `npm run test:e2e` | Build and run the Chrome extension E2E tests. |

## TMDB attribution

The TMDB image source requires your own [API Read Access Token](https://www.themoviedb.org/settings/api). Review TMDB's [getting started guide](https://developer.themoviedb.org/v4/docs/getting-started) and [logo and attribution requirements](https://www.themoviedb.org/about/logos-attribution) before configuring it.

![TMDB official logo](public/assets/tmdb-blue-short.svg)

This product uses the TMDB API but is not endorsed or certified by TMDB.

TMDB content, trademarks, and API usage remain subject to TMDB's terms. PicTab's license does not expand the rights granted by TMDB.

## License

PicTab is licensed under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, or sell copies of the software as long as the copyright and license notices are preserved. TMDB content, trademarks, and API usage remain subject to TMDB's own terms.

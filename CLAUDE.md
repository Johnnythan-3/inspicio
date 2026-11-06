# Inspicio

*Inspicio* = Latin "I look into." Simple, sleek site: user picks or drops photo, page shows every piece of its metadata.

## Product

- **Empty state:** big drop zone, click-to-browse fallback.
- **Loaded state:**
  - **Left:** full-res photo preview, smooth zoom/pan (wheel/trackpad pinch, touch pinch, double-click, drag, +/−/Fit controls, keys + − 0).
  - **Right panel:** metadata in sections, max 340 px wide. Header click collapses section smoothly; collapsed titles saved in `localStorage` (`inspicio.collapsed`). Only display prefs there, never photo data.
- **Metadata groups** (show only when data exists):
  - **Camera:** make, model, lens, software.
  - **Exposure:** ISO, shutter, aperture, focal length, flash, white balance.
  - **Date/Time:** capture time, modified time, time zone offset.
  - **Location:** GPS lat/lon (click either copies "lat, lon"; clicked row says "Copied to clipboard"), altitude, "open in map" link, opt-in "Show map" button (Mapbox static map + pin).
  - **Image:** pixel dimensions, orientation, color space, ICC profile.
  - **File:** name, size, MIME type, last modified.
  - **Raw:** every parsed tag, flat list at bottom.
- **No-metadata state:** screenshots, social/messaging images often have none. Show clear friendly message, never empty panel.
- **HEIC:** Chrome/Firefox can't display. Still show metadata, placeholder instead of preview.
- **RAW (DNG, ARW, CR2, CR3, NEF, …):** browsers can't decode, so `loadRawPreview` in `app.js` shows largest embedded JPEG preview (JPEG start marker + frame header; rotated by RAW's EXIF orientation if preview has none). Metadata still from exifr. iPhone ProRAW, Sony ARW embed full size; DJI only 960 × 540.
- **Photos app drags:** dragging out of macOS Photos gives small preview (e.g. 360 × 480, UUID name). Panel shows "Small copy" notice for camera photos under 1200 px. Full size: picker's Photos sidebar, drag to Desktop first, or Safari (~3 s wait, loading overlay).

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics on file contents, no backend. Privacy promise = main selling point. Never break.
- **One opt-in exception:** "Show map" requests Mapbox static image, sending coordinates (and IP) to Mapbox. Mapbox terms require text credit under map. Never request before click, never auto-load, keep note under button saying what it sends. Public `pk.` token = `MAPBOX_TOKEN` in `app.js` (empty hides button). Default public token of Mapbox account `johnnythan`, no card on file: no URL restrictions (need card), 5,000 Static Images requests/month, no possible charges. Over limit: map fails, OpenStreetMap link remains. Map `<img>` uses `referrerPolicy = 'strict-origin'` so URL-restricted token works if added later.
- **No build step.** Plain HTML, CSS, JS. Opening `index.html` (or static serving) must work.
- **Metadata parsing:** [`exifr`](https://github.com/MikeKovarik/exifr) (EXIF, GPS, IPTC, XMP, ICC, HEIC), pinned CDN version or vendored. No hand-rolled parser.
- **Revoke object URLs** (`URL.revokeObjectURL`) when new photo loads.

## Design

- Simple, sleek, one accent color, square corners everywhere. Logo: pixel "i" breaking out of frame. Fonts self-hosted in `vendor/`: Geist (text), Geist Mono (numbers), Departure Mono (wordmark, labels; 11 px grid, use multiples of 5.5 px).
- User's colors: accent `#19448A` (dark `#89ADE6`), light bg `#E9F0EE`. Check text contrast 4.5:1 on change.
- Light + dark via `prefers-color-scheme` and CSS custom properties.
- Narrow widths: panel stacks below preview.
- Human formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`, readable dates, KB/MB. Raw value stays in Raw section.

## Repo and deploy

- **GitHub:** `Johnnythan-3/inspicio`, default branch `main`.
- **Hosting:** Cloudflare Workers static assets (no Worker script), linked to repo. Push to `main` auto-deploys, usually 30–90 s (once over 3 min). Other branches get preview URLs.
- **Live URL:** https://inspicio.johnnythan.workers.dev
- **URL privacy rule:** workers.dev subdomain `johnnythan`, renamed from one exposing owner's email name. Never put owner's email or anything derived from it in URLs, files, commits. Commits use GitHub noreply address from repo git config.
- Fully static, no server code.

## Status (2026-11-05, session 5)

- All live. Sessions 2–3: layout, colors, map, copy coordinates, zoom, collapsible sections, RAW previews, Photos-drag fixes, legal pages (BC PIPA, Mapbox terms), logo, fonts.
- User tests in **Firefox** on Mac (Safari for Photos drags). Originals often iPhone 15 Pro ProRAW DNGs (48 MP), Sony A7C II ARWs.
- Session 4: Raw rows stack name above value. Motion "scan + decode" on photo open (`.zoom-frame::after` scan line; `decodeValues` in `app.js` scrambles visible values + chips in Departure Mono, then resolves). Whole site restyled "pixel frame": grid background on empty page, Departure Mono headlines, logo-style frames (gap in top edge, dot breaking out) for drop zone, badge, drag overlay; `--radius: 0`; outlined pixel buttons invert on hover. Logo 15% bigger. Empty-page footer line 60 px below format chips (user's choice).
- Session 5: empty-page ambient ticker (`#ticker` in `.hero-copy`, `buildTicker` in `app.js`): 7 faint rows of made-up tags slide behind headline, snapped between 22 px grid lines, stand still under reduced motion. Headline: feathered `backdrop-filter` blur. Drop zone hover: `startRunners` (`app.js`) runs pixel gaps along frame line on `#runners` canvas, shedding blue chips outward. More ideas: scan sweep, logo-dot hop, count-up numbers. Anime.js approved (vendor, never CDN); plain CSS otherwise.
- Not checked in Firefox or with real ARW/DNG/HEIC since session 4 restyle + decode. Ticker not checked in Firefox.
- Unreported from session 2 (ask briefly): RAW previews from Finder, trackpad pinch/pan in Firefox (`attachZoom` heuristic), collapse state, map, copy coordinates. Panel stays 340 px.
- Not tested: real touch pinch on phone.
- Later, only if asked: tag search, copy as JSON, "download clean copy", custom domain, OSM-tile map fallback.

## File layout

```
public/                  everything Cloudflare serves
  index.html             page markup and the CSP meta tag
  styles.css             all styles, light/dark tokens, animations
  app.js                 file handling, exifr calls, rendering
  _headers               security headers for Cloudflare
  privacy.html, terms.html  legal pages (BC law; contact inspicio.app@proton.me)
  404.html, favicon.svg
  vendor/                exifr 7.1.3, font files, their licenses
wrangler.jsonc           Cloudflare static assets config (serves ./public)
```

- CSP (`default-src 'none'`) blocks all requests except same-origin files and `img-src https://api.mapbox.com` for opt-in map. Keep in `index.html`, `privacy.html`, `terms.html`, `_headers`; proof behind privacy promise.
- Metadata = untrusted input. Render with `textContent` (`el()` helper in `app.js`), never `innerHTML`.
- Run locally: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep file under 8 KB.
- Test with real camera/phone JPEG with GPS, no-metadata screenshot, HEIC, RAW.
- User's console warnings about "SF Pro" fonts and CSP-blocked inline script: Firefox fingerprinting protection + browser extension, not site. That protection rounds timestamps, so JS motion steps by averaged `frameClock` (`app.js`).
- GitHub push protection flags Mapbox `pk.` token as secret. Allowed as false positive; new token needs same.
- In-app browser pane: start server with Bash in background (preview_start can't run python in Desktop folder), then attach via `.claude/launch.json` url. Hidden pane: `img.decode()`, view transitions, CSS animations never finish; stub `decode`, unset `document.startViewTransition`, call `finish()` on `document.getAnimations()`. Pane caches `styles.css`; swap link href with `?t=` to refresh. CSP blocks `fetch`, so build test files in page (canvas, base64) and load via `DataTransfer` on `#file-input`.

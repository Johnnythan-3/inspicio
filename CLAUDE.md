# Inspicio

*Inspicio* is Latin for "I look into." It is a simple, sleek website: the user picks or drops a photo from their computer, and the page shows every piece of metadata in that photo.

## Product

- **Empty state:** a large drag-and-drop zone with a click-to-browse fallback.
- **Loaded state:**
  - **Left side:** a large preview of the photo at full resolution, with smooth zoom and pan (wheel/trackpad pinch, touch pinch, double-click, drag, +/−/Fit controls, keys + − 0).
  - **Right panel:** metadata, grouped into sections (max 340 px wide so the photo gets more room). Clicking a section header collapses it smoothly; collapsed section titles are saved in `localStorage` (`inspicio.collapsed`). Store only display preferences there, never anything from a photo.
- **Metadata groups** (show a group only when it has data):
  - **Camera:** make, model, lens, software.
  - **Exposure:** ISO, shutter speed, aperture, focal length, flash, white balance.
  - **Date/Time:** original capture time, modified time, time zone offset.
  - **Location:** GPS latitude/longitude (click either to copy "lat, lon"; the clicked row says "Copied to clipboard"), altitude, an "open in map" link, and an opt-in "Show map" button (Mapbox static map with a pin).
  - **Image:** pixel dimensions, orientation, color space, ICC profile.
  - **File:** name, size, MIME type, last modified.
  - **Raw:** every tag the parser found, as a flat list at the bottom.
- **No-metadata state:** many images have no metadata, for example screenshots and photos saved from social media or messaging apps. Show a clear, friendly message. Do not show an empty panel.
- **HEIC:** Chrome and Firefox cannot display HEIC. Still read and show its metadata, and show a placeholder in place of the preview.
- **RAW (DNG, ARW, CR2, CR3, NEF, …):** browsers can't decode RAW data, so `loadRawPreview` in `app.js` shows the largest JPEG preview the camera embedded (found by JPEG start marker + frame header, rotated by the RAW's EXIF orientation if the preview has none). Metadata still comes from exifr. iPhone ProRAW and Sony ARW embed full-size previews; DJI only 960 × 540.
- **Photos app drags:** dragging straight out of macOS Photos gives the browser a small preview (e.g. 360 × 480 named by UUID). The panel shows a "Small copy" notice for camera photos under 1200 px. Full size: picker's Photos sidebar, drag to Desktop first, or Safari (~3 s wait, loading overlay).

## Hard rules

- **Everything runs in the browser.** The photo never leaves the user's machine: no uploads, no analytics on file contents, no backend. This privacy promise is the product's main selling point, so never break it.
- **One exception, opt-in only:** the "Show map" button requests a Mapbox static image, which sends the coordinates (and, like any request, the IP) to Mapbox. Mapbox's terms require the text credit under the map. Never request it before the user clicks, never auto-load it, and keep the note under the button that says what it sends. The public `pk.` token is `MAPBOX_TOKEN` in `app.js` (empty hides the button). It is the Default public token of Mapbox account `johnnythan`, which has no card on file: no URL restrictions (those need a card), 5,000 Static Images requests a month, and no possible charges. Over the limit, the map fails and the OpenStreetMap link remains. The map `<img>` uses `referrerPolicy = 'strict-origin'` so a URL-restricted token also works if one is added later.
- **No build step.** Plain HTML, CSS and JavaScript. Opening `index.html` (or serving the folder statically) must work.
- **Metadata parsing:** use [`exifr`](https://github.com/MikeKovarik/exifr) (EXIF, GPS, IPTC, XMP, ICC, HEIC). Load it from a pinned CDN version, or vendor it into the repo. Do not hand-roll a parser.
- **Revoke object URLs** (`URL.revokeObjectURL`) when the user loads a new photo.

## Design

- Simple and sleek: a lot of whitespace, one accent color. Logo: pixel "i" breaking out of a frame. Fonts, self-hosted in `vendor/`: Geist (text), Geist Mono (numbers), Departure Mono (wordmark, labels; 11 px grid).
- Colors chosen by the user: accent `#19448A` (dark mode `#89ADE6`), light page background `#E9F0EE`. Check text contrast (4.5:1) when changing them.
- Support light and dark mode with `prefers-color-scheme` and CSS custom properties.
- Responsive layout: at narrow widths the metadata panel stacks below the preview.
- Format values for people, for example `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`, readable dates, and file sizes in KB/MB. Keep the raw value available in the Raw section.

## Repo and deploy

- **GitHub:** `Johnnythan-3/inspicio`, default branch `main`.
- **Hosting:** Cloudflare Workers static assets (no Worker script), connected to the GitHub repo. Every push to `main` deploys automatically, usually in 30–90 s (once over 3 min). Other branches get preview URLs.
- **Live URL:** https://inspicio.johnnythan.workers.dev
- **Privacy rule for URLs:** the account's workers.dev subdomain is `johnnythan`. It was renamed from one that exposed the owner's email name. Never put the owner's email, or anything derived from it, in URLs, files or commits. Commits use the GitHub noreply address set in this repo's git config.
- The site is fully static, so no server code is needed.

## Status (2026-11-05, session 4)

- All live. Session 2: photo left / panel right, colors, opt-in map, copy coordinates, zoom and pan, collapsible sections, RAW previews. Session 3: Photos-drag fixes (notice button opens the picker, loading overlay for Safari's ~3 s wait), privacy and terms pages checked against BC PIPA and Mapbox terms (contact inspicio.app@proton.me), map credit line, new logo, fonts.
- The user tests in **Firefox** on a Mac (Safari works for Photos drags). Originals are often iPhone 15 Pro ProRAW DNGs (48 MP) and Sony A7C II ARWs.
- Session 4: Raw rows stack name above value. Motion: "scan + decode" on photo open (`.zoom-frame::after` scan line; `decodeValues` in `app.js` scrambles visible values and chips in Departure Mono, then resolves them). Other motion ideas offered: drop morph, logo-dot hop, count-up numbers.
- Still unreported from session 2 (ask briefly): RAW previews from Finder, trackpad pinch/pan in Firefox (`attachZoom` heuristic), collapse state, map, copy coordinates. Panel stays 340 px.
- Not tested yet: real touch pinch on a phone.
- Later, only if asked: tag search, copy as JSON, "download clean copy", custom domain, OSM-tile fallback for the map.

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

- The CSP (`default-src 'none'`) blocks every network request except same-origin files and `img-src https://api.mapbox.com` for the opt-in map. Keep it so in `index.html`, `privacy.html`, `terms.html` and `_headers`; it is the proof behind the privacy promise.
- Metadata is untrusted input. Render it with `textContent` (the `el()` helper in `app.js`), never `innerHTML`.
- Run locally: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Test with a real camera or phone JPEG that has GPS, a screenshot with no metadata, a HEIC file and a RAW file.
- The user's console warnings about "SF Pro" fonts and a CSP-blocked inline script come from Firefox fingerprinting protection and a browser extension, not the site.
- GitHub push protection flags the Mapbox `pk.` token as a secret. It was allowed as a false positive; a new token would need the same.
- Hidden in-app browser pane: `img.decode()` and view transitions never finish, so stub `decode` and unset `document.startViewTransition` in tests. Load files via `DataTransfer` on `#file-input`.

# Inspicio

*Inspicio* = Latin "I look into." Simple, sleek site: user picks or drops photo, page shows every piece of its metadata.

## Product

- **Empty state:** big drop zone, click-to-browse fallback. Tool tabs above it (`#modes`): Inspect, Wipe, Shot on; next Film. Same nav moves to panel top when photo open; mode in hash (`#wipe`).
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
- **Wipe:** JPEG/PNG lossless (copy segments; drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed by exifr; tag left = no download. exifr can't read WebP/GIF.
- **Shot on:** canvas card (`renderCard`), 3 editable lines from metadata. Style Light/Dark/Pixel, Font Serif/Wide/Hand (`CARD_FONTS`, not Pixel), Shape Original/Square/4:5 (`inspicio.card`, prefs only). Slim bar (user: more photo). Saves JPEG ≤ 3240 px.
- **HEIC:** Chrome/Firefox can't display. Still show metadata, placeholder instead of preview.
- **RAW (DNG, ARW, CR2, CR3, NEF, …):** browsers can't decode, so `loadRawPreview` in `app.js` shows largest embedded JPEG preview (JPEG start marker + frame header; rotated by RAW's EXIF orientation if preview has none). Metadata still from exifr. iPhone ProRAW, Sony ARW embed full size; DJI only 960 × 540.
- **Photos app drags:** give small preview; "Small copy" notice under 1200 px. Full size: picker's Photos sidebar, Desktop first, or Safari (~3 s, overlay).

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics on file contents, no backend. Privacy promise = main selling point. Never break.
- **One opt-in exception:** "Show map" requests Mapbox static image, sending coordinates (and IP) to Mapbox. Mapbox terms need text credit under map. Never request before click; keep note under button saying what it sends. Public `pk.` token = `MAPBOX_TOKEN` in `app.js` (empty hides button). Default token of Mapbox account `johnnythan`, no card: no URL restrictions, 5,000 requests/month free, no charges possible; over limit map fails, OSM link stays. Map `<img>` uses `referrerPolicy = 'strict-origin'` so URL-restricted token works if added later.
- **No build step.** Plain HTML, CSS, JS. Opening `index.html` (or static serving) must work.
- **Metadata parsing:** [`exifr`](https://github.com/MikeKovarik/exifr) (EXIF, GPS, IPTC, XMP, ICC, HEIC), pinned CDN version or vendored. No hand-rolled parser.
- **Revoke object URLs** when new photo loads.

## Design

- Simple, sleek, one accent color, square corners everywhere. Logo: pixel "i" breaking out of frame. Fonts self-hosted in `vendor/`: Geist (text), Geist Mono (numbers), Departure Mono (wordmark, labels; 11 px grid, multiples of 5.5 px). Card titles: Fraunces italic, Michroma, Caveat.
- User's colors: accent `#19448A` (dark `#89ADE6`), light bg `#E9F0EE`. Check text contrast 4.5:1 on change.
- Light + dark via `prefers-color-scheme` and CSS custom properties.
- Narrow widths: panel stacks below preview.
- Human formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`, readable dates, KB/MB; raw values in Raw section.

## Repo and deploy

- **GitHub:** `Johnnythan-3/inspicio`, default branch `main`.
- **Hosting:** Cloudflare Workers static assets (no Worker script), linked to repo. Push to `main` auto-deploys, usually 30–90 s (once over 3 min). Other branches get preview URLs.
- **Live URL:** https://inspicio.app (bought 2026-11-07, Cloudflare Registrar, auto-renew on; attached via `routes` in `wrangler.jsonc`). Old workers.dev home/404 forward there (`redirect.js`).
- **URL privacy rule:** workers.dev subdomain `johnnythan`, renamed from one exposing owner's email name. Never put owner's email or anything derived from it in URLs, files, commits. Commits use GitHub noreply address from repo git config.

## Status (2026-11-07, session 7)

- All live, user likes all of it. User tests in **Firefox** on Mac (Safari for Photos drags); originals often iPhone 15 Pro ProRAW DNGs (48 MP), Sony A7C II ARWs.
- Look: "pixel frame" style (grid bg, Departure Mono headlines, frames with gap + breakout dot, outlined buttons). Empty page: `buildTicker` made-up tags behind headline (22 px grid). Drop zone: 3 diagonal photos (`.stack-*`) spread on hover, `startBits` floats bits. Photo open: `pixelReveal` (10 steps, last 1.5 px), `decodeValues` scrambles then resolves values. Raw rows: name above value.
- Removed as clutter, don't bring back: pixel trails around drop zone.
- Confirmed by user: JPEG, ProRAW DNG, Sony ARW (full size, smooth at 48 MP), HEIC placeholder, Photos notice, pinch/pan, collapse, map, copy coords, workers.dev redirect. Test RAW from Photos via File › Export › Export Unmodified Original.
- Not tested: phone. Motion ideas: logo-dot hop, count-up numbers (Anime.js OK, vendored).
- Optional: `www.inspicio.app` redirect, `hello@inspicio.app` (Email Routing).
- Session 7: tabs, Wipe (user confirmed), Shot on (user not yet). Next: Film (port `../Archived/rolls` Swift engine; per-pixel stages as LUT like `PreviewLUT.swift`).
- Later, only if asked: tag search, copy as JSON, OSM-tile map fallback.

## File layout

```
public/                  everything Cloudflare serves
  index.html             page markup and the CSP meta tag
  styles.css             all styles, light/dark tokens, animations
  app.js                 file handling, exifr calls, rendering
  _headers               security headers for Cloudflare
  privacy.html, terms.html  legal pages (BC law; contact inspicio.app@proton.me)
  404.html, favicon.svg
  redirect.js            sends old workers.dev host to inspicio.app
  vendor/                exifr 7.1.3, font files, their licenses
wrangler.jsonc           Cloudflare static assets config (serves ./public)
```

- CSP (`default-src 'none'`) blocks all requests except same-origin files and `img-src https://api.mapbox.com` for opt-in map. Keep in `index.html`, `privacy.html`, `terms.html`, `_headers`; proof behind privacy promise.
- Metadata = untrusted input. Render with `textContent` (`el()` helper in `app.js`), never `innerHTML`.
- Run locally: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep file under 8 KB.
- Test with real camera/phone JPEG with GPS, no-metadata screenshot, HEIC, RAW.
- Console warnings on "SF Pro" fonts, CSP-blocked inline script: Firefox fingerprinting protection + extension, not site. It rounds timestamps: animate with CSS/Web Animations, never rAF timestamps.
- GitHub push protection flags Mapbox `pk.` token as secret. Allowed as false positive; new token needs same.
- In-app browser pane: start server with Bash in background (preview_start can't run python in Desktop folder), attach via `.claude/launch.json` url. Hidden pane: `img.decode()`, view transitions, animations never finish; stub `decode` to resolve on `load`, unset `document.startViewTransition`, `finish()` `document.getAnimations()`. Pane caches `styles.css`/`app.js` hard; open `127.0.0.1:8788` instead of `localhost` (fresh cache), reload after edits. CSP blocks `fetch`: build test files in page, load via `DataTransfer` on `#file-input`.

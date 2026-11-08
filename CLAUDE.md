# Inspicio

*Inspicio* = Latin "I look into." Simple, sleek photo toolbox: drop a photo, use one of the tools. All in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe, Shot on, Film. Above drop zone; panel top when photo open. Mode in hash or page (`data-tool`). Blue fill slides (`placeFill`). Subtitles stacked.
- **Zoom** (`zoomable`/`attachZoom`) every stage: wheel, pinch, double-click, drag, − % +, keys. 100% = photo px (saved px for card/film). `touch-action: manipulation` stops double-tap page zoom.
- **Inspect:** full-res preview; panel ≤ 340 px, collapsible sections (`inspicio.collapsed`); Location: copy lat/lon, opt-in Mapbox map, OSM link.
- **Wipe:** lists what photo gives away, saves clean copy. JPEG/PNG lossless (drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed; tag left = no download. Touch: share sheet.
- **Shot on:** canvas card (`renderCard`/`cardLayout`). Lines: title (model, no "Shot on"), settings (35 mm equiv), small line (lens · date). Style Light/Dark/Pixel; Font Serif (Fraunces)/Wide (Michroma)/Digicam (DSEG14, orange glow, caps, `'26 11 01` stamp); Shape Original/Square/4:5. Prefs `inspicio.card`, never text. Zoom redraws at save size (`cardWantsHi`). ≤ 3240 px.
- **Film:** rolls engine (Portra 400 → Endura, Noritsu) in `film.js`, data `film-data.js` (937 KB). Matches Swift (`tools/film/`).
  - JPEG/HEIC = finished photo: `photoTransfer` undoes tone curve, K at film mid-grey; "close, not exact". **HEIC gain map** (iOS 18+): `heif-worker.js` reads ISO 21496-1 `tmap` + Apple aux map (raw libheif C calls); input × max(1, gain). Subtle.
  - **HDR JPEG** (iPhone, Ultra HDR, Lightroom): `gainmap.js` finds MPF gain map, metadata ISO APP2 > hdrgm XMP > Apple `HDRGainMapHeadroom`; decoded without ICC, turned by EXIF orientation. iOS ≤ 16 JPEGs: none.
  - **ProRAW DNG**: `parseDNG`/`decodeDNG`, file's matrices, scene placement; matches Darkroom. Other RAW: embedded preview.
  - **Speed:** `film-worker.js` spawns 2–6 helpers: halation per channel, row strips ± `stripMargin` (49), K from strip samples. Bit-identical. 16 MP ~2.3 s.
  - Preview 1.4 MP; zoom past it develops full detail (`filmDetail`), slider restarts worker, Save reuses it. Caption bar while developing (`filmCaptionBar`).
  - Sliders: Exposure 0.5, Brightness 0.1 steps. **Frame**: square switch, White/Black, size 1–20% of short side (`inspicio.film`); `.film-print` inset in stage; save draws border (framed ≤ 16 MP). Save ≤ 16 MP (8 touch).
- **Saving** (Film, Shot on): dim overlay, step names (≥ 450 ms), one bar animation, speed per step (`barController`, `SAVE_STEPS`, learned `inspicio.speed`). Cancel (Film). Touch + `canShare`: "Save to Photos" (share sheet).
- **Phones (≤ 860 px):** top bar 50 px. **Film + Shot on = photo editor** (`editorShell`, `.viewer.is-editor`): no scroll, photo fills, 70 px control strip, square tool buttons.
- **HEIC:** Safari native; else vendored libheif 1.19.8 pure-JS (LGPL; WASM needs CSP change) → q0.95 JPEG.
- **RAW:** largest embedded JPEG (`loadRawPreview`). **Photos drags:** small preview notice.

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics, no backend. Never break.
- **One opt-in exception:** "Show map" loads Mapbox static image. Never before click; note + credit. `MAPBOX_TOKEN` in `app.js`, account `johnnythan`, free tier, no card. `referrerPolicy = 'strict-origin'`.
- **No build step.** Plain HTML, CSS, JS.
- **exifr** 7.1.3 (patched: ftyp limit 50 → 256 for iOS 18+ HEIC, `vendor/exifr-NOTICE.txt`) for metadata. No hand-rolled tag parser.
- **Revoke object URLs** on new photo. **Vendor** fonts/libs with license; never CDN (CSP).

## Design

- **Two looks**, chosen in display settings (`prefs.js`, sliders button bottom right; left of panel when photo open, wide). `inspicio.prefs` = look `pixel`|`mellow`, theme `auto`|`light`|`dark` (`data-theme`), motion `full`|`calm` (`data-motion`, = reduced motion). `<html data-look="pixel">` default before JS. **First visit** (no `inspicio.prefs`, main page only): blurred "Which look would you like?" chooser; live preview, colors glide (`@property` tokens + `html.look-shifting`).
- **Mellow** ("quiet gallery"): stone `#D6D3D1` (dark `#1C1917`), white cards, soft radius, Geist sentence case, underline tabs, soft logo. Rules scoped `[data-look="mellow"]` at end of `styles.css`.
- **Pixel** (default, rules above mellow): square corners, Departure Mono (11 px grid), grid bg, ticker, `pixelReveal`, `decodeValues` (JS effects gated by `pixelLook()`).
- Both: one accent `#19448A` (dark `#89ADE6`), Geist + Geist Mono, contrast 4.5:1, light + dark. Narrow: panel below. Every UI change: check both looks.
- Formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- User wants nothing in the UI to jump or resize (fixed-width boxes, measured widths).

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`; Cloudflare Workers static assets, push deploys in 30–90 s. Live https://inspicio.app.
- Search Console: Domain property, Cloudflare TXT (keep); `sitemap.xml` submitted 2026-11-08. `security.txt` expires 2027-11-01: renew.
- Never put owner's email or anything derived from it in URLs, files, commits.

## Status (2026-11-08, session 10)

- User tests in **Firefox** (Mac) and **Safari** (iPhone); photos: iPhone 16 HEIC, iPhone 15 Pro ProRAW, Sony A7C II ARW.
- Confirmed: all tools, HEIC/DNG/ARW, gain maps, Save to Photos, Mellow, settings, chooser, tab hover icons (loved; fill = transform only).
- Session 10 (search + sharing): `og-image.png` 1200×630, `apple-touch-icon.png`, `favicon.ico` (made in headless Chrome); OG tags; SEO titles in MODES `doc`; JSON-LD (home only); tool pages; `robots.txt`, `sitemap.xml`, `.well-known/security.txt`; README rewritten.
- Cloudflare insights: Bot Fight Mode, AI Labyrinth, Turnstile = skip (block previews/crawlers). User has MFA.
- **Not yet checked by user:** phone Film + Shot on editors; smaller phone top bar; no-flash tab switch; faster settings exit; tool page write-ups (user may edit copy).
- User wants features non-techy people notice. **Held off:** Film lab chooser (Frontier/scanners).
- **Next ideas:** offline mode (service worker; "try airplane mode" proof); resubmit sitemap after new pages; Apple `linearthumbnail` aux; camera RAW via DNG. Small: `www.` redirect, `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `film.js`/`film-worker.js`/`film-data.js`, `heif-worker.js`, `gainmap.js` (shared with HEIC worker), `prefs.js` (display settings, sync in head), `_headers`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `vendor/`. `tools/film/`: data rebuild, Swift compare, `bench-worker.js` (helpers match 1 core byte for byte).

- CSP `default-src 'none'` + `script-src 'self'` (legal pages too, for `prefs.js`); keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- **Tool pages** `remove-metadata`/`shot-on-frame`/`film-filter.html` made from `index.html` + MODES by `node tools/pages/make-pages.js` (rerun after edits; `--check`). `data-tool` = page's tool; write-up `#tool-about`.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Firefox rounds timestamps: use CSS/WAAPI. Mapbox `pk.` push warning: allowed.
- No third-party code in Node; our `film.js` OK.
- Don't reuse `data-mode` outside tabs.
- Browser pane: server via Bash background, `.claude/launch.json`. Often hidden (animations, rAF, ResizeObserver frozen): stub `img.decode`, unset `startViewTransition`; finish via `getAnimations()`. Stale cache: on `/film.js` (no CSP) `fetch(f, {cache:'reload'})` each file. Test files: `public/_test.*` + temp `_fetch-test.js` worker, `DataTransfer` on `#file-input`; delete `_*` before commit.

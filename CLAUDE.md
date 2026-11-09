# Inspicio

*Inspicio* = Latin "I look into." Simple photo toolbox, all in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe, Shot on, Film. Mode in hash or page (`data-tool`). Fill slides (`placeFill`).
- **Zoom** (`zoomable`/`attachZoom`) every stage: wheel, pinch, double-click, drag, keys. 100% = photo px (saved px for card/film). `touch-action: manipulation` stops double-tap page zoom.
- **Inspect:** full-res preview; panel ≤ 340 px, collapsible sections (`inspicio.collapsed`); Location: copy lat/lon, opt-in Mapbox map, OSM link.
- **Wipe:** saves clean copy. JPEG/PNG lossless (drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed; tag left = no download. Touch: share sheet.
- **Shot on:** canvas card (`renderCard`/`cardLayout`). Lines: title (model, no "Shot on"), settings (35 mm equiv), small line (lens · date). Style Light/Dark/Pixel; Font Serif (Fraunces)/Wide (Michroma)/Digicam (DSEG14, orange `'26 11 01` stamp); Shape Original/Square/4:5. Prefs `inspicio.card`, never text. Zoom redraws at save size (`cardWantsHi`). ≤ 3240 px.
- **Film:** rolls engine (Portra 400 → Endura, Noritsu) in `film.js`, data `film-data.js` (937 KB). Matches Swift with `calibrated: false`; `PORTRA_FIT` 3×3s tune colour to real Portra scans.
  - JPEG/HEIC = finished photo: `photoTransfer` undoes tone curve, K at film mid-grey; "close, not exact". **HEIC gain map** (iOS 18+): `heif-worker.js` reads ISO 21496-1 `tmap` + Apple aux map (raw libheif C calls); input × max(1, gain).
  - **HDR JPEG** (iPhone, Ultra HDR, Lightroom): `gainmap.js` finds MPF gain map, metadata ISO APP2 > hdrgm XMP > Apple `HDRGainMapHeadroom`; decoded without ICC, turned by EXIF orientation. iOS ≤ 16 JPEGs: none.
  - **ProRAW DNG**: `parseDNG`/`decodeDNG`, file's matrices, scene placement; matches Darkroom. Other RAW: embedded preview.
  - **Speed:** `film-worker.js` spawns 2–6 helpers (row strips ± `stripMargin` 49). Bit-identical. 16 MP ~2.3 s.
  - Preview 1.4 MP; zoom past it develops full detail (`filmDetail`), slider restarts worker, Save reuses it. Caption bar while developing (`filmCaptionBar`).
  - Sliders: Exposure 0.5, Brightness 0.1 steps. **Frame**: square switch, White/Black, size 1–20% of short side (`inspicio.film`); `.film-print` inset in stage; save draws border (framed ≤ 16 MP). Save ≤ 16 MP (8 touch).
- **Saving** (Film, Shot on): dim overlay, step names (≥ 450 ms), one bar animation, speed per step (`barController`, `SAVE_STEPS`, learned `inspicio.speed`). Cancel (Film). Touch + `canShare`: "Save to Photos".
- **Phones (≤ 860 px):** top bar 50 px. **Film + Shot on = photo editor** (`editorShell`, `.viewer.is-editor`): no scroll, 70 px control strip.
- **HEIC:** Safari native; else vendored libheif 1.19.8 pure-JS (LGPL; WASM needs CSP change) → q0.95 JPEG.
- **RAW:** largest embedded JPEG (`loadRawPreview`). Photos drags: preview notice.

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics, no backend. Never break.
- **One opt-in exception:** "Show map" loads Mapbox static image. Never before click; note + credit. `MAPBOX_TOKEN` in `app.js`, account `johnnythan`, free tier, no card. `referrerPolicy = 'strict-origin'`.
- **No build step.** Plain HTML, CSS, JS.
- **exifr** 7.1.3 (patched: ftyp limit 50 → 256 for iOS 18+ HEIC, `vendor/exifr-NOTICE.txt`) for metadata. No hand-rolled tag parser.
- **Revoke object URLs** on new photo. **Vendor** fonts/libs with license; never CDN (CSP).

## Design

- **Two looks**, chosen in display settings (`prefs.js`, sliders button bottom right). `inspicio.prefs` = look `pixel`|`mellow`, theme `auto`|`light`|`dark` (`data-theme`), motion `full`|`calm` (`data-motion`, = reduced motion). `<html data-look="pixel">` default before JS. **First visit** (no `inspicio.prefs`, main page): look chooser, colors glide (`@property` + `html.look-shifting`).
- **Mellow**: stone `#D6D3D1` (dark `#1C1917`), white cards, soft radius, Geist sentence case, soft logo. Rules scoped `[data-look="mellow"]` at end of `styles.css`.
- **Pixel** (default, rules above mellow): square corners, Departure Mono (11 px grid), grid bg, ticker, `pixelReveal`, `decodeValues` (JS effects gated by `pixelLook()`).
- Both: one accent `#19448A` (dark `#89ADE6`), Geist + Geist Mono, contrast 4.5:1, light + dark. Narrow: panel below. Every UI change: check both looks.
- Formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- User wants nothing in the UI to jump or resize (fixed widths).

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`; Cloudflare Workers static assets, push deploys in 30–90 s. Live https://inspicio.app.
- Search Console: Domain property, Cloudflare TXT (keep). `security.txt` expires 2027-11-01: renew.
- Never put owner's email or anything derived from it in URLs, files, commits.

## Status (2026-11-09, session 12)

- User tests **Firefox** (Mac), **Safari** (iPhone); iPhone 16 HEIC, 15 Pro ProRAW, Sony A7C II ARW.
- Confirmed: all tools, formats, gain maps, Save to Photos, both looks, settings, chooser.
- Sessions 10–11: OG/icons, tool pages, robots, sitemap, security.txt, write-ups, JSON-LD, cache, `llms.txt`.
- Session 12: Film calibrated to 5 public Portra 400 chart scans (ProRAW ΔE 10.1 → 7.45). Never ship DxO-derived data or third-party scans. Left: purple/red a bit dark, bluish green +15°, no underexposure desaturation.
- Cloudflare: AI Crawl Control all allowed, Bot Preference Sync off (keep). Skip Markdown for Agents, Bot Fight Mode, AI Labyrinth, Turnstile.
- **User to do:** Always Use HTTPS (`http://` serves 200); `www` DNS + redirect; resubmit sitemap; Bing Webmaster import from Search Console.
- **Not yet checked by user:** Film calibration on own photos/phone; phone Film + Shot on editors; smaller top bar; no-flash tab switch; faster settings exit; write-ups.
- User wants features non-techy people notice. Held off: Film lab chooser.
- **Next ideas:** offline mode (service worker); "HEIC to JPG" + "remove location on iPhone" pages; per-tool OG images; Apple `linearthumbnail`; camera RAW via DNG; `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `film.js`/`film-worker.js`/`film-data.js`, `heif-worker.js`, `gainmap.js` (shared with HEIC worker), `prefs.js` (display settings, sync in head), `_headers`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `llms.txt` (AI summary; update with tools), `vendor/`. `tools/film/`: data rebuild, Swift compare, `bench-worker.js` (helpers byte-identical), `portra/fit.js check|raw|photo`.

- CSP `default-src 'none'` + `script-src 'self'` (legal pages too, for `prefs.js`); keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- **Tool pages** `remove-metadata`/`shot-on-frame`/`film-filter.html` made from `index.html` + MODES by `node tools/pages/make-pages.js` (rerun after edits; `--check`). `data-tool` = page's tool; write-up `#tool-about` (home: Inspect, hand-written; pages swap it + own JSON-LD). Internal links clean (`privacy`, not `.html`). Bump sitemap `lastmod` on page edits.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Firefox rounds timestamps: use CSS/WAAPI. Mapbox `pk.` push warning: allowed.
- No third-party code in Node; our `film.js` OK.
- Don't reuse `data-mode` outside tabs.
- Browser pane (`.claude/launch.json`) often hidden (animations, rAF, ResizeObserver frozen): stub `img.decode`, unset `startViewTransition`; finish via `getAnimations()`. Stale cache: from `/film.js` tab (no CSP) `fetch(f, {cache:'reload'})`. Test files `public/_test.*` (CSP blocks `fetch`: load via `Image` + canvas `toBlob`), `DataTransfer` on `#file-input`; delete `_test*` before commit. Local: no clean URLs. `_compare/`: local, git-ignored.

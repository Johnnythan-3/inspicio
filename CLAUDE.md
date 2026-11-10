# Inspicio

*Inspicio* = Latin "I look into." Photo toolbox, all in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe, Shot on, Film. Mode in hash or page (`data-tool`). Fill slides (`placeFill`).
- **Zoom** (`zoomable`/`attachZoom`) every stage: wheel, pinch, double-click, drag, keys. 100% = photo px (saved px for card/film).
- **Inspect:** full-res preview; panel ≤ 340 px, collapsible sections (`inspicio.collapsed`); Location: copy lat/lon, opt-in Mapbox map, OSM link.
- **Wipe:** saves clean copy. JPEG/PNG lossless (drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed; tag left = no download. Touch: share sheet.
- **Shot on:** canvas card (`renderCard`/`cardLayout`). Lines: title (model, no "Shot on"), settings (35 mm equiv), small line (lens · date). Style Light/Dark/Pixel; Font Serif (Fraunces)/Wide (Michroma)/Digicam (DSEG14, orange `'26 11 01` stamp); Shape Original/Square/4:5. Prefs `inspicio.card`, never text. Zoom redraws at save size (`cardWantsHi`). ≤ 3240 px.
- **Film:** rolls engine (Portra 400 → Endura, Noritsu) in `film.js`, data `film-data.js` (937 KB). Matches Swift with `calibrated: false`; `PORTRA_FIT` 3×3s tune colour to real Portra scans.
  - JPEG/HEIC = finished photo: `photoTransfer` undoes tone curve, K at film mid-grey. `photoLight`: per channel to 245, above by luminance (else rings). **HEIC gain map** (iOS 18+): `heif-worker.js` reads ISO 21496-1 `tmap` + Apple aux map; input × max(1, gain).
  - **HDR JPEG**: `gainmap.js` finds MPF gain map, metadata ISO APP2 > hdrgm XMP > Apple `HDRGainMapHeadroom`; no ICC, EXIF-turned. iOS ≤ 16 JPEGs: none.
  - **ProRAW DNG**: `parseDNG`/`decodeDNG`, file's matrices, scene placement (iPhone metering too dark); night `HIGHLIGHT_GUARD`; shoulder `HIGHLIGHT_ROLL` (`K[3]`; `K[5]` = RAW); Exposure 60% in print (`RAW_PRINT`); look `GRADE_RAW`; Brightness starts 0.
  - **Speed:** `film-worker.js` spawns 2–6 helpers (row strips ± `stripMargin` 49). Bit-identical.
  - Preview 1.4 MP; zoom past it develops full detail (`filmDetail`), slider calls it off (`filmAbort`, negative kept), Save reuses it. Caption bar (`filmCaptionBar`): first develop + zoom detail only.
  - **Strength** 0–100%, default 30 (`filmPrefs.look`, `FilmEngine.look`): engine alone is ΔE 3 on a finished photo, so scan look by eye (`GRADE`, `gradeTable`) + bigger grain/halation (`fx`; grain × `GRAIN_TASTE` 0.8). 0% bit-identical to calibrated.
  - Sliders: Exposure 0.5, Brightness 0.1, Highlights ±5 (`HIGHLIGHT_LIFT`, `K[4]`). Phone: `slideBox` (glides, double-tap resets). **Frame**: square switch, White/Black, size 1–20% of short side (`inspicio.film`); save draws border (framed ≤ 16 MP). Save ≤ 16 MP (8 touch).
- **Saving** (Film, Shot on): dim overlay, step names (≥ 450 ms), one bar animation, speed per step (`barController`, `SAVE_STEPS`, learned `inspicio.speed`). Cancel (Film). Touch + `canShare`: "Save to Photos".
- **Phones (≤ 860 px):** top bar 50 px. **Film + Shot on = photo editor** (`editorShell`, `.viewer.is-editor`): no scroll, 70 px strip; tools one size, icons only < 375 px, settings button in top bar. Bars solid `--bar`, no blur (iOS 26 Safari tint: body colour or pinned bar).
- **HEIC:** Safari native; else vendored libheif 1.19.8 pure-JS (LGPL; WASM needs CSP change) → q0.95 JPEG.
- **RAW:** largest embedded JPEG (`loadRawPreview`). Photos drags: notice.

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics, no backend. Never break.
- **One opt-in exception:** "Show map" loads Mapbox static image. Never before click; note + credit. `MAPBOX_TOKEN` in `app.js`, account `johnnythan`, free tier. `referrerPolicy = 'strict-origin'`.
- **No build step.** Plain HTML, CSS, JS.
- **exifr** 7.1.3 (patched: ftyp limit 50 → 256 for iOS 18+ HEIC, `vendor/exifr-NOTICE.txt`) for metadata. No hand-rolled tag parser.
- **Revoke object URLs** on new photo. **Vendor** fonts/libs with license; never CDN (CSP).

## Design

- **Two looks**, chosen in display settings (`prefs.js`, sliders button bottom right). `inspicio.prefs` = look `pixel`|`mellow`, theme `auto`|`light`|`dark` (`data-theme`), motion `full`|`calm` (`data-motion`, = reduced motion). `<html data-look="pixel">` default before JS. **First visit** (no `inspicio.prefs`, main page): look chooser, colors glide (`@property` + `html.look-shifting`).
- **Mellow**: stone `#D6D3D1` (dark `#1C1917`), white cards, soft radius, Geist sentence case, soft logo. Rules scoped `[data-look="mellow"]` at end of `styles.css`.
- **Pixel** (default, rules above mellow): square corners, Departure Mono (11 px grid), grid bg, ticker, `pixelReveal`, `decodeValues` (JS effects gated by `pixelLook()`).
- Both: one accent `#19448A` (dark `#89ADE6`), Geist + Geist Mono, contrast 4.5:1. Every UI change: check both looks.
- Formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- User wants nothing in the UI to jump or resize (fixed widths).

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`; Cloudflare Workers static assets, push deploys in 30–90 s. Live https://inspicio.app.
- Search Console: Domain property, Cloudflare TXT (keep). `security.txt` expires 2027-11-01: renew.
- Never put owner's email or anything derived from it in URLs, files, commits.

## Status (2026-11-10, session 15)

- User tests live site only: **Firefox** (Mac), **Safari** (iPhone); iPhone 16 HEIC, 15 Pro ProRAW, Sony A7C II ARW.
- Film calibrated to 5 public Portra 400 chart scans (ProRAW ΔE 7.45). Never ship DxO-derived data or third-party scans.
- Cloudflare (keep): AI Crawl Control all allowed, Bot Preference Sync off, Always Use HTTPS, `www` AAAA `100::` + Redirect Rule to root.
- **Not yet checked by user:** session 15 (phone sliders, tools, bar colours, DNG contrast); Strength on skin; write-ups.
- User wants features non-techy people notice, obvious film look. Held off: lab chooser; RAW sky colour (lab mix 88%).
- **Next:** "HEIC to JPG" page; offline mode (service worker); "remove location on iPhone" page; camera RAW via DNG; `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `film.js`/`film-worker.js`/`film-data.js`, `heif-worker.js`, `gainmap.js`, `prefs.js` (sync in head), `_headers`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `llms.txt` (AI summary; update with tools), `vendor/`. `tools/film/`: data rebuild, Swift compare, `bench-worker.js`, `portra/fit.js check|raw|photo`.

- CSP `default-src 'none'` + `script-src 'self'` (legal pages too, for `prefs.js`); keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- **Tool pages** `remove-metadata`/`shot-on-frame`/`film-filter.html` made from `index.html` + MODES by `node tools/pages/make-pages.js` (rerun after edits; `--check`). `data-tool` = page's tool; write-up `#tool-about` (home: Inspect, hand-written; pages swap it + own JSON-LD). Internal links clean (`privacy`, not `.html`). Bump sitemap `lastmod` on page edits.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- This file < 8 KB.
- Firefox rounds timestamps: use CSS/WAAPI. Mapbox `pk.` push warning: allowed.
- No third-party code in Node; our `film.js` OK.
- Don't reuse `data-mode` outside tabs.
- Browser pane often hidden (animations, rAF frozen): stub `img.decode` (resolve on load), unset `startViewTransition`; finish via `getAnimations()`. Stale cache: from `/film.js` tab (no CSP) `fetch(f, {cache:'reload'})`; film worker files load fresh on localhost (`FILM_FRESH`). Test files `public/_test.*` (CSP blocks `fetch`: load via `Image` + canvas `toBlob`), DNG as base64 in `_test.js` (script tag), `DataTransfer` on `#file-input`; delete `_test*` before commit. Test DNGs: `../Archived/rolls`; no ARW on Mac. Local: no clean URLs. `_compare/`: local.

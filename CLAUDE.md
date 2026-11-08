# Inspicio

*Inspicio* = Latin "I look into." Simple, sleek photo toolbox: drop a photo, use one of the tools. All in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe, Shot on, Film. Above drop zone; panel top when photo open. Mode in hash. Blue fill slides (`placeFill`). Subtitles stacked (`.line-stack`).
- **Zoom** (`zoomable`/`attachZoom`) on every stage: wheel, pinch, double-click, drag, − % +, keys. % box fixed width; 100% = photo px (saved px for card/film). Hit areas extend ~12 px; bigger on touch. `html { touch-action: manipulation }` stops double-tap page zoom.
- **Inspect:** full-res preview; panel ≤ 340 px, collapsible sections (`inspicio.collapsed`); Location: copy lat/lon, opt-in Mapbox map, OSM link.
- **Wipe:** lists what photo gives away, saves clean copy. JPEG/PNG lossless (drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed; tag left = no download. Touch: share sheet.
- **Shot on:** canvas card (`renderCard`/`cardLayout`). Lines: title (model, no "Shot on"), settings (35 mm equiv), small line (lens · date). Style Light/Dark/Pixel; Font Serif (Fraunces)/Wide (Michroma)/Digicam (DSEG14, orange glow, caps, `'26 11 01` stamp); Shape Original/Square/4:5. Prefs `inspicio.card`, never text. Zoom redraws at save size (`cardWantsHi`). Saves ≤ 3240 px.
- **Film:** rolls engine (Portra 400 → Endura, Noritsu) in `film.js`, data `film-data.js` (937 KB). Matches Swift (`tools/film/`).
  - JPEG/HEIC = finished photo: `photoTransfer` undoes tone curve, K at film mid-grey; "close, not exact". **HEIC gain map** (iOS 18+): `heif-worker.js` reads ISO 21496-1 `tmap` + Apple aux map (raw libheif C calls); input × max(1, gain). Subtle.
  - **ProRAW DNG**: `parseDNG`/`decodeDNG`, file's matrices, scene placement; matches Darkroom. Other RAW: embedded preview.
  - **Speed:** `film-worker.js` spawns ≤ 6 helper copies (min 2): halation per channel, row strips ± `stripMargin` (49 rows), K from strip samples. Bit-identical to one piece. 16 MP ~2.3 s; preview Exposure ~0.25 s (input cached), Brightness reprints on helpers' kept strips ~50 ms.
  - Preview 1.4 MP; zooming past it develops full detail (`filmDetail`), slider cancels by restarting worker, Save reuses it. Caption = thin filling bar while developing, width measured to final text (`filmCaptionBar`).
  - Sliders: Exposure 0.5, Brightness 0.1 steps. **Frame**: square switch, White/Black, size 1–20% of short side (`inspicio.film`); `.film-print` inset in stage; save draws border (framed ≤ 16 MP). Save ≤ 16 MP (8 touch).
- **Saving** (Film, Shot on): dim overlay, step names (≥ 450 ms each), bar = one animation, speed changed per step (`barController`, `SAVE_STEPS` ms/MP, learned `inspicio.speed`). Cancel (Film). Touch + `canShare`: Ready → "Save to Photos" (share sheet; web can't write Photos).
- **Phones:** Shot on/Film stage sticky under top bar (40svh) so changes show while scrolling controls.
- **HEIC:** Safari native; Chrome/Firefox via vendored libheif 1.19.8 pure-JS (LGPL; WASM needs CSP change) → q0.95 JPEG blob.
- **RAW:** largest embedded JPEG (`loadRawPreview`). **Photos drags:** small preview notice.

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics, no backend. Never break.
- **One opt-in exception:** "Show map" loads Mapbox static image. Never before click; note + credit. `MAPBOX_TOKEN` in `app.js`, account `johnnythan`, free tier, no card. `referrerPolicy = 'strict-origin'`.
- **No build step.** Plain HTML, CSS, JS.
- **exifr** 7.1.3 (patched: ftyp limit 50 → 256 for iOS 18+ HEIC, `vendor/exifr-NOTICE.txt`) for metadata. No hand-rolled tag parser.
- **Revoke object URLs** on new photo. **Vendor** fonts/libs with license; never CDN (CSP).

## Design

- Sleek, one accent, square corners. Logo: pixel "i" breaking out of frame. Geist (text), Geist Mono (numbers), Departure Mono (headlines, labels; 11 px grid).
- Accent `#19448A` (dark `#89ADE6`), light bg `#E9F0EE`. Contrast 4.5:1. Light + dark. Narrow: panel below.
- Human formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- Pixel look: grid bg, ticker, diagonal photos, `pixelReveal`, `decodeValues`. No pixel trails.
- User wants nothing in the UI to jump or resize (fixed-width boxes, measured widths).

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`; Cloudflare Workers static assets, push deploys in 30–90 s. Live https://inspicio.app.
- Never put owner's email or anything derived from it in URLs, files, commits.

## Status (2026-11-07, end of session 8)

- User tests in **Firefox** (Mac) and **Safari** (iPhone); photos: iPhone 16 HEIC, iPhone 15 Pro ProRAW, Sony A7C II ARW.
- Confirmed: Wipe, Shot on, HEIC, DNG, ARW, gain map, fast Film, iPhone Save to Photos.
- Session 8: zoom everywhere + % box, exifr HEIC fix, full-detail film zoom, gain map, helpers (3.5×), save overlay, Frame, sticky phone stage, caption bar, tap fixes.
- **Not yet checked by user:** Frame on iPhone; sticky stage; smoother save bar; caption bar; zoom buttons on phone; Safari desktop (nested workers, save, frame ≤ 16 MP).
- **Next ideas:** Film lab chooser (Frontier, Optical print in rolls `PrintProfile.swift`); JPEG gain maps; Apple `linearthumbnail` aux (maybe scene-linear); camera RAW via DNG. Small: `www.` redirect, `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `film.js`/`film-worker.js`/`film-data.js`, `heif-worker.js`, `_headers`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `vendor/`. `tools/film/`: data rebuild, Swift compare, `bench-worker.js` (Node worker shim; helpers must match 1 core byte for byte).

- CSP `default-src 'none'`; keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Firefox rounds timestamps: animate with CSS/WAAPI. Mapbox `pk.` token push warning: allowed.
- Third-party code in Node blocked; our own `film.js` in Node is fine (bench, compare old vs new).
- Don't reuse `data-mode` outside tabs.
- Browser pane: server via Bash background, `.claude/launch.json`. Often hidden: timings wrong, animations frozen; stub `img.decode`, unset `startViewTransition`. Stale cache: open `/film.js` (no CSP) and `fetch(f, {cache:'reload'})` each file. Test files: `public/_test.*` + temporary `_fetch-test.js` worker, load via `DataTransfer` on `#file-input`; delete `_*` before commit.

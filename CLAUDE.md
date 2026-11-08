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
  - **HDR JPEG** (iPhone, Ultra HDR, Lightroom): `gainmap.js` finds MPF gain map, metadata ISO APP2 > hdrgm XMP > Apple `HDRGainMapHeadroom`; decoded without ICC, turned by EXIF orientation (checked vs libheif, r 0.998). Old iOS ≤ 16 JPEGs (headroom only in maker note): none.
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

- **Two looks**, chosen in display settings (`prefs.js`, sliders button bottom right, every page; left of panel when photo open, wide screens). `inspicio.prefs` = look `pixel`|`mellow`, theme `auto`|`light`|`dark` (`data-theme`), motion `full`|`calm` (`data-motion`, = reduced motion). `<html data-look="pixel">` default before JS. **First visit** (no `inspicio.prefs`, main page only): blurred "Which look would you like?" chooser (Original = pixel, Mellow); live preview, colors glide (`@property` tokens + `html.look-shifting`).
- **Mellow** ("quiet gallery"): stone bg `#D6D3D1` (user's pick; dark `#1C1917`), white cards, soft radius, Geist sentence case, underline tabs, sunken segments, soft logo (`.mark-soft`). All rules scoped `[data-look="mellow"]` at end of `styles.css`; tokens `--sunken`, `--raised`, `--on-accent`.
- **Pixel** (default): original look (rules above mellow block): square corners, Departure Mono labels (11 px grid), grid bg, ticker, diagonal photos, `pixelReveal`, `decodeValues`, data bits (JS effects gated by `pixelLook()`).
- Both: one accent `#19448A` (dark `#89ADE6`), Geist + Geist Mono, contrast 4.5:1, light + dark. Narrow: panel below. Every UI change: check both looks.
- Human formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- User wants nothing in the UI to jump or resize (fixed-width boxes, measured widths).

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`; Cloudflare Workers static assets, push deploys in 30–90 s. Live https://inspicio.app.
- Never put owner's email or anything derived from it in URLs, files, commits.

## Status (2026-11-07, session 9)

- User tests in **Firefox** (Mac) and **Safari** (iPhone); photos: iPhone 16 HEIC, iPhone 15 Pro ProRAW, Sony A7C II ARW.
- Confirmed: Wipe, Shot on, HEIC, DNG, ARW, gain map, fast Film, iPhone Save to Photos, Frame on iPhone, sticky stage, save bar, phone zoom, Safari save.
- Session 9: HDR JPEG gain maps; compare fixes; Mellow + settings + first-visit chooser; one-screen home; **tab hover icons** (user loves them): pixel SVGs in `index.html` (`.mode-icon`, `.ic-*`): magnifier, sponge, camera + phone with flash, CSS film strip (`.film-icon`); 2 px steps; sliding fill = transform only (`--fill-base/x/s`).
- **Not yet checked by user:** HDR JPEG film; compare fill; Mellow + settings; first-visit chooser; one-screen home; icon motion; fill smoothness; dark mode both looks.
- User wants features non-techy people notice; skip deep technical ones. **Held off:** Film lab chooser (Frontier/scanners).
- **Next ideas:** Apple `linearthumbnail` aux; camera RAW via DNG. Small: `www.` redirect, `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `film.js`/`film-worker.js`/`film-data.js`, `heif-worker.js`, `gainmap.js` (shared with HEIC worker), `prefs.js` (display settings, sync in head), `_headers`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `vendor/`. `tools/film/`: data rebuild, Swift compare, `bench-worker.js` (Node worker shim; helpers must match 1 core byte for byte).

- CSP `default-src 'none'` + `script-src 'self'` (legal pages too, for `prefs.js`); keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Firefox rounds timestamps: animate with CSS/WAAPI. Mapbox `pk.` token push warning: allowed.
- Third-party code in Node blocked; our own `film.js` in Node is fine (bench, compare old vs new).
- Don't reuse `data-mode` outside tabs.
- Browser pane: server via Bash background, `.claude/launch.json`. Often hidden: animations, rAF, ResizeObserver frozen; stub `img.decode`, unset `startViewTransition`; finish via `getAnimations()`. Stale cache: open `/film.js` (no CSP) and `fetch(f, {cache:'reload'})` each file. Test files: `public/_test.*` + temporary `_fetch-test.js` worker, load via `DataTransfer` on `#file-input`; delete `_*` before commit.

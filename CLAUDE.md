# Inspicio

*Inspicio* = Latin "I look into." Simple, sleek photo toolbox: drop a photo, use one of the tools. All in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe, Shot on, Film. Above drop zone; panel top when photo open. Mode in hash. Blue fill slides between choices (`placeFill`). Subtitles stacked (`.line-stack`), no shift.
- **Zoom** (`zoomable`/`attachZoom`) on every stage: photo (Inspect, Wipe), Shot on card (redrawn at save size when zoomed, `cardWantsHi`), Film (zoomed past preview px: full-detail develop at save size in background, `filmDetail`; slider move cancels it by restarting worker; Save reuses it). Wheel, pinch, double-click, drag, − % +, keys + − 0. Box always shows %, fixed width (fits `1000%`); 100% = photo px, or saved px for card/film.
- **Inspect:** left full-res preview. Right panel ≤ 340 px, collapsible sections (`inspicio.collapsed`): Camera, Exposure, Date & time, Location (click lat/lon copies; opt-in Mapbox "Show map"; OSM link), Description, Image, File, All tags. No metadata = friendly message.
- **Wipe** (user confirmed): lists what photo gives away, saves clean copy. JPEG/PNG lossless (copy segments; drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed by exifr; tag left = no download. exifr can't read WebP/GIF.
- **Shot on:** canvas card (`renderCard`/`cardLayout`), preview replaces photo in stage. Lines editable: title (model only, no "Shot on"), settings (35 mm equiv), small line (lens · date). Style Light/Dark/Pixel; Font Serif (Fraunces italic, default)/Wide (Michroma)/Digicam (DSEG14), row hidden for Pixel; Shape Original/Square/4:5. Prefs in `inspicio.card`, never text. Sizes % of card width × `tall` (up to 1.5 on tall cards); per-font `k`/`dk`. Digicam: all lines caps, orange `#ff5a1f` with canvas-shadow halation + bloom, spaces → `!`, small line auto `'26 11 01` until edited. Saves JPEG ≤ 3240 px.
- **Film:** rolls engine (Portra 400 → Endura, Noritsu) ported to `film.js`, runs in `film-worker.js`, measured data in `film-data.js` (937 KB, Film tab only). Matches Swift (`tools/film/` re-checks). JPEG/HEIC = finished photo (`placement: 'photo'`): `photoTransfer` undoes camera tone curve, K at film mid-grey, `photoBalance` neutral grey; note "close, not exact". **HEIC gain map** (iOS 18+, all browsers; user confirmed, subtle): `heif-worker.js` reads ISO 21496-1 `tmap` + Apple aux gain map via raw libheif C calls; film input × max(1, gain). Not yet: older iPhones (no `tmap`), JPEG. **ProRAW DNG** (LinearRaw + lossless JPEG): `parseDNG`/`decodeDNG` port, file's matrices, BaselineExposure, scene placement, rotate after print; matches Darkroom on IMG_0855. Other RAW: embedded preview. Preview 1.4 MP; Exposure re-develops (input cached), Brightness (0.1 steps) reprints on helpers' kept strips. **Frame** section: square switch, White/Black, size 1–20% of short side (`inspicio.film`); stage via `.film-print` inset, save draws border (framed ≤ 16 MP). Phones: Shot on/Film stage sticky. Save ≤ 16 MP (8 touch). Parallel: ≤ 6 helper copies of film-worker (halation per channel, row strips ± `stripMargin`), bit-identical. 16 MP ~2.3 s.
- **Saving** (Film, Shot on): dim overlay, step names, predicted bar (`saveProgress`, `SAVE_STEPS`, `inspicio.speed`). Touch: "Save to Photos" = share sheet.
- **HEIC:** Safari native. Chrome/Firefox: `heif-worker.js` + vendored libheif 1.19.8 pure-JS (LGPL, `vendor/libheif-NOTICE.txt`; WASM rejected, needs CSP `wasm-unsafe-eval`), ~0.8 s/12 MP, becomes q0.95 JPEG blob so all tools work.
- **RAW:** `loadRawPreview` shows largest embedded JPEG (rotated by RAW orientation if needed). ProRAW, Sony ARW full size; DJI 960 × 540.
- **Photos app drags:** small preview; "Small copy" notice under 1200 px.

## Hard rules

- **Everything runs in browser.** Photo never leaves machine: no uploads, no analytics, no backend. Main selling point. Never break.
- **One opt-in exception:** "Show map" loads Mapbox static image (coords + IP). Never before click; note under button; text credit under map. `MAPBOX_TOKEN` in `app.js` (empty hides button), account `johnnythan`, no card, 5,000/month, no charges possible; over limit map fails, OSM link stays. Map `<img>` `referrerPolicy = 'strict-origin'`.
- **No build step.** Plain HTML, CSS, JS.
- **exifr** (vendored 7.1.3, one patch: ftyp limit 50 → 256 bytes for iOS 18+ HEIC, see `vendor/exifr-NOTICE.txt`) for metadata. No hand-rolled parser (Wipe's segment copier only removes, never reads tags).
- **Revoke object URLs** on new photo.
- **Fonts and libraries vendored** in `vendor/` with license. Never CDN at runtime (CSP).

## Design

- Sleek, one accent, square corners. Logo: pixel "i" breaking out of frame. Geist (text, subtitles; user keeps), Geist Mono (numbers), Departure Mono (headlines, labels; 11 px grid).
- Colors: accent `#19448A` (dark `#89ADE6`), light bg `#E9F0EE`. Text contrast 4.5:1.
- Light + dark via `prefers-color-scheme`. Narrow: panel stacks below preview.
- Human formats: `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`.
- "Pixel frame" look: grid bg, ticker of made-up tags, 3 diagonal photos in drop zone, `pixelReveal`, `decodeValues`. Pixel trails removed (clutter), don't bring back.

## Repo and deploy

- GitHub `Johnnythan-3/inspicio`, `main`. Cloudflare Workers static assets; push to `main` deploys in 30–90 s.
- Live: https://inspicio.app (Cloudflare Registrar, auto-renew). 
- workers.dev subdomain `johnnythan`. Never put owner's email or anything derived from it in URLs, files, commits (noreply address in git config).

## Status (2026-11-07, session 8)

- User tests in **Firefox** on Mac and Safari on iPhone; photos: iPhone 16 HEIC, iPhone 15 Pro ProRAW, Sony A7C II ARW.
- User confirmed: Wipe, Shot on (rejected Instrument Serif, Caveat, "Shot on" prefix), HEIC, DNG, ARW, gain map, fast Film, iPhone save.
- **Next ideas:** Film lab chooser (rolls has Noritsu, Frontier, Optical print in `PrintProfile.swift`); gain maps for JPEG; camera RAW via DNG. Rolls → App Store; web ProRAW may compete or funnel (user's call).
- Small: `www.` redirect, `hello@inspicio.app`. Motion: logo-dot hop, count-ups (Anime.js OK). If asked: tag search, JSON copy.

## Files

`public/`: `index.html` (markup, CSP meta), `styles.css`, `app.js` (UI logic), `film*.js` (Film), `heif-worker.js` (HEIC), `_headers`, `privacy.html`/`terms.html` (BC law; inspicio.app@proton.me), `404.html`, `favicon.svg`, `redirect.js`, `vendor/`. `wrangler.jsonc` serves `./public`. `tools/film/` rebuilds film data from rolls (not served).

- CSP `default-src 'none'` (same-origin + Mapbox img). Keep in `index.html`, `privacy.html`, `terms.html`, `_headers`. No inline styles: set vars via `style.setProperty`.
- Metadata untrusted: `textContent` via `el()`, never `innerHTML`.
- Run: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Test with real phone/camera JPEG with GPS, no-metadata screenshot, HEIC, RAW.
- Design choices: user likes picking from a live preview page (scratchpad page + local server, fonts from jsdelivr there only).
- Firefox fingerprinting protection rounds timestamps: animate with CSS/Web Animations.
- GitHub push protection flags Mapbox `pk.` token: allowed false positive.
- Third-party code in Node is blocked: test vendored libs in browser pane.
- Don't reuse `data-mode` outside tabs (querySelector clash; stacked lines use `data-line`).
- Browser pane: server via Bash in background (preview_start can't run python in Desktop folder), attach via `.claude/launch.json`. Hidden pane: stub `img.decode` to resolve on `load`, unset `document.startViewTransition`, `finish()` animations. Caches hard: use `127.0.0.1:8788`, reload, swap stylesheet `?t=`. CSP blocks `fetch`: build test files in page, or put a real file in `public/_test.*` with a temporary `_fetch-test.js` worker (workers have no CSP locally), load via `DataTransfer` on `#file-input`; delete `_*` test files before committing.

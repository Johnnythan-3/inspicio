# Inspicio

*Inspicio* = Latin "I look into." Photo metadata tool, all in the browser.

## Product

- **Tabs** (`#modes`, copy in `MODES`): Inspect, Wipe. Mode in hash or page (`data-tool`); unknown hash (`#film`) = home tool. Fill slides (`placeFill`).
- **Zoom** (`zoomable`/`attachZoom`): wheel, pinch, double-click, drag, keys. 100% = photo px.
- **Inspect:** full-res preview; panel ≤ 340 px, collapsible sections (`inspicio.collapsed`); Location: copy lat/lon, opt-in Mapbox map, OSM link.
- **Wipe:** saves clean copy. JPEG/PNG lossless (drop EXIF/XMP/IPTC/COM/MPF, appended images; keep JFIF, ICC, Adobe, Orientation-only EXIF). Else canvas redraw to JPEG (Safari cap 16 MP). Copy re-parsed; tag left = no download. Touch: share sheet (`shareableFile`).
- **Phones (≤ 860 px):** top bar 50 px, photo above panel, page scrolls. Bars solid `--bar`, no blur (iOS 26 Safari tint: body colour or pinned bar).
- **HEIC:** Safari native; else vendored libheif 1.19.8 pure-JS in `heif-worker.js` (LGPL; WASM needs CSP change) → q0.95 JPEG.
- **RAW:** largest embedded JPEG (`loadRawPreview`). Photos drags: notice.

## Archived (2026-11-26)

- User's choice: site = metadata only. **Shot on** and **Film** (with its Frame border) pulled; Film moves to user's separate film site. Do not re-add here unless asked.
- Code kept, not served: `archived/frames/` (Shot on, card fonts), `archived/film/` (engine, gain maps, `tools/`, Portra fit), `archived/shared/` (save overlay, phone editor, removed CSS, `*.before.*` whole files). Guide: `archived/README.md`. Last commit with both live: `5d72e1c`.
- `public/_redirects`: `/film-filter`, `/shot-on-frame` → `/` (301).

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

## Status (2026-11-26, end of session 16)

- User tests live site only: **Firefox** (Mac), **Safari** (iPhone); iPhone 16 HEIC, 15 Pro ProRAW, Sony A7C II ARW.
- Cloudflare (keep): AI Crawl Control all allowed, Bot Preference Sync off, Always Use HTTPS, `www` AAAA `100::` + Redirect Rule to root.
- Visitors (2026-11-20): Cloudflare zone analytics only (Domains → Analytics; ~70% bots). No Web Analytics beacon: breaks "no analytics" + CSP. Search Console: 0 clicks, position 11.
- Promotion plan: Show HN (Tue–Thu morning ET), r/SideProject; Reddit account too new for r/webdev. Drafts mentioned Film/Shot on: rewrite for metadata only.
- Removal tested locally (both looks, phone width, HEIC); **not yet checked by user on live site.**
- **Next:** "remove location on iPhone" page; "HEIC to JPG" page; offline mode (service worker); `hello@inspicio.app`.

## Files

`public/`: `index.html` (CSP meta), `styles.css`, `app.js`, `heif-worker.js`, `prefs.js` (sync in head), `_headers`, `_redirects`, `privacy.html`/`terms.html`, `404.html`, `redirect.js`, `llms.txt` (AI summary; update with tools), `vendor/`. `archived/`: see above.

- CSP `default-src 'none'` + `script-src 'self'` (legal pages too, for `prefs.js`); keep in HTML files and `_headers`. No inline styles: `style.setProperty`. Metadata via `textContent` only.
- **Tool page** `remove-metadata.html` made from `index.html` + MODES by `node tools/pages/make-pages.js` (rerun after edits; `--check`). `data-tool` = page's tool; write-up `#tool-about` (home: Inspect, hand-written; pages swap it + own JSON-LD). Internal links clean (`privacy`, not `.html`). Bump sitemap `lastmod` on page edits.
- Run: `python3 -m http.server 8788 --directory public` (`.claude/launch.json` starts it for the browser pane).

## Working notes

- File < 8 KB.
- Firefox rounds timestamps: use CSS/WAAPI. Mapbox `pk.` push warning: allowed.
- No third-party code in Node.
- Don't reuse `data-mode` outside tabs.
- Browser pane often hidden (animations, rAF frozen): stub `img.decode` (resolve on load), unset `startViewTransition`; finish via `getAnimations()`. New `?t=N` on the URL dodges stale cache. CSP blocks `fetch`: test photos as base64 in `public/_test.js` (script tag), `DataTransfer` on `#file-input`; delete `_test*` before commit. Make test JPEG/HEIC with `sips` from `../Archived/rolls` DNG; no ARW on Mac. Local: no clean URLs (`remove-metadata.html`). `_compare/`: local.

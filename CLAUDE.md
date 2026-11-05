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
  - **Location:** GPS latitude/longitude, altitude, an "open in map" link, and an opt-in "Show map" button (Mapbox static map with a pin).
  - **Image:** pixel dimensions, orientation, color space, ICC profile.
  - **File:** name, size, MIME type, last modified.
  - **Raw:** every tag the parser found, as a flat list at the bottom.
- **No-metadata state:** many images have no metadata, for example screenshots and photos saved from social media or messaging apps. Show a clear, friendly message. Do not show an empty panel.
- **HEIC:** Chrome and Firefox cannot display HEIC. Still read and show its metadata, and show a placeholder in place of the preview.
- **Out of scope for v1:** tag search, copy as JSON, and a "download clean copy" that strips metadata. These are possible later additions. Do not build them unless asked.

## Hard rules

- **Everything runs in the browser.** The photo never leaves the user's machine: no uploads, no analytics on file contents, no backend. This privacy promise is the product's main selling point, so never break it.
- **One exception, opt-in only:** the "Show map" button requests a Mapbox static image, which sends only the photo's coordinates to Mapbox. Never request it before the user clicks, never auto-load it, and keep the note under the button that says what it sends. The public `pk.` token is `MAPBOX_TOKEN` in `app.js` (empty hides the button). It is the Default public token of Mapbox account `johnnythan`, which has no card on file: no URL restrictions (those need a card), 5,000 Static Images requests a month, and no possible charges. Over the limit, the map fails and the OpenStreetMap link remains. The map `<img>` uses `referrerPolicy = 'strict-origin'` so a URL-restricted token also works if one is added later.
- **No build step.** Plain HTML, CSS and JavaScript. Opening `index.html` (or serving the folder statically) must work.
- **Metadata parsing:** use [`exifr`](https://github.com/MikeKovarik/exifr) (EXIF, GPS, IPTC, XMP, ICC, HEIC). Load it from a pinned CDN version, or vendor it into the repo. Do not hand-roll a parser.
- **Revoke object URLs** (`URL.revokeObjectURL`) when the user loads a new photo.

## Design

- Simple and sleek: a lot of whitespace, one accent color, system font stack or one clean web font.
- Support light and dark mode with `prefers-color-scheme` and CSS custom properties.
- Responsive layout: at narrow widths the metadata panel stacks below the preview.
- Format values for people, for example `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`, readable dates, and file sizes in KB/MB. Keep the raw value available in the Raw section.

## Repo and deploy

- **GitHub:** `Johnnythan-3/inspicio`, default branch `main`.
- **Hosting:** Cloudflare Workers static assets (no Worker script), connected to the GitHub repo. Every push to `main` deploys automatically in under a minute. Other branches get preview URLs.
- **Live URL:** https://inspicio.johnnythan.workers.dev
- **Privacy rule for URLs:** the account's workers.dev subdomain is `johnnythan`. It was renamed from one that exposed the owner's email name. Never put the owner's email, or anything derived from it, in URLs, files or commits. Commits use the GitHub noreply address set in this repo's git config.
- The site is fully static, so no server code is needed.

## Status (2026-11-05)

- v1 is live and checked: security headers present, test photos parse, no console errors, light/dark and mobile layouts work.
- **First thing next session:** remind the user to test the live site with their own real photos (a recent iPhone photo, a camera JPEG, a screenshot), and in Safari, the only browser that previews HEIC. Fix whatever they find.
- Not tested yet: real-world photos, Safari, Firefox.
- Possible later work, only if asked: tag search, copy as JSON, "download clean copy" that strips metadata, a custom domain.

## File layout

```
public/                  everything Cloudflare serves
  index.html             page markup and the CSP meta tag
  styles.css             all styles, light/dark tokens, animations
  app.js                 file handling, exifr calls, rendering
  _headers               security headers for Cloudflare
  404.html, favicon.svg
  vendor/                exifr 7.1.3 full UMD build and its MIT license
wrangler.jsonc           Cloudflare static assets config (serves ./public)
```

- The CSP (`default-src 'none'`) blocks every network request from the page except `img-src https://api.mapbox.com` for the opt-in map. Keep it that way, in both `index.html` and `_headers`. It is the proof behind the privacy promise.
- Metadata is untrusted input. Render it with `textContent` (the `el()` helper in `app.js`), never `innerHTML`.
- Run locally: `python3 -m http.server 8788 --directory public`.

## Working notes

- Keep this file under 8 KB.
- Test with a real camera or phone JPEG that has GPS, a screenshot with no metadata, and a HEIC file.

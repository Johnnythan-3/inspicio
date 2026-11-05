# Inspicio

*Inspicio* is Latin for "I look into." It is a simple, sleek website: the user picks or drops a photo from their computer, and the page shows every piece of metadata in that photo.

## Product

- **Empty state:** a large drag-and-drop zone with a click-to-browse fallback.
- **Loaded state:**
  - **Left panel:** metadata, grouped into sections.
  - **Right side:** a large preview of the photo.
- **Metadata groups** (show a group only when it has data):
  - **Camera:** make, model, lens, software.
  - **Exposure:** ISO, shutter speed, aperture, focal length, flash, white balance.
  - **Date/Time:** original capture time, modified time, time zone offset.
  - **Location:** GPS latitude/longitude, altitude, and an "open in map" link.
  - **Image:** pixel dimensions, orientation, color space, ICC profile.
  - **File:** name, size, MIME type, last modified.
  - **Raw:** every tag the parser found, as a flat list at the bottom.
- **No-metadata state:** many images have no metadata, for example screenshots and photos saved from social media or messaging apps. Show a clear, friendly message. Do not show an empty panel.
- **HEIC:** Chrome and Firefox cannot display HEIC. Still read and show its metadata, and show a placeholder in place of the preview.
- **Out of scope for v1:** tag search, copy as JSON, and a "download clean copy" that strips metadata. These are possible later additions. Do not build them unless asked.

## Hard rules

- **Everything runs in the browser.** The photo never leaves the user's machine: no uploads, no analytics on file contents, no backend. This privacy promise is the product's main selling point, so never break it.
- **No build step.** Plain HTML, CSS and JavaScript. Opening `index.html` (or serving the folder statically) must work.
- **Metadata parsing:** use [`exifr`](https://github.com/MikeKovarik/exifr) (EXIF, GPS, IPTC, XMP, ICC, HEIC). Load it from a pinned CDN version, or vendor it into the repo. Do not hand-roll a parser.
- **Revoke object URLs** (`URL.revokeObjectURL`) when the user loads a new photo.

## Design

- Simple and sleek: a lot of whitespace, one accent color, system font stack or one clean web font.
- Support light and dark mode with `prefers-color-scheme` and CSS custom properties.
- Responsive layout: at narrow widths the metadata panel stacks below the preview.
- Format values for people, for example `1/250 s`, `f/2.8`, `ISO 400`, `24 mm`, readable dates, and file sizes in KB/MB. Keep the raw value available in the Raw section.

## Repo and deploy

- **GitHub:** `Jonathankim60420-lgtm/inspicio`, default branch `main`.
- **Hosting:** Cloudflare, connected to the GitHub repo, so every push to `main` deploys automatically. Prefer Workers static assets (a `wrangler.jsonc` with an `assets` directory and no Worker script). Cloudflare Pages is an acceptable fallback.
- The site is fully static, so no server code is needed.

## Planned file layout

```
index.html      page markup
styles.css      all styles
app.js          file handling, exifr calls, rendering
wrangler.jsonc  Cloudflare static assets config (added when deploying)
```

## Working notes

- Keep this file under 8 KB.
- Test with a real camera or phone JPEG that has GPS, a screenshot with no metadata, and a HEIC file.

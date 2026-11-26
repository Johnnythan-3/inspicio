# Inspicio

*Inspicio* is Latin for "I look into."

A simple photo metadata tool that runs entirely in your browser. Drop in a photo to see what it carries, or to wipe it. Live at **[inspicio.app](https://inspicio.app)**.

**Your photo never leaves your device.** There is no server behind the site, no account, no uploads and no analytics. The page's Content Security Policy blocks it from sending anything anywhere, so you don't have to take our word for it: open your browser's network tab, or read the code in [`public/`](public/). The one exception is the map in Inspect, which loads a map image from Mapbox only after you click "Show map".

## The tools

| Tool | What it does |
| --- | --- |
| **Inspect** | Shows everything a photo carries: camera and lens, exposure settings, date and time, GPS location (with a map if you ask), color profile and every raw tag. |
| **Wipe** | Shows what the photo gives away, then saves a clean copy without the location, date, camera details and other hidden data. JPEG and PNG are cleaned without touching the picture, so there is no loss of quality. |

Wipe also has its own page: [remove-metadata](https://inspicio.app/remove-metadata).

## What it reads

- **Formats:** JPEG, HEIC, PNG, TIFF, AVIF, Apple ProRAW (DNG) and camera RAW files (using the preview inside the file).
- **Metadata:** EXIF, GPS, IPTC, XMP and ICC.

It works on phones too. On an iPhone, Wipe can save straight to Photos.

## How it's built

- Plain HTML, CSS and JavaScript. No framework and no build step: the files in `public/` are the site.
- Metadata is read with [exifr](https://github.com/MikeKovarik/exifr). HEIC photos in Chrome and Firefox are decoded with [libheif](https://github.com/strukturag/libheif). Safari reads HEIC on its own.
- Hosted on Cloudflare as static files (`wrangler.jsonc`). Every push to `main` deploys.

## Run it locally

```bash
python3 -m http.server 8788 --directory public
```

Then open <http://localhost:8788>.

The Wipe page (`remove-metadata.html`) is made from `index.html`. After changing `index.html` or the tool text in `app.js`, run:

```bash
node tools/pages/make-pages.js
```

## Archived tools

Inspicio used to have two more tools: Shot on (a frame with the camera and settings under the photo) and Film (a Kodak Portra 400 film look). They were taken off the site in November 2026 to keep it about metadata. Their code is kept in [`archived/`](archived/README.md) and is not part of the site.

## Security

Found a problem? Please email the address in [security.txt](https://inspicio.app/.well-known/security.txt).

## License

Inspicio is [MIT](LICENSE) licensed. Third-party code and fonts in `public/vendor/` keep their own licenses, which sit next to each file: exifr (MIT), libheif (LGPL), and the fonts Geist and Departure Mono (SIL Open Font License).

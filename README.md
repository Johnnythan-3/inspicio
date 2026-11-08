# Inspicio

*Inspicio* is Latin for "I look into."

A simple photo toolbox that runs entirely in your browser. Drop in a photo and pick a tool. Live at **[inspicio.app](https://inspicio.app)**.

**Your photo never leaves your device.** There is no server behind the site, no account, no uploads and no analytics. The page's Content Security Policy blocks it from sending anything anywhere, so you don't have to take our word for it: open your browser's network tab, or read the code in [`public/`](public/). The one exception is the map in Inspect, which loads a map image from Mapbox only after you click "Show map".

## The tools

| Tool | What it does |
| --- | --- |
| **Inspect** | Shows everything a photo carries: camera and lens, exposure settings, date and time, GPS location (with a map if you ask), color profile and every raw tag. |
| **Wipe** | Shows what the photo gives away, then saves a clean copy without the location, date, camera details and other hidden data. JPEG and PNG are cleaned without touching the picture, so there is no loss of quality. |
| **Shot on** | Puts the camera and settings under your photo as a frame, ready to post. Light, dark or pixel style; serif, wide or digital camera font; original, square or 4:5 shape. |
| **Film** | Develops the photo like real film: Kodak Portra 400, printed on paper and scanned, built from Kodak's datasheets. Halation, grain, exposure and brightness controls, and an optional border. |

Each tool also has its own page: [remove-metadata](https://inspicio.app/remove-metadata), [shot-on-frame](https://inspicio.app/shot-on-frame) and [film-filter](https://inspicio.app/film-filter).

## What it reads

- **Formats:** JPEG, HEIC, PNG, TIFF, AVIF, Apple ProRAW (DNG) and camera RAW files (using the preview inside the file).
- **Metadata:** EXIF, GPS, IPTC, XMP and ICC.
- **HDR:** the HDR gain maps that iPhones and Android phones save, used by Film for a more faithful result.

It works on phones too. On an iPhone, Wipe, Shot on and Film can save straight to Photos.

## How it's built

- Plain HTML, CSS and JavaScript. No framework and no build step: the files in `public/` are the site.
- Metadata is read with [exifr](https://github.com/MikeKovarik/exifr). HEIC photos in Chrome and Firefox are decoded with [libheif](https://github.com/strukturag/libheif). Safari reads HEIC on its own.
- The film engine (`film.js`) is a JavaScript port of a Swift film engine. It splits the work across your processor cores in Web Workers, so a 16 MP photo develops in about two seconds.
- Hosted on Cloudflare as static files (`wrangler.jsonc`). Every push to `main` deploys.

## Run it locally

```bash
python3 -m http.server 8788 --directory public
```

Then open <http://localhost:8788>.

The tool pages (`remove-metadata.html` and the others) are made from `index.html`. After changing `index.html` or the tool text in `app.js`, run:

```bash
node tools/pages/make-pages.js
```

`tools/film/` holds the scripts that rebuild the film data and check the JavaScript engine against the Swift original. See [its README](tools/film/README.md).

## Security

Found a problem? Please email the address in [security.txt](https://inspicio.app/.well-known/security.txt).

## License

Inspicio is [MIT](LICENSE) licensed. Third-party code and fonts in `public/vendor/` keep their own licenses, which sit next to each file: exifr (MIT), libheif (LGPL), and the fonts Geist, Departure Mono, Fraunces, Michroma and DSEG (SIL Open Font License).

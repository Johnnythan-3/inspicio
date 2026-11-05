# Inspicio

Drop in a photo and see all of its metadata: camera, exposure settings, date and time, GPS location, color profile and every raw tag.

**Your photo never leaves your browser.** Inspicio has no backend and makes no uploads. The page's Content Security Policy blocks all network requests from the page, so you don't have to take our word for it: read the code in [`public/`](public/).

## How it works

- Plain HTML, CSS and JavaScript. No framework and no build step.
- Metadata is read with [exifr](https://github.com/MikeKovarik/exifr) 7.1.3 (MIT), vendored in `public/vendor/`.
- Supports EXIF, GPS, IPTC, XMP and ICC data in JPEG, HEIC, PNG, TIFF and AVIF files.
- Hosted on Cloudflare as static assets (`wrangler.jsonc`).

## Run locally

```bash
python3 -m http.server 8788 --directory public
```

Then open <http://localhost:8788>.

## License

[MIT](LICENSE)

# Archived tools

On 2026-11-26 Inspicio went back to being about photo metadata only (Inspect and Wipe). Two tools
were taken off the site: **Shot on** (the frame with the camera and settings under the photo) and
**Film** (the Kodak Portra 400 look, with its own Frame border). Film is moving to a separate site.

Nothing here is served: Cloudflare only publishes `public/`. No code was deleted; it was moved here.
The last commit with both tools live is `5d72e1c` (`git show 5d72e1c:public/app.js`).

## What is where

- `frames/`: Shot on.
  - `app-shot-on.js`: its part of `app.js` (card layout, drawing, panel, save).
  - `shot-on-frame.html`: its page.
  - `fonts/`: Fraunces, Michroma and DSEG14, used only by the card, with their licenses.
- `film/`: Film.
  - `film.js`, `film-worker.js`, `film-data.js`: the film engine, unchanged.
  - `gainmap.js` and `heif-worker.with-gainmap.js`: HDR gain map reading (the live `heif-worker.js`
    now only decodes HEIC).
  - `app-film.js`: its part of `app.js` (worker, preview, sliders, Frame border, save).
  - `film-filter.html`: its page.
  - `tools/`: data rebuild, Swift compare, benchmark and the Portra calibration
    (`node archived/film/tools/portra/fit.js check` still runs from here; the other scripts take
    the folder with `film.js` as an argument).
- `shared/`: what both tools used, and the site as it was.
  - `app-saving.js`: the save overlay and its progress bar.
  - `app-phone-editor.js`: the phone photo editor (tool strip, sliders).
  - `styles-removed.css`: every CSS rule that was cut, in its old order.
  - `app.before.js`, `styles.before.css`, `index.before.html`, `make-pages.before.js`,
    `llms.before.txt`: the whole files from before the cut.

## Bringing a tool back

The `app-*.js` files are pieces from inside `app.js`'s one function, so they do not run alone.
The simplest way back is to start from the `*.before.*` files (or the commit above) and move the
engine files and fonts into `public/` again. Also restore the tab in `index.html`, the entry in
`MODES`, the page in `tools/pages/make-pages.js`, the sitemap line, and remove the tool's lines
from `public/_redirects`.

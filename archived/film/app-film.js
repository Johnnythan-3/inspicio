// Film: the tool's side in app.js (worker, preview, sliders, frame border, save).
// Cut from public/app.js on 2026-11-26, when Inspicio went back to metadata only.
// These lines sat inside the app's one big function, so they do not run alone: to bring
// the tool back, paste them into app.js again (archived/shared/app.before.js shows where).

// ---- app.js lines 2210-2795 ----
  /* ---------- Film: develop the photo like Kodak Portra 400 ---------- */

  // The rolls film engine (film.js) runs in a worker (film-worker.js), loaded the first time
  // this tab is used. A preview is developed at about 1.4 megapixels and re-developed as the
  // sliders move; saving develops the full photo. All of it on this device.
  const FILM_PREVIEW_PIXELS = 1.4e6;
  const FILM_SAVE_PIXELS = window.matchMedia('(pointer: coarse)').matches ? 8e6 : 16e6;

  let filmWorker = null;
  let filmSeq = 0;
  const filmJobs = new Map();

  let filmWorkerGen = 0; // which worker; a new one has to be sent a DNG's bytes again
  // On this computer (development), the worker and the engine files it loads are fetched fresh on
  // every page load: a reload doesn't refresh a worker's scripts, so an old engine could linger.
  const FILM_FRESH = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? `?t=${Date.now()}` : '';

  function filmWorkerReady() {
    if (!filmWorker) {
      filmWorkerGen++;
      filmWorker = new Worker(`film-worker.js${FILM_FRESH}`);
      filmWorker.onmessage = (e) => {
        const job = filmJobs.get(e.data.id);
        if (!job) return;
        if (!e.data.done && !e.data.error) {
          job.onStage?.(e.data.stage);
          return;
        }
        filmJobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
      };
      filmWorker.onerror = (e) => {
        e.preventDefault?.();
        for (const job of filmJobs.values()) job.reject(new Error('The film engine couldn’t start.'));
        filmJobs.clear();
        filmWorker?.terminate();
        filmWorker = null;
      };
    }
    return filmWorker;
  }

  // Calls off a develop nobody needs any more (a full-detail one), by the `track` given to
  // filmJob. The worker stays, with the preview's negative, so the preview that follows doesn't
  // start from nothing.
  function filmAbort(track) {
    if (filmWorker && track?.id && filmJobs.has(track.id)) filmWorker.postMessage({ kind: 'abort', id: track.id });
  }

  // `track` (optional): an object that is given the job's id, for filmAbort.
  function filmRun(message, transfer, onStage, track) {
    const worker = filmWorkerReady();
    const id = ++filmSeq;
    if (track) track.id = id;
    return new Promise((resolve, reject) => {
      filmJobs.set(id, { resolve, reject, onStage });
      worker.postMessage({ id, ...message }, transfer);
    });
  }

  // The photo's pixels at up to `maxPixels`, upright, in Display P3 where the browser can
  // read it (iPhone photos are P3), otherwise sRGB.
  function filmPixels(img, maxPixels) {
    const scale = Math.min(1, Math.sqrt(maxPixels / (img.width * img.height)));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let ctx = null;
    try { ctx = canvas.getContext('2d', { colorSpace: 'display-p3', willReadFrequently: true }); } catch { ctx = null; }
    ctx ||= canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.probe, 0, 0, width, height);
    let data;
    try { data = ctx.getImageData(0, 0, width, height, { colorSpace: 'display-p3' }); } catch { data = ctx.getImageData(0, 0, width, height); }
    canvas.width = 0;
    return { pixels: data.data.buffer, width, height, primaries: data.colorSpace === 'display-p3' ? 'displayP3' : 'sRGB' };
  }

  let film = null; // the open photo's film settings and preview state
  let filmKeySeq = 0;

  // Where Brightness starts for a photo developed from sensor data. It was -0.2 while the look
  // lifted a RAW print's blacks, which read as too bright; with deep blacks the lab's own print
  // matches the camera's rendering at 0 (medians within a few levels on the test frames).
  const FILM_RAW_BRIGHTNESS = 0;

  function filmFor(file, img) {
    if (film?.file !== file) {
      const brightness = /\.dng$/i.test(file.name) ? FILM_RAW_BRIGHTNESS : 0;
      film = { file, img, key: ++filmKeySeq, exposure: 0, brightness, highlights: 0, shadows: 0, source: null,
        // Where a double-click puts each slider back.
        rest: { exposure: 0, brightness, highlights: 0, shadows: 0 },
        canvas: null, caption: null, original: null, busy: false, again: false, saving: false,
        // A DNG is developed from its sensor data when the worker can read it ('maybe' until
        // it has tried); everything else, and a DNG it can't read, from the finished picture.
        raw: /\.dng$/i.test(file.name) ? 'maybe' : 'no', rawGen: -1,
        // The photo's HDR gain map (iPhone HEIC, HDR JPEG), read once when first developed.
        gain: null, gainGen: -1, hdr: false };
    }
    return film;
  }

  // The photo's HDR gain map, or null. iPhone photos from iOS 18 on have one: it says how much
  // brighter each part of the photo is in its HDR version, which is the highlight detail the
  // finished picture had to give up.
  function filmGainMap(f) {
    const heif = isHeif(f.file);
    f.gain ||= (heif ? f.file.arrayBuffer().then((buffer) => decodeHeif(buffer, 'gainmap'))
      : RAW_EXT.test(f.file.name) ? Promise.resolve(null) : jpegGainMap(f.file))
      .then((r) => (r && !r.none ? { data: r.gain, width: r.width, height: r.height, meta: r.meta } : null))
      .catch(() => null)
      .then((map) => {
        if (map && !f.hdr) {
          f.hdr = true;
          filmShowSource(f);
        }
        return map;
      });
    return f.gain;
  }

  // A JPEG's HDR gain map (iPhone, Android Ultra HDR, Lightroom), as grey values from 0 to 255,
  // turned upright like the photo. The gain map is decoded without its color profile: its values
  // are gains, not colors. Null when there is none.
  async function jpegGainMap(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const found = findJpegGainMap(bytes);
    if (!found) return null;
    let orientation = 1;
    try { orientation = (await window.exifr.orientation(file)) || 1; } catch { orientation = 1; }
    const bitmap = await createImageBitmap(new Blob(stripJpeg(found.jpeg, undefined, false), { type: 'image/jpeg' }));
    const sw = bitmap.width;
    const sh = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const rgba = ctx.getImageData(0, 0, sw, sh).data;
    canvas.width = 0;
    // EXIF orientation: 5 to 8 swap width and height. For each upright pixel, where it is stored.
    const swap = orientation >= 5 && orientation <= 8;
    const width = swap ? sh : sw;
    const height = swap ? sw : sh;
    const from = [null,
      (x, y) => [x, y], (x, y) => [sw - 1 - x, y], (x, y) => [sw - 1 - x, sh - 1 - y], (x, y) => [x, sh - 1 - y],
      (x, y) => [y, x], (x, y) => [y, sh - 1 - x], (x, y) => [sw - 1 - y, sh - 1 - x], (x, y) => [sw - 1 - y, x],
    ][orientation] || ((x, y) => [x, y]);
    const gain = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [u, v] = from(x, y);
        gain[y * width + x] = rgba[(v * sw + u) * 4];
      }
    }
    return { gain, width, height, meta: found.meta };
  }

  const FILM_HIGHLIGHTS_MAX = 5; // the Highlights and Shadows sliders run from minus this to plus this
  const fmtStops = (v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`);

  // One develop, from the DNG's sensor data or from the finished picture.
  async function filmJob(f, maxPixels, keep, onStage, track) {
    const settings = { key: f.key, exposureStops: f.exposure, printStops: -f.brightness,
      highlights: f.highlights / FILM_HIGHLIGHTS_MAX, shadows: f.shadows / FILM_HIGHLIGHTS_MAX,
      look: filmPrefs.look / 100, keep };
    for (let attempt = 0; f.raw !== 'no' && attempt < 2; attempt++) {
      try {
        filmWorkerReady();
        const msg = { kind: 'raw', maxPixels, ...settings };
        const transfer = [];
        if (f.rawGen !== filmWorkerGen) {
          msg.file = await f.file.arrayBuffer();
          transfer.push(msg.file);
          f.rawGen = filmWorkerGen;
        }
        const res = await filmRun(msg, transfer, onStage, track);
        f.raw = 'yes';
        return res;
      } catch (err) {
        if (err.message === 'cancelled') throw err;
        if (err.message === 'need-file') { f.rawGen = -1; continue; }
        f.raw = 'no';
        // Not sensor data after all: Brightness goes back to 0 unless it has been moved.
        if (f.brightness === f.rest.brightness && f.brightness !== 0) {
          f.brightness = 0;
          settings.printStops = 0;
        }
        f.rest.brightness = 0;
        f.syncSliders?.();
        filmShowSource(f);
      }
    }
    const gain = await filmGainMap(f);
    for (let attempt = 0; ; attempt++) {
      const src = keep ? (f.source ||= filmPixels(f.img, FILM_PREVIEW_PIXELS)) : filmPixels(f.img, maxPixels);
      const pixels = keep ? src.pixels.slice(0) : src.pixels;
      const msg = { ...settings, pixels, width: src.width, height: src.height, primaries: src.primaries, placement: 'photo' };
      if (gain) {
        // The worker keeps the gain map; a new worker is sent it again.
        filmWorkerReady();
        msg.useGain = true;
        if (f.gainGen !== filmWorkerGen) msg.gain = gain;
        f.gainGen = filmWorkerGen;
      }
      try {
        return await filmRun(msg, [pixels], onStage, track);
      } catch (err) {
        if (err.message !== 'need-gain' || attempt) throw err;
        f.gainGen = -1;
      }
    }
  }

  const FILM_STEPS = ['exposing', 'halation', 'sharpness', 'curves', 'couplers', 'grain', 'printing'];

  // The finished caption, guessed before the first develop, so the bar can take its width.
  function filmCaptionGuess(f) {
    if (f.captionText) return f.captionText;
    const raw = f.raw !== 'no';
    const full = Math.min(1, Math.sqrt(FILM_SAVE_PIXELS / (f.img.width * f.img.height)));
    const { width, height } = framedSize(Math.round(f.img.width * full), Math.round(f.img.height * full));
    return `Portra 400${raw ? ' from RAW' : isHeif(f.file) ? ' with HDR' : ''}  ·  saves at ${width} × ${height}`;
  }

  // Sizes the caption to `text`'s real width, measured with a hidden copy once it's on the page.
  function filmCaptionWidth(f, text) {
    const cap = f.caption;
    if (!cap) return;
    cap.style.setProperty('--cap-ch', String(text.length));
    const measure = () => {
      if (!cap.isConnected || !cap.parentNode) return false;
      const probe = el('span', { class: 'cap-measure', 'aria-hidden': 'true' }, text);
      cap.parentNode.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      if (w > 0) cap.style.setProperty('--cap-w', `${w}px`);
      return true;
    };
    if (!measure()) requestAnimationFrame(measure);
  }

  // The caption while the film develops: a thin bar that fills, as wide as the finished caption,
  // so the box keeps its size and nothing in it moves.
  function filmCaptionBar(f, steps, megapixels, base) {
    f.capBar?.stop();
    f.capBar = null;
    if (!f.caption) return null;
    const fill = el('span', { class: 'cap-fill' });
    f.caption.replaceChildren(el('span', { class: 'cap-bar', role: 'progressbar', 'aria-label': 'Developing' }, fill));
    filmCaptionWidth(f, filmCaptionGuess(f));
    f.caption.classList.add('is-progress');
    f.capBar = barController({ fill, steps, megapixels, base });
    return f.capBar;
  }

  // Takes a bar that is still up off the caption (its develop was called off).
  function filmCaptionIdle(f) {
    if (!f.capBar || !f.caption) return;
    f.capBar.stop();
    f.capBar = null;
    f.caption.classList.remove('is-progress');
    f.caption.textContent = f.captionText || '';
  }

  function filmCaptionDone(f, bar, text) {
    if (!bar || f.capBar !== bar) return;
    bar.finish(160);
    setTimeout(() => {
      if (f.capBar !== bar || !f.caption) return;
      f.capBar = null;
      bar.stop();
      f.caption.classList.remove('is-progress');
      f.caption.textContent = text;
    }, reduceMotion.matches ? 0 : 200);
  }

  async function filmPreview() {
    const f = film;
    if (!f || !f.canvas || !f.img.ok) return;
    if (f.busy) { f.again = true; return; }
    if (f.detail && f.detail.settings !== filmSettings(f)) {
      // The sliders moved: the full-detail film is out of date. Stop developing it, unless it is
      // being saved, so the preview doesn't wait behind it.
      if (f.detail.running && !f.saving) filmAbort(f.detail.track);
      f.detail = null;
      filmShowDetail(f);
    }
    f.busy = true;
    f.again = false;
    // Only Brightness, Highlights or Shadows moved since the last develop: the worker prints the negative
    // it kept again, which is at once. So no bar, and the picture isn't dimmed while it waits.
    const negative = `${f.exposure}|${filmPrefs.look}`;
    const reprint = Boolean(filmWorker) && f.developed === `${negative}|${filmWorkerGen}`;
    // The bar is for a photo's first develop only. After that a slider moved: the picture on
    // screen dims a little until the new one is in, and the caption stays as it is.
    const first = !f.canvas.classList.contains('is-ready');
    let bar = null;
    if (!reprint) f.stage?.classList.add('is-developing');
    if (first) {
      bar = filmCaptionBar(f, [f.raw !== 'no' ? 'reading' : 'prepare', ...FILM_STEPS], FILM_PREVIEW_PIXELS / 1e6, 15);
      bar?.step(f.raw !== 'no' ? 'reading' : 'prepare');
    } else {
      filmCaptionIdle(f);
    }
    try {
      const res = await filmJob(f, FILM_PREVIEW_PIXELS, true, (stage) => bar?.step(stage));
      f.developed = `${negative}|${filmWorkerGen}`;
      if (film !== f || !f.canvas) return;
      f.canvas.width = res.width;
      f.canvas.height = res.height;
      f.canvas.getContext('2d').putImageData(new ImageData(res.rgba, res.width, res.height), 0, 0);
      f.canvas.classList.add('is-ready');
      let saveW;
      let saveH;
      if (res.raw) {
        const ds = Math.max(1, Math.ceil(Math.sqrt((res.fullWidth * res.fullHeight) / FILM_SAVE_PIXELS)));
        [saveW, saveH] = [Math.floor(res.fullWidth / ds), Math.floor(res.fullHeight / ds)];
      } else {
        const full = Math.min(1, Math.sqrt(FILM_SAVE_PIXELS / (f.img.width * f.img.height)));
        [saveW, saveH] = [Math.round(f.img.width * full), Math.round(f.img.height * full)];
      }
      f.saveW = saveW;
      f.saveH = saveH;
      // A DNG developed from its sensor data can have a different shape than its preview.
      filmApplyFrame(f);
      f.captionBase = `Portra 400${res.raw ? ' from RAW' : f.hdr ? ' with HDR' : ''}`;
      filmCaption(f);
      filmCaptionDone(f, bar, f.captionText);
    } catch (err) {
      f.developed = null;
      if (bar) filmCaptionDone(f, bar, 'Couldn’t develop this photo');
      else if (f.caption) f.caption.textContent = 'Couldn’t develop this photo';
      if (f.note) f.note.textContent = String(err.message || err);
    } finally {
      f.busy = false;
      f.stage?.classList.remove('is-developing');
      if (f.again && film === f) filmPreview();
      else filmWantDetail(f, true);
    }
  }

  const filmSettings = (f) => `${f.exposure}|${f.brightness}|${f.highlights}|${f.shadows}|${filmPrefs.look}`;

  // Full detail: the film developed at its saved size. The preview is about 1.4 megapixels, so
  // once it is zoomed in past its own pixels this is developed in the background and replaces it,
  // until a slider moves. Saving uses it too, so a save after zooming is instant.
  // `quiet`: no caption bar. The develop that follows a preview on its own is quiet, so a new photo
  // or a moved slider runs the bar once, not once for the preview and again for the detail.
  function filmDetail(f, quiet = false) {
    const settings = filmSettings(f);
    if (f.detail?.settings === settings) return f.detail.promise;
    const detail = { settings, canvas: null, running: true, track: {} };
    f.detail = detail;
    const bar = quiet ? null : filmCaptionBar(f, [f.raw !== 'no' ? 'reading' : 'prepare', ...FILM_STEPS],
      (f.saveW && f.saveH ? f.saveW * f.saveH : FILM_SAVE_PIXELS) / 1e6, 60);
    bar?.step(f.raw !== 'no' ? 'reading' : 'prepare');
    const onStage = (stage) => {
      if (f.saving) f.saveStage?.(stage);
      if (f.detail === detail) bar?.step(stage);
    };
    detail.promise = filmJob(f, FILM_SAVE_PIXELS, false, onStage, detail.track).then((res) => {
      const canvas = el('canvas', { class: 'film-canvas film-detail is-ready' });
      canvas.width = res.width;
      canvas.height = res.height;
      canvas.getContext('2d').putImageData(new ImageData(res.rgba, res.width, res.height), 0, 0);
      detail.canvas = canvas;
      return { canvas, width: res.width, height: res.height };
    }).finally(() => {
      detail.running = false;
      if (f.detail !== detail) return;
      if (!detail.canvas) f.detail = null;
      filmCaptionDone(f, bar, f.captionText || '');
      filmShowDetail(f);
    });
    return detail.promise;
  }

  // Puts the full-detail film over the preview when it matches the sliders; removes it otherwise.
  function filmShowDetail(f) {
    if (!f.stage) return;
    const d = f.detail;
    const on = d?.canvas && d.settings === filmSettings(f) ? d.canvas : null;
    for (const c of f.stage.querySelectorAll('.film-detail')) if (c !== on) c.remove();
    if (on && on.parentNode !== f.stage) f.canvas.after(on);
  }

  // Asks for full detail once zooming settles past the preview's own pixels.
  // `quiet` as in filmDetail. A zoom still waiting when a quiet request comes keeps its bar.
  function filmWantDetail(f, quiet = false) {
    clearTimeout(f.detailTimer);
    if (!quiet) f.detailLoud = true;
    f.detailTimer = setTimeout(() => {
      quiet = !f.detailLoud;
      f.detailLoud = false;
      if (film !== f || !f.frame || !f.canvas || f.busy || !f.saveW) return;
      const shown = f.frame.clientWidth * (f.zoomScale || 1) * (window.devicePixelRatio || 1);
      if (f.saveW > f.canvas.width * 1.1 && shown > f.canvas.width * 1.25) filmDetail(f, quiet).catch(() => {});
    }, 350);
  }

  // The Frame option: a plain white or black border around the print, as wide as a share of the
  // photo's shorter side. A display preference, so it is remembered.
  // Strength (look, 0 to 100): how far the develop leans into the film's look (FilmEngine.look).
  // 0 is the film as calibrated, which leaves a finished photo close to itself. It was a slider;
  // the user settled on one strength for every photo, so it is fixed at FILM_LOOK_DEFAULT.
  const FILM_KEY = 'inspicio.film';
  const FRAME_COLORS = { white: '#ffffff', black: '#000000' };
  const FILM_LOOK_DEFAULT = 30;
  const filmPrefs = (() => {
    const prefs = { frame: false, frameColor: 'white', frameSize: 5, look: FILM_LOOK_DEFAULT };
    try {
      const saved = JSON.parse(localStorage.getItem(FILM_KEY) || '{}');
      if (typeof saved.frame === 'boolean') prefs.frame = saved.frame;
      if (FRAME_COLORS[saved.frameColor]) prefs.frameColor = saved.frameColor;
      if (saved.frameSize >= 1 && saved.frameSize <= 20) prefs.frameSize = Number(saved.frameSize);
    } catch { /* storage blocked or bad value */ }
    return prefs;
  })();
  const saveFilmPrefs = () => {
    try { localStorage.setItem(FILM_KEY, JSON.stringify(filmPrefs)); } catch { /* fine */ }
  };
  const framePx = (w, h) => (filmPrefs.frame ? Math.round((Math.min(w, h) * filmPrefs.frameSize) / 100) : 0);
  // The saved size with the frame: scaled down as a whole if it would pass Safari's canvas limit.
  const FRAMED_MAX = 16e6;
  function framedSize(w, h) {
    const b = framePx(w, h);
    const k = Math.min(1, Math.sqrt(FRAMED_MAX / ((w + 2 * b) * (h + 2 * b))));
    return { b: b * k, k, width: Math.round((w + 2 * b) * k), height: Math.round((h + 2 * b) * k) };
  }

  function filmCaption(f) {
    if (!f.caption || !f.captionBase || !f.saveW) return;
    const { width, height } = framedSize(f.saveW, f.saveH);
    f.captionText = `${f.captionBase}  ·  saves at ${width} × ${height}`;
    if (!f.capBar) f.caption.textContent = f.captionText;
    else filmCaptionWidth(f, f.captionText);
  }

  // Shows the frame in the stage: the print sits inset in a box of the frame's colour, and the
  // zoom frame takes the framed shape.
  function filmApplyFrame(f) {
    if (!f.stage || !f.canvas) return;
    const w = f.canvas.width;
    const h = f.canvas.height;
    const b = filmPrefs.frame ? (Math.min(w, h) * filmPrefs.frameSize) / 100 : 0;
    f.stage.style.setProperty('--fx', String(b / (w + 2 * b)));
    f.stage.style.setProperty('--fy', String(b / (h + 2 * b)));
    f.stage.style.setProperty('--frame-color', FRAME_COLORS[filmPrefs.frameColor]);
    f.stage.classList.toggle('has-frame', b > 0);
    if (f.frame && stageZoom) reshape(f.frame, stageZoom, (w + 2 * b) / (h + 2 * b), f.saveW || f.img.width);
    filmCaption(f);
  }

  function buildFilmStage() {
    const f = film;
    f.canvas = el('canvas', { class: 'film-canvas' });
    // Sized like the preview from the start, so the frame doesn't jump when the film arrives.
    const scale = Math.min(1, Math.sqrt(FILM_PREVIEW_PIXELS / (f.img.width * f.img.height)));
    f.canvas.width = Math.max(1, Math.round(f.img.width * scale));
    f.canvas.height = Math.max(1, Math.round(f.img.height * scale));
    f.original = el('img', { class: 'film-original', src: currentUrl, alt: '', 'aria-hidden': 'true', draggable: 'false' });
    f.caption = el('span', null, '');
    f.capBar = null;
    f.stage = el('div', { class: 'film-frame' }, el('div', { class: 'film-print' }, f.canvas, f.original));
    stageZoom?.stop();
    f.zoomScale = 1;
    const z = zoomable(f.stage, { ar: f.canvas.width / f.canvas.height, natW: f.img.width,
      label: 'The photo developed on Portra 400.',
      pixels: () => Math.max(f.canvas?.width || 1, f.saveW || 0),
      full: () => {
        const w = f.saveW || f.img.width;
        return w + 2 * framePx(w, f.saveH || f.img.height);
      },
      // The zoom reports on every layout change too; only a real zoom shows the caption bar.
      onZoom: (scale) => {
        const zoomed = scale !== f.zoomScale;
        f.zoomScale = scale;
        filmWantDetail(f, !zoomed);
      } });
    f.frame = z.frame;
    stageZoom = z.zoom;
    filmApplyFrame(f);
    filmShowDetail(f);
    filmPreview();
    return el('figure', { class: 'photo film-stage' }, z.frame, el('figcaption', null, f.caption, z.controls));
  }

  function filmSourceNote(f, meta) {
    const { file } = f;
    const { get } = indexMetadata(meta.segments);
    const apple = /apple/i.test(String(toText(get('Make')) || ''));
    const model = toText(get('Model'));
    if (f.raw !== 'no') {
      return [`${model || 'DNG'} · ${apple ? 'ProRAW' : 'RAW'}`,
        'Developed from the sensor’s own light, before any of the camera’s processing, the way the rolls camera does it.'];
    }
    if (RAW_EXT.test(file.name)) {
      return [`${model || 'RAW file'} · built-in preview`, /\.dng$/i.test(file.name)
        ? 'This DNG’s sensor data is in a format the film can’t read yet, so this uses the JPEG preview inside the file.'
        : 'Browsers can’t read this camera’s RAW format, so this uses the JPEG preview inside the file.'];
    }
    if (f.hdr) {
      return [`${model || 'Photo'} · HDR photo`,
        apple
          ? 'Your iPhone already processed this photo, so the film goes on top of Apple’s look. Its HDR gain map gives the film back the highlights. Close, not exact.'
          : 'The camera already processed this photo, so the film goes on top of its look. Its HDR gain map gives the film back the highlights. Close, not exact.'];
    }
    return [`${model || 'Photo'} · finished photo`, apple
      ? 'Your iPhone already processed this photo, so the film goes on top of Apple’s look. Close, not exact.'
      : 'The camera already processed this photo, so the film goes on top of its look. Close, not exact.'];
  }

  function filmShowSource(f) {
    if (!f.sourceNode) return;
    const [title, text] = filmSourceNote(f, f.meta);
    f.sourceNode.replaceChildren(el('strong', null, title), el('p', null, text));
  }

  async function saveFilm(button, note) {
    const f = film;
    if (!f?.img.ok || f.saving) return;
    f.saving = true;
    button.disabled = true;
    // Already developed at full detail (zoomed in) for these settings: only the JPEG is left.
    const ready = Boolean(f.detail?.canvas) && f.detail.settings === filmSettings(f);
    const pixels = f.saveW && f.saveH ? f.saveW * f.saveH : Math.min(FILM_SAVE_PIXELS, f.img.width * f.img.height);
    const steps = ready ? ['encoding']
      : [f.raw !== 'no' ? 'reading' : 'prepare', 'exposing', 'halation', 'sharpness', 'curves', 'couplers', 'grain', 'printing', 'encoding'];
    let cancelled = false;
    const progress = saveProgress({ eyebrow: 'Developing · Portra 400', steps, megapixels: pixels / 1e6, learn: !ready });
    progress.cancellable(ready ? null : () => {
      cancelled = true;
      if (f.detail?.running) filmAbort(f.detail.track);
    });
    f.saveStage = (stage) => progress.step(stage);
    progress.step(steps[0]);
    try {
      await settled();
      const res = await filmDetail(f);
      if (cancelled) throw new Error('cancelled');
      progress.cancellable(null);
      progress.step('encoding');
      await painted();
      // The frame, if on, goes around the developed photo here.
      let out = res.canvas;
      const framed = framedSize(res.width, res.height);
      if (framed.b) {
        out = document.createElement('canvas');
        out.width = framed.width;
        out.height = framed.height;
        const ctx = out.getContext('2d');
        ctx.fillStyle = FRAME_COLORS[filmPrefs.frameColor];
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(res.canvas, framed.b, framed.b, res.width * framed.k, res.height * framed.k);
      }
      const { width, height } = out;
      const blob = await toJpeg(out, 0.92);
      if (out !== res.canvas) out.width = 0;
      if (!blob) throw new Error('This browser couldn’t save the photo.');
      if (f.url) URL.revokeObjectURL(f.url);
      f.url = URL.createObjectURL(blob);
      const name = `${baseName(f.file.name)}-portra400.jpg`;
      const size = `${width} × ${height}, ${fmtBytes(blob.size)}`;
      deliver(progress, blob, f.url, name, `${name} · ${size}`);
      note.textContent = `Saved ${name}, ${size}. Developed on this device.`;
    } catch (err) {
      if (cancelled || err.message === 'cancelled') {
        progress.close();
        note.textContent = 'Save cancelled.';
      } else {
        progress.fail(String(err.message || err));
        note.textContent = `Couldn’t save: ${String(err.message || err)}`;
      }
    }
    f.saveStage = null;
    f.saving = false;
    button.disabled = false;
  }


// ---- app.js lines 3149-3275 ----
  function buildFilmPanel(file, meta, img) {
    const f = filmFor(file, img);
    if (img.ok && narrowLayout.matches) return buildFilmEditor(f, meta);
    const nodes = [el('div', { class: 'summary' },
      el('p', { class: 'summary-eyebrow', title: file.name }, file.name),
      el('h1', { class: 'summary-title' }, 'Portra 400'),
      el('p', { class: 'summary-sub' }, 'Kodak’s film from its own datasheet, printed like a Noritsu lab print.'),
    )];
    if (!img.ok) {
      nodes.push(notice('Can’t develop this photo', /\.(heic|heif)$/i.test(file.name)
        ? 'This HEIC photo couldn’t be decoded here. Save it as a JPEG and try again.'
        : 'This browser can’t show this photo, so it can’t develop it.'));
      return nodes;
    }

    f.meta = meta;
    f.sourceNode = el('div', { class: 'film-source' });
    filmShowSource(f);
    nodes.push(f.sourceNode);

    // Each slider goes back to where it started on a double-click.
    const syncs = [];
    f.syncSliders = () => syncs.forEach((sync) => sync());
    const slider = (label, key, min, max, step, help) => {
      const value = el('span', { class: 'film-value' }, fmtStops(f[key]));
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label });
      input.value = String(f[key]);
      input.addEventListener('input', () => {
        f[key] = Number(input.value);
        value.textContent = fmtStops(f[key]);
        filmPreview();
      });
      syncs.push(() => { input.value = String(f[key]); value.textContent = fmtStops(f[key]); });
      input.addEventListener('dblclick', () => {
        input.value = String(f.rest[key]);
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
      return el('label', { class: 'card-row film-slider' },
        el('span', { class: 'card-label' }, label, value), input, el('small', null, help));
    };

    const compare = el('button', { class: 'map-link film-compare', type: 'button' }, 'Hold to see the original');
    const show = (on) => {
      f.stage?.classList.toggle('show-original', on);
      document.documentElement.classList.toggle('is-comparing', on);
      compare.classList.toggle('is-held', on);
    };
    compare.addEventListener('pointerdown', () => show(true));
    // A long press on iOS would otherwise select text and open the callout menu.
    compare.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    compare.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) compare.addEventListener(type, () => show(false));
    compare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') show(true); });
    compare.addEventListener('keyup', () => show(false));

    const save = el('button', { class: 'map-link wipe-save', type: 'button' }, icon('file'), 'Save photo');
    const note = el('p', { class: 'map-note' }, 'Developed on this device at up to '
      + `${Math.round(FILM_SAVE_PIXELS / 1e6)} megapixels. Takes a few seconds.`);
    f.note = note;
    save.addEventListener('click', () => saveFilm(save, note));

    nodes.push(
      el('div', { class: 'card-controls' },
        slider('Exposure', 'exposure', -2, 3, 0.5, 'Stops on the film. Portra loves extra light: + gives softer, airier colour.'),
        slider('Brightness', 'brightness', -1.5, 1.5, 0.1, 'Stops at the print, like a lab’s density button.'),
        slider('Highlights', 'highlights', -FILM_HIGHLIGHTS_MAX, FILM_HIGHLIGHTS_MAX, 0.5, 'The bright parts only: + prints them lighter, − holds them back.'),
        slider('Shadows', 'shadows', -FILM_HIGHLIGHTS_MAX, FILM_HIGHLIGHTS_MAX, 0.5, 'The dark parts only: + opens them up, − prints them deeper.'),
        compare,
      ),
      filmFrameControls(f),
      save,
      note,
    );
    return nodes;
  }

  // The Frame section: off, it is only its title and a square switch; on, it shows the colour
  // (white or black) and a slider for the frame's width.
  function filmFrameControls(f) {
    const toggle = el('button', { class: 'frame-toggle', type: 'button', role: 'switch',
      'aria-checked': String(filmPrefs.frame) },
    el('span', { class: 'card-label' }, 'Frame'),
    el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })));

    const colors = el('div', { class: 'seg', role: 'group', 'aria-label': 'Frame colour' },
      Object.keys(FRAME_COLORS).map((value) => el('button', {
        type: 'button', 'data-value': value, 'aria-pressed': String(filmPrefs.frameColor === value),
      }, value === 'white' ? 'White' : 'Black')));
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      filmPrefs.frameColor = b.dataset.value;
      for (const other of colors.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(colors);
      saveFilmPrefs();
      filmApplyFrame(f);
    });
    trackFill(colors);

    const sizeValue = el('span', { class: 'film-value' }, `${filmPrefs.frameSize}%`);
    const size = el('input', { type: 'range', min: '1', max: '20', step: '0.5', 'aria-label': 'Frame size' });
    size.value = String(filmPrefs.frameSize);
    size.addEventListener('input', () => {
      filmPrefs.frameSize = Number(size.value);
      sizeValue.textContent = `${filmPrefs.frameSize}%`;
      filmApplyFrame(f);
    });
    size.addEventListener('change', saveFilmPrefs);

    const body = el('div', { class: 'frame-body' },
      el('div', { class: 'card-row' }, el('span', { class: 'card-label' }, 'Colour'), colors),
      el('label', { class: 'card-row film-slider' }, el('span', { class: 'card-label' }, 'Size', sizeValue), size,
        el('small', null, 'Width of the border, as a share of the photo’s shorter side.')));
    body.hidden = !filmPrefs.frame;

    toggle.addEventListener('click', () => {
      filmPrefs.frame = !filmPrefs.frame;
      toggle.setAttribute('aria-checked', String(filmPrefs.frame));
      body.hidden = !filmPrefs.frame;
      saveFilmPrefs();
      filmApplyFrame(f);
      if (filmPrefs.frame) placeFill(colors);
    });
    return el('div', { class: 'card-controls film-frame-controls' }, toggle, body);
  }


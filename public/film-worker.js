/* Inspicio Film worker: develops photos off the main thread so the page stays responsive.
   Receives display pixels (RGBA bytes), returns the developed photo as RGBA bytes. Big develops
   (full detail, saving) are split into strips of rows that helper workers (more copies of this
   script) develop in parallel. Nothing here makes a network request; the photo stays on this
   device. */
'use strict';

// The page adds a query in development so nothing here comes from the cache; it is passed on.
const FRESH = (self.location && self.location.search) || '';
importScripts(`film-data.js${FRESH}`, `film.js${FRESH}`);

const F = FilmEngine.prepare(self.FILM_DATA);

// sRGB and Display P3 share the same transfer curve, so one table decodes both.
const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  DECODE[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// A finished photo's input curve, undoing its camera's contrast (FilmEngine.photoTransfer).
let PHOTO = null;

// The last negative, kept so a change to print brightness alone only reprints it.
let cache = null;

// The preview's light before exposure, kept so a new Exposure skips decoding it again.
let inputCache = null;

// The open photo's HDR gain map (an iPhone HEIC from iOS 18 on, or an HDR JPEG), sent once per
// photo.
let gainMap = null;

// How much brighter each pixel is in the photo's HDR version than in the picture itself, from
// its gain map, for a w × h picture. ISO 21496-1 (and Adobe's XMP form): a gain in stops between
// min and max, after a gamma. Apple's older form: 1 + (headroom − 1) × the map's value, which is
// stored with the sRGB curve. Only gains above 1 are kept: the film gets the highlights back that
// the picture had to clip or squeeze, and the rest of the picture stays as it is. Null if the map
// doesn't fit.
function gainFactors(map, w, h) {
  const { data, width: gw, height: gh, meta } = map;
  if (Math.abs(gw / gh - w / h) > 0.02 * (w / h)) return null;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    if (meta.appleHeadroom) {
      const linear = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      lut[v] = 1 + (meta.appleHeadroom - 1) * linear;
    } else {
      const c = meta.channels[0];
      lut[v] = Math.max(1, Math.pow(2, c.min + (c.max - c.min) * Math.pow(x, 1 / c.gamma)));
    }
  }
  const out = new Float32Array(w * h);
  const sx = gw / w;
  const sy = gh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = lut[data[y0 * gw + x0]] * (1 - tx) + lut[data[y0 * gw + x1]] * tx;
      const bottom = lut[data[y1 * gw + x0]] * (1 - tx) + lut[data[y1 * gw + x1]] * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/* ---------- Helpers: strips in parallel ---------- */

// As a helper: the strips this worker has developed, waiting for the print decision, and the
// preview's strip, kept so a change of print brightness only reprints it.
const strips = new Map();
let kept = null;

function helperMessage(msg) {
  if (msg.kind === 'halo') {
    const halo = FilmEngine.convolveFFT(msg.small, msg.dw, msg.dh, msg.values, msg.radius, msg.key);
    self.postMessage({ id: msg.id, halo }, [halo.buffer]);
  } else if (msg.kind === 'strip') {
    const { job, w, rows, y0, core, opts, stats, step, from, to } = msg;
    const rgb = new Float32Array(msg.rgb);
    const progress = (stage) => self.postMessage({ id: msg.id, stage, partial: true });
    FilmEngine.developStrip(F, rgb, w, rows, { ...opts, progress }, { y0, stats });
    const neg = rgb.slice(core[0] * w * 3, core[1] * w * 3);
    if (msg.keep) kept = { job, neg };
    else strips.set(job, neg);
    const samples = FilmEngine.printSamples(neg, step, from, to, from);
    // A preview's negative is also kept by the coordinator (for a lone re-print), so it gets a copy.
    const copy = msg.keep ? neg.slice() : null;
    self.postMessage({ id: msg.id, samples, neg: copy }, copy ? [samples.buffer, copy.buffer] : [samples.buffer]);
  } else if (msg.kind === 'strip-print') {
    const neg = kept && kept.job === msg.job ? kept.neg : strips.get(msg.job);
    strips.delete(msg.job);
    if (!neg) {
      self.postMessage({ id: msg.id, error: 'gone' });
    } else if (msg.K) {
      const count = neg.length / 3;
      const rgba = FilmEngine.printWithK(F, neg, count, msg.K, new Uint8ClampedArray(count * 4), msg.grade || 0);
      self.postMessage({ id: msg.id, rgba }, [rgba.buffer]);
    } else {
      self.postMessage({ id: msg.id });
    }
  } else if (msg.kind === 'strip-keep') {
    // A preview's strip handed over by the coordinator (see `reseed`), for reprints.
    kept = { job: msg.job, neg: new Float32Array(msg.neg) };
    self.postMessage({ id: msg.id });
  }
}

// As the coordinator: the helpers, started with the first job so they're ready for the first big
// one. One per core, leaving one for the page, at most 6. None where workers can't start workers.
const PARALLEL_MIN_PIXELS = 0.5e6;
let pool = null;
let poolBroken = false;
let helperSeq = 0;

// Calling a job off (a full-detail develop nobody needs any more). The page used to end this
// whole worker for that, which threw the preview's negative away with it, so the next change,
// even of print brightness alone, started from nothing. Now only the helpers end, which stops a
// develop that is on them at once; one that hasn't reached them stops at its next step
// (`stopIfCancelled`). The kept negative stays here, and new helpers start with the next job.
const CANCELLED = 'cancelled';
const cancelled = new Set();
let running = 0; // the job in hand
let finished = 0; // the last job done; jobs come in order
const isCancelled = (err) => Boolean(err) && err.message === CANCELLED;
function stopIfCancelled() {
  if (cancelled.has(running)) throw new Error(CANCELLED);
}
function abortJob(id) {
  if (!(id > finished)) return;
  cancelled.add(id);
  if (id !== running || !pool) return;
  for (const helper of pool) {
    helper.dead = true;
    helper.worker.terminate();
    for (const job of helper.jobs.values()) job.reject(new Error(CANCELLED));
    helper.jobs.clear();
  }
  pool = null;
  // The kept negative's strips were on those helpers: it is reprinted here until the new
  // helpers have them (`reseed`).
  if (cache) {
    cache.strips = null;
    cache.seeding = null;
  }
}

function helperPool() {
  if (pool || poolBroken) return pool;
  const cores = (self.navigator && self.navigator.hardwareConcurrency) || 4;
  // At least 2: some browsers report fewer cores than the device has, for privacy.
  const count = Math.min(6, Math.max(2, cores - 1));
  if (typeof Worker !== 'function') { poolBroken = true; return null; }
  try {
    pool = Array.from({ length: count }, () => {
      const helper = { worker: new Worker(`film-worker.js${FRESH}`), jobs: new Map(), dead: false };
      helper.worker.onmessage = (e) => {
        const job = helper.jobs.get(e.data.id);
        if (job && e.data.partial) { job.onStage?.(e.data.stage); return; }
        helper.jobs.delete(e.data.id);
        if (!job) return;
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
      };
      helper.worker.onerror = (e) => {
        e.preventDefault?.();
        poolBroken = true;
        for (const job of helper.jobs.values()) job.reject(new Error('A film helper stopped.'));
        helper.jobs.clear();
      };
      return helper;
    });
  } catch {
    poolBroken = true;
    pool = null;
  }
  return pool;
}

function helperCall(helper, msg, transfer = [], onStage = null) {
  if (helper.dead) return Promise.reject(new Error(CANCELLED));
  const id = ++helperSeq;
  return new Promise((resolve, reject) => {
    helper.jobs.set(id, { resolve, reject, onStage });
    helper.worker.postMessage({ id, ...msg }, transfer);
  });
}

// Develops and prints. Anything but a tiny frame goes to the helpers: halation spreads
// across the whole frame, so it is averaged down here and each channel convolved on a helper; then
// each helper develops a strip of rows with enough rows around it that its own rows come out
// exactly as in one piece, the print decision is taken from
// all the strips' samples, and each helper prints its strip. If the helpers fail, it finishes here.
async function printStrips(helpers, job, K, rows, w, count, grade) {
  const prints = await Promise.all(helpers.map((helper) => helperCall(helper, { kind: 'strip-print', job, K, grade })));
  const rgba = new Uint8ClampedArray(count * 4);
  prints.forEach((p, k) => rgba.set(p.rgba, rows[k][0] * w * 4));
  return rgba;
}

// Prints a kept negative again (only the print brightness changed): on the helpers that still
// hold its strips, otherwise here.
async function reprint(c, printStops, printOpts) {
  const count = c.w * c.h;
  const s = c.strips;
  if (s && pool === s.helpers && !poolBroken) {
    try {
      const K = FilmEngine.printExposuresFromSamples(s.samples, F, printStops, printOpts);
      return { rgba: await printStrips(s.helpers, s.job, K, s.rows, c.w, count, printOpts.grade), K };
    } catch (err) {
      if (isCancelled(err)) throw err;
      c.strips = null;
    }
  }
  const rgba = new Uint8ClampedArray(count * 4);
  const { K } = FilmEngine.printNegative(F, c.density, c.w, c.h, printStops, rgba, printOpts);
  reseed(c);
  return { rgba, K };
}

// Hands a kept negative's strips to the helpers (new ones, after a job was called off), so its
// later reprints run on them again: nearly twice as fast as here, which shows while a slider is
// dragged. The samples are the same ones the strips would have sent.
function reseed(c) {
  const helpers = pool;
  const count = c.w * c.h;
  if (!helpers || poolBroken || c.strips || c.seeding === helpers || count < PARALLEL_MIN_PIXELS) return;
  c.seeding = helpers;
  const job = ++helperSeq;
  const n = helpers.length;
  const rows = [];
  for (let k = 0; k < n; k++) rows.push([Math.round((c.h * k) / n), Math.round((c.h * (k + 1)) / n)]);
  const samples = FilmEngine.printSamples(c.density, FilmEngine.printStep(count), 0, count);
  Promise.all(helpers.map((helper, k) => {
    const neg = c.density.slice(rows[k][0] * c.w * 3, rows[k][1] * c.w * 3);
    return helperCall(helper, { kind: 'strip-keep', job, neg: neg.buffer }, [neg.buffer]);
  })).then(() => {
    if (cache === c && pool === helpers) c.strips = { job, samples, rows, helpers };
  }).catch(() => {});
}

async function developAndPrint(rgb, w, h, devOpts, printStops, printOpts, keep) {
  const count = w * h;
  stopIfCancelled();
  const helpers = count >= PARALLEL_MIN_PIXELS ? helperPool() : null;
  if (!helpers || poolBroken) {
    const density = FilmEngine.developNegative(F, rgb, w, h, devOpts);
    devOpts.progress?.('printing');
    const rgba = new Uint8ClampedArray(count * 4);
    const { K } = FilmEngine.printNegative(F, density, w, h, printStops, rgba, printOpts);
    return { density, rgba, K };
  }
  FilmEngine.developNegative(F, rgb, w, h, { ...devOpts, exposeOnly: true });
  stopIfCancelled();
  const spatial = devOpts.spatial !== false;
  const minStep = devOpts.preview ? 2 : 1;
  let haloDone = !spatial;
  const opts = { ...devOpts };
  delete opts.progress;
  const margin = FilmEngine.stripMargin(F, w);
  const stats = FilmEngine.grainStats(F, w, h, devOpts.fx);
  const step = FilmEngine.printStep(count);
  const job = ++helperSeq;
  const n = helpers.length;
  const rows = [];
  for (let k = 0; k < n; k++) rows.push([Math.round((h * k) / n), Math.round((h * (k + 1)) / n)]);
  try {
    if (spatial) {
      // Each channel's halation convolution on its own helper.
      devOpts.progress?.('halation');
      const plan = FilmEngine.halationPlan(rgb, w, h, F, minStep, devOpts.fx);
      const halos = await Promise.all(plan.jobs.map((j, k) => helperCall(helpers[k % n],
        { kind: 'halo', small: j.small, dw: plan.dw, dh: plan.dh, values: j.values, radius: j.radius, key: j.key },
        [j.small.buffer]).then((r) => r.halo)));
      FilmEngine.halationApply(rgb, w, h, plan, halos);
      haloDone = true;
      stopIfCancelled();
    }
    // The strips' stages, as the first helper reaches each one.
    const order = ['sharpness', 'curves', 'couplers', 'grain'];
    let reached = 0;
    devOpts.progress?.('sharpness');
    const onStage = (stage) => {
      const i = order.indexOf(stage);
      if (i > reached) { reached = i; devOpts.progress?.(stage); }
    };
    const parts = await Promise.all(helpers.map((helper, k) => {
      const [a, b] = rows[k];
      const s0 = Math.max(0, a - margin);
      const s1 = Math.min(h, b + margin);
      const strip = rgb.slice(s0 * w * 3, s1 * w * 3);
      return helperCall(helper, { kind: 'strip', job, rgb: strip.buffer, w, rows: s1 - s0, y0: s0,
        core: [a - s0, b - s0], opts, stats, step, from: a * w, to: b * w, keep }, [strip.buffer], onStage);
    }));
    let density = null;
    if (keep) {
      density = new Float32Array(count * 3);
      parts.forEach((p, k) => density.set(p.neg, rows[k][0] * w * 3));
    }
    devOpts.progress?.('printing');
    const samples = new Float32Array(parts.reduce((t, p) => t + p.samples.length, 0));
    let at = 0;
    for (const p of parts) { samples.set(p.samples, at); at += p.samples.length; }
    const K = FilmEngine.printExposuresFromSamples(samples, F, printStops, printOpts);
    const rgba = await printStrips(helpers, job, K, rows, w, count, printOpts.grade);
    return { density, rgba, K, strips: keep ? { job, samples, rows, helpers } : null };
  } catch (err) {
    if (isCancelled(err)) throw err;
    // Finish in one piece; rgb still holds the exposed light, with halation if it got that far.
    poolBroken = true;
    if (!haloDone) {
      const plan = FilmEngine.halationPlan(rgb, w, h, F, minStep, devOpts.fx);
      FilmEngine.halationApply(rgb, w, h, plan,
        plan.jobs.map((j) => FilmEngine.convolveFFT(j.small, plan.dw, plan.dh, j.values, j.radius, j.key)));
    }
    const density = FilmEngine.developStrip(F, rgb, w, h, devOpts);
    devOpts.progress?.('printing');
    const rgba = new Uint8ClampedArray(count * 4);
    const { K } = FilmEngine.printNegative(F, density, w, h, printStops, rgba, printOpts);
    return { density, rgba, K };
  }
}

// The open DNG (parsed once) and its decoded light at preview size.
let rawFile = null;
let rawLinear = null;

// Develops a DNG from its sensor data the way the rolls camera does: linear light, the file's
// own colour matrix and BaselineExposure, and rolls' Noritsu print decision.
async function developRaw(msg) {
  const { id, key, file, maxPixels, exposureStops, printStops, keep } = msg;
  const strength = msg.look || 0;
  const { grade, fx } = FilmEngine.look(strength);
  const printOpts = { placement: 'scene', grade, highlights: msg.highlights || 0 };
  if (!rawFile || rawFile.key !== key) {
    if (!file) return self.postMessage({ id, error: 'need-file' });
    const dng = FilmEngine.parseDNG(new Uint8Array(file));
    if (!FilmEngine.dngSupported(dng)) return self.postMessage({ id, error: 'unsupported' });
    rawFile = { key, dng, layers: FilmEngine.cameraToLayers(F, dng.meta).layers };
    rawLinear = null;
  }
  const { dng, layers } = rawFile;
  const m = dng.meta;
  const ds = Math.max(1, Math.ceil(Math.sqrt((m.width * m.height) / maxPixels)));
  const negKey = `raw|${key}|${ds}|${exposureStops}|${strength}`;
  let density;
  let w;
  let h;
  let rgba;
  let K;
  let strips;
  const progress = (stage) => self.postMessage({ id, stage });
  if (cache && cache.key === negKey) {
    ({ density, w, h } = cache);
  } else {
    let lin = rawLinear && rawLinear.key === key && rawLinear.ds === ds ? rawLinear : null;
    if (!lin) {
      self.postMessage({ id, stage: 'reading' });
      lin = { key, ds, ...FilmEngine.decodeDNG(dng, ds) };
      if (keep) rawLinear = lin;
      stopIfCancelled();
    }
    w = lin.width;
    h = lin.height;
    const rgb = keep ? lin.rgb.slice() : lin.rgb;
    ({ density, rgba, K, strips } = await developAndPrint(rgb, w, h,
      { matrix: layers, baselineExposure: m.baselineExposure, exposureStops, preview: keep, progress, fx },
      printStops, printOpts, keep));
    if (keep) cache = { key: negKey, density, w, h, strips };
  }
  if (!rgba) {
    progress('printing');
    ({ rgba, K } = await reprint(cache, printStops, printOpts));
  }
  const o = FilmEngine.orientRGBA(rgba, w, h, m.orientation);
  const swaps = m.orientation >= 5 && m.orientation <= 8;
  self.postMessage({
    id, done: true, raw: true, rgba: o.rgba, width: o.width, height: o.height, K,
    fullWidth: swaps ? m.height : m.width, fullHeight: swaps ? m.width : m.height,
  }, [o.rgba.buffer]);
}

// Jobs run one at a time, in order, even though a big one waits for its helpers.
let queue = Promise.resolve();

self.onmessage = (e) => {
  if (e.data.kind === 'abort') {
    abortJob(e.data.id);
    return;
  }
  if (e.data.kind === 'halo' || e.data.kind === 'strip' || e.data.kind === 'strip-print' || e.data.kind === 'strip-keep') {
    try {
      helperMessage(e.data);
    } catch (err) {
      self.postMessage({ id: e.data.id, error: String((err && err.message) || err) });
    }
    return;
  }
  queue = queue.then(() => handle(e.data));
  helperPool();
};

async function handle(data) {
  running = data.id;
  try {
    if (cancelled.has(data.id)) self.postMessage({ id: data.id, error: CANCELLED });
    else await run(data);
  } finally {
    cancelled.delete(data.id);
    finished = data.id;
    running = 0;
  }
}

async function run(data) {
  if (data.kind === 'raw') {
    try {
      await developRaw(data);
    } catch (err) {
      if (!isCancelled(err)) {
        rawFile = null;
        rawLinear = null;
      }
      self.postMessage({ id: data.id, error: String((err && err.message) || err) });
    }
    return;
  }
  const { id, key, pixels, width: w, height: h, primaries, exposureStops, printStops, placement, keep } = data;
  if (data.gain) gainMap = { key, ...data.gain };
  const map = data.useGain && gainMap?.key === key ? gainMap : null;
  if (data.useGain && !map) return self.postMessage({ id, error: 'need-gain' });
  // Strength (data.look, 0 to 1): how much of the scan look goes on top (FilmEngine.look).
  const strength = data.look || 0;
  const { grade, fx } = FilmEngine.look(strength);
  const printOpts = { placement: placement || 'scene', exposureStops, grade, highlights: data.highlights || 0 };
  try {
    const negKey = `${key}|${primaries}|${exposureStops}|${map ? 'hdr' : ''}|${strength}`;
    let density;
    let rgba;
    let K;
    let strips;
    if (cache && cache.key === negKey && cache.w === w && cache.h === h) {
      density = cache.density;
    } else {
      const count = w * h;
      const inputKey = `${key}|${primaries}|${placement}|${map ? 'hdr' : ''}|${w}|${h}`;
      let rgb;
      if (keep && inputCache?.key === inputKey) {
        rgb = inputCache.rgb.slice();
      } else {
        const src = new Uint8ClampedArray(pixels);
        rgb = new Float32Array(count * 3);
        // 'photo': a finished photo, decoded through the curve that undoes its tone curve.
        // Otherwise plain sRGB / P3 decoding to linear light.
        const table = placement === 'photo' ? (PHOTO ||= FilmEngine.photoTransfer(F)) : DECODE;
        const boost = map ? gainFactors(map, w, h) : null;
        for (let i = 0; i < count; i++) {
          const b = boost ? boost[i] : 1;
          rgb[i * 3] = table[src[i * 4]] * b;
          rgb[i * 3 + 1] = table[src[i * 4 + 1]] * b;
          rgb[i * 3 + 2] = table[src[i * 4 + 2]] * b;
        }
        if (keep) inputCache = { key: inputKey, rgb: rgb.slice() };
        stopIfCancelled();
      }
      ({ density, rgba, K, strips } = await developAndPrint(rgb, w, h,
        { primaries, exposureStops, preview: keep, fx, progress: (stage) => self.postMessage({ id, stage }) },
        printStops, printOpts, keep));
      if (keep) cache = { key: negKey, density, w, h, strips };
    }
    if (!rgba) {
      self.postMessage({ id, stage: 'printing' });
      ({ rgba, K } = await reprint(cache, printStops, printOpts));
    }
    self.postMessage({ id, done: true, rgba, width: w, height: h, K }, [rgba.buffer]);
  } catch (err) {
    if (!isCancelled(err)) cache = null;
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
}

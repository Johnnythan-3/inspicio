/* Inspicio Film worker: develops photos off the main thread so the page stays responsive.
   Receives display pixels (RGBA bytes), returns the developed photo as RGBA bytes. Nothing here
   makes a network request; the photo stays on this device. */
'use strict';

importScripts('film-data.js', 'film.js');

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

// The open photo's HDR gain map (an iPhone HEIC from iOS 18 on), sent once per photo.
let gainMap = null;

// How much brighter each pixel is in the photo's HDR version than in the picture itself, from
// its gain map (ISO 21496-1: a gain in stops between min and max, after a gamma), for a w × h
// picture. Only gains above 1 are kept: the film gets the highlights back that the picture had to
// clip or squeeze, and the rest of the picture stays as it is. Null if the map doesn't fit.
function gainFactors(map, w, h) {
  const { data, width: gw, height: gh, meta } = map;
  if (Math.abs(gw / gh - w / h) > 0.02 * (w / h)) return null;
  const c = meta.channels[0];
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const stops = c.min + (c.max - c.min) * Math.pow(v / 255, 1 / c.gamma);
    lut[v] = Math.max(1, Math.pow(2, stops));
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

// The open DNG (parsed once) and its decoded light at preview size.
let rawFile = null;
let rawLinear = null;

// Develops a DNG from its sensor data the way the rolls camera does: linear light, the file's
// own colour matrix and BaselineExposure, and rolls' Noritsu print decision.
function developRaw(msg) {
  const { id, key, file, maxPixels, exposureStops, printStops, keep } = msg;
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
  const negKey = `raw|${key}|${ds}|${exposureStops}`;
  let density;
  let w;
  let h;
  if (cache && cache.key === negKey) {
    ({ density, w, h } = cache);
  } else {
    let lin = rawLinear && rawLinear.key === key && rawLinear.ds === ds ? rawLinear : null;
    if (!lin) {
      self.postMessage({ id, stage: 'reading' });
      lin = { key, ds, ...FilmEngine.decodeDNG(dng, ds) };
      if (keep) rawLinear = lin;
    }
    w = lin.width;
    h = lin.height;
    const rgb = keep ? lin.rgb.slice() : lin.rgb;
    density = FilmEngine.developNegative(F, rgb, w, h, {
      matrix: layers,
      baselineExposure: m.baselineExposure,
      exposureStops,
      preview: keep,
      progress: (stage) => self.postMessage({ id, stage }),
    });
    if (keep) cache = { key: negKey, density, w, h };
  }
  self.postMessage({ id, stage: 'printing' });
  const rgba = new Uint8ClampedArray(w * h * 4);
  const { K } = FilmEngine.printNegative(F, density, w, h, printStops, rgba, { placement: 'scene' });
  const o = FilmEngine.orientRGBA(rgba, w, h, m.orientation);
  const swaps = m.orientation >= 5 && m.orientation <= 8;
  self.postMessage({
    id, done: true, raw: true, rgba: o.rgba, width: o.width, height: o.height, K,
    fullWidth: swaps ? m.height : m.width, fullHeight: swaps ? m.width : m.height,
  }, [o.rgba.buffer]);
}

self.onmessage = (e) => {
  if (e.data.kind === 'raw') {
    try {
      developRaw(e.data);
    } catch (err) {
      rawFile = null;
      rawLinear = null;
      self.postMessage({ id: e.data.id, error: String((err && err.message) || err) });
    }
    return;
  }
  const { id, key, pixels, width: w, height: h, primaries, exposureStops, printStops, placement, keep } = e.data;
  if (e.data.gain) gainMap = { key, ...e.data.gain };
  const map = e.data.useGain && gainMap?.key === key ? gainMap : null;
  if (e.data.useGain && !map) return self.postMessage({ id, error: 'need-gain' });
  try {
    const negKey = `${key}|${primaries}|${exposureStops}|${map ? 'hdr' : ''}`;
    let density;
    if (cache && cache.key === negKey && cache.w === w && cache.h === h) {
      density = cache.density;
    } else {
      const src = new Uint8ClampedArray(pixels);
      const count = w * h;
      const rgb = new Float32Array(count * 3);
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
      density = FilmEngine.developNegative(F, rgb, w, h, {
        primaries,
        exposureStops,
        preview: keep,
        progress: (stage) => self.postMessage({ id, stage }),
      });
      if (keep) cache = { key: negKey, density, w, h };
    }
    self.postMessage({ id, stage: 'printing' });
    const rgba = new Uint8ClampedArray(w * h * 4);
    const { K } = FilmEngine.printNegative(F, density, w, h, printStops, rgba,
      { placement: placement || 'scene', exposureStops });
    self.postMessage({ id, done: true, rgba, width: w, height: h, K }, [rgba.buffer]);
  } catch (err) {
    cache = null;
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

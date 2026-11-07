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

self.onmessage = (e) => {
  const { id, key, pixels, width: w, height: h, primaries, exposureStops, printStops, placement, keep } = e.data;
  try {
    const negKey = `${key}|${primaries}|${exposureStops}`;
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
      for (let i = 0; i < count; i++) {
        rgb[i * 3] = table[src[i * 4]];
        rgb[i * 3 + 1] = table[src[i * 4 + 1]];
        rgb[i * 3 + 2] = table[src[i * 4 + 2]];
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

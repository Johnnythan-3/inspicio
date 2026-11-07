/* Inspicio Film: a JavaScript port of the rolls film engine (Kodak Portra 400 printed on Endura
   paper, Noritsu-style). Runs in a Web Worker, so the photo never leaves the device.

   The order is the film's, not a filter's:
     scene light -> film layer exposure -> HALATION -> MTF (both in linear light, before the curve)
     -> characteristic curves (density) -> DIR COUPLERS -> GRAIN (both in density)
     -> print: exposure decision K from the negative's statistics -> paper curve -> paper colour.

   Measured data (curves, the film's colour matrix, the paper's colour table) is baked from the
   Swift engine into film-data.js. The algorithms below are line-for-line ports of the Swift ones;
   each function names the Swift type it mirrors. Everything works in typed arrays of interleaved
   RGB, width * height * 3. */
(function (root) {
  'use strict';

  const LOG10 = Math.log10;

  /* ---------- Data ---------- */

  function decodeBase64(b64) {
    if (typeof atob === 'function') {
      const s = atob(b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64')); // Node, for tests
  }

  function prepare(data) {
    const curve = (c) => ({
      xMin: c.xMin, xMax: c.xMax,
      rows: [Float32Array.from(c.R), Float32Array.from(c.G), Float32Array.from(c.B)],
    });
    const bytes = decodeBase64(data.lutB64);
    return {
      ...data,
      neg: curve(data.characteristic),
      paper: curve(data.paperCurve),
      lutTable: new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    };
  }

  // FilmCurve.value for an evenly sampled row.
  function lookup(row, xMin, xMax, x) {
    const steps = row.length - 1;
    const t = (x - xMin) * (steps / (xMax - xMin));
    if (t <= 0) return row[0];
    if (t >= steps) return row[steps];
    const i = t | 0;
    return row[i] + (row[i + 1] - row[i]) * (t - i);
  }

  /* ---------- Blur (Blur.swift) ---------- */

  function boxSizes(sigma, passes = 3) {
    if (!(sigma > 0)) return [];
    const ideal = Math.sqrt((12 * sigma * sigma / passes) + 1);
    let wl = Math.floor(ideal);
    if (wl % 2 === 0) wl -= 1;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - passes * wl * wl - 4 * passes * wl - 3 * passes) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    return Array.from({ length: passes }, (_, i) => (i < m ? wl : wu));
  }

  function boxH(src, dst, w, h, r) {
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const first = src[row];
      const last = src[row + w - 1];
      let sum = first * (r + 1);
      for (let i = 0; i < Math.min(r, w); i++) sum += src[row + i];
      for (let x = 0; x < w; x++) {
        sum += (x + r < w ? src[row + x + r] : last) - (x - r - 1 >= 0 ? src[row + x - r - 1] : first);
        dst[row + x] = sum * norm;
      }
    }
  }

  function boxV(src, dst, w, h, r) {
    const norm = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      const first = src[x];
      const last = src[(h - 1) * w + x];
      let sum = first * (r + 1);
      for (let i = 0; i < Math.min(r, h); i++) sum += src[i * w + x];
      for (let y = 0; y < h; y++) {
        sum += (y + r < h ? src[(y + r) * w + x] : last) - (y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : first);
        dst[y * w + x] = sum * norm;
      }
    }
  }

  function gaussian(plane, scratch, w, h, sigma) {
    if (!(sigma > 0.01) || w < 2 || h < 2) return;
    for (const size of boxSizes(sigma)) {
      const r = (size - 1) >> 1;
      if (r < 1) continue;
      boxH(plane, scratch, w, h, r);
      boxV(scratch, plane, w, h, r);
    }
  }

  function separable(plane, scratch, w, h, k) {
    const r = k.length - 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = plane[row + x] * k[0];
        for (let n = 1; n <= r; n++) {
          sum += (plane[row + Math.min(x + n, w - 1)] + plane[row + Math.max(x - n, 0)]) * k[n];
        }
        scratch[row + x] = sum;
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = scratch[row + x] * k[0];
        for (let n = 1; n <= r; n++) {
          sum += (scratch[Math.min(y + n, h - 1) * w + x] + scratch[Math.max(y - n, 0) * w + x]) * k[n];
        }
        plane[row + x] = sum;
      }
    }
  }

  function extract(rgb, c, count, out) {
    for (let i = 0; i < count; i++) out[i] = rgb[i * 3 + c];
    return out;
  }

  /* ---------- Halation (Halation.swift, HalationPSF.swift) ---------- */

  function fresnel(theta, n) {
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const sinT = n * st;
    if (sinT >= 1) return 1;
    const ctT = Math.sqrt(1 - sinT * sinT);
    const rs = (n * ct - ctT) / (n * ct + ctT);
    const rp = (n * ctT - ct) / (n * ctT + ct);
    return 0.5 * (rs * rs + rp * rp);
  }

  function coupling(od, n, samples = 4000) {
    const thc = Math.asin(1 / n);
    const step = (Math.PI / 2) / samples;
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const th = (i + 0.5) * step;
      const r = th < thc ? fresnel(th, n) : 1;
      const c = Math.cos(th);
      if (c <= 1e-9) continue;
      total += Math.sin(th) * r * Math.pow(10, -2 * od / c) * step;
    }
    return total;
  }

  function undercoatOD(target, n) {
    if (!(target > 0)) return Infinity;
    if (target >= coupling(0, n)) return 0;
    let lo = 0;
    let hi = 8;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (coupling(mid, n) > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function psf(r, od, n, t) {
    const thc = Math.asin(1 / n);
    const u = Math.max(r, 0) / (2 * t);
    const th = Math.atan(u);
    const refl = th < thc ? fresnel(th, n) : 1;
    const c = Math.cos(th);
    if (c <= 1e-9) return 0;
    return refl * Math.pow(1 + u * u, -1.5) * Math.pow(10, -2 * od / c);
  }

  function halationKernel(k, n, t, cell, supersample = 4) {
    const od = undercoatOD(k, n);
    let acc = 0;
    let radius = 1;
    while (radius < 64) {
      const r = radius * cell;
      const ring = 2 * Math.PI * r * psf(r, od, n, t) * cell;
      acc += ring;
      if (acc > 0 && ring < acc * 1e-4) break;
      radius++;
    }
    const side = 2 * radius + 1;
    const values = new Float64Array(side * side);
    const s = supersample;
    let sum = 0;
    for (let iy = 0; iy < side; iy++) {
      for (let ix = 0; ix < side; ix++) {
        let a = 0;
        for (let sy = 0; sy < s; sy++) {
          for (let sx = 0; sx < s; sx++) {
            const dy = (iy - radius + (sy + 0.5) / s - 0.5) * cell;
            const dx = (ix - radius + (sx + 0.5) / s - 0.5) * cell;
            a += psf(Math.sqrt(dx * dx + dy * dy), od, n, t);
          }
        }
        values[iy * side + ix] = a / (s * s);
        sum += values[iy * side + ix];
      }
    }
    if (!(sum > 0)) return null;
    for (let i = 0; i < values.length; i++) values[i] *= k / sum;
    return { values, radius };
  }

  const kernels = new Map(); // halation kernels by channel and cell size

  // In-place radix-2 FFT on separate real/imaginary arrays (length a power of two).
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k;
          const b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function fft2(re, im, nx, ny, inverse) {
    const rr = new Float64Array(nx);
    const ri = new Float64Array(nx);
    for (let y = 0; y < ny; y++) {
      const o = y * nx;
      rr.set(re.subarray(o, o + nx)); ri.set(im.subarray(o, o + nx));
      fft(rr, ri, inverse);
      re.set(rr, o); im.set(ri, o);
    }
    const cr = new Float64Array(ny);
    const ci = new Float64Array(ny);
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) { cr[y] = re[y * nx + x]; ci[y] = im[y * nx + x]; }
      fft(cr, ci, inverse);
      for (let y = 0; y < ny; y++) { re[y * nx + x] = cr[y]; im[y * nx + x] = ci[y]; }
    }
  }

  const pow2 = (v) => { let n = 1; while (n < v) n <<= 1; return n; };

  // The Swift convolve: out(x,y) = sum of src at clamped (x+kx-r, y+ky-r) times the kernel.
  // Done with an FFT over an edge-padded copy, which gives the same clamped-edge result.
  // Kernel spectra, kept between develops of the same size (the sliders re-develop a lot).
  const kernelSpectra = new Map();

  function convolveFFT(src, dw, dh, kernel, r, cacheKey) {
    const side = 2 * r + 1;
    const pw = dw + 2 * r;
    const ph = dh + 2 * r;
    const nx = pow2(pw);
    const ny = pow2(ph);
    const re = new Float64Array(nx * ny);
    const im = new Float64Array(nx * ny);
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(Math.max(y - r, 0), dh - 1);
      for (let x = 0; x < pw; x++) {
        re[y * nx + x] = src[sy * dw + Math.min(Math.max(x - r, 0), dw - 1)];
      }
    }
    const key = `${cacheKey}|${nx}|${ny}`;
    let spectrum = kernelSpectra.get(key);
    if (!spectrum) {
      const kr = new Float64Array(nx * ny);
      const ki = new Float64Array(nx * ny);
      for (let ky = 0; ky < side; ky++) {
        for (let kx = 0; kx < side; kx++) {
          kr[((ny - ky) % ny) * nx + ((nx - kx) % nx)] = kernel[ky * side + kx];
        }
      }
      fft2(kr, ki, nx, ny, false);
      spectrum = { kr, ki };
      if (kernelSpectra.size > 6) kernelSpectra.clear();
      kernelSpectra.set(key, spectrum);
    }
    const { kr, ki } = spectrum;
    fft2(re, im, nx, ny, false);
    for (let i = 0; i < re.length; i++) {
      const a = re[i] * kr[i] - im[i] * ki[i];
      im[i] = re[i] * ki[i] + im[i] * kr[i];
      re[i] = a;
    }
    fft2(re, im, nx, ny, true);
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) out[y * dw + x] = re[y * nx + x];
    return out;
  }

  // `minStep` > 1 makes the halation grid coarser than rolls' for a quick preview; the glow is
  // broad, so it looks the same. Saves use rolls' own grid.
  function halation(rgb, w, h, F, minStep = 1) {
    const H = F.halation;
    const n = H.refractiveIndex;
    const t = H.baseThickness;
    const micronsPerPixel = F.frameWidthMm * 1000 / w;
    const critical = 2 * t * Math.tan(Math.asin(1 / n));
    const step = Math.max(minStep, Math.round((critical / 5) / micronsPerPixel));
    const cell = micronsPerPixel * step;
    const dw = Math.ceil(w / step);
    const dh = Math.ceil(h / step);
    const small = new Float32Array(dw * dh);
    for (let c = 0; c < 3; c++) {
      const k = H.strength[c] || 0;
      if (!(k > 0)) continue;
      const kernKey = `${c}|${cell}`;
      const kern = kernels.get(kernKey) || halationKernel(k, n, t, cell);
      if (!kern) continue;
      kernels.set(kernKey, kern);
      for (let dy = 0; dy < dh; dy++) {
        const y0 = dy * step;
        const y1 = Math.min(y0 + step, h);
        for (let dx = 0; dx < dw; dx++) {
          const x0 = dx * step;
          const x1 = Math.min(x0 + step, w);
          let sum = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += rgb[(y * w + x) * 3 + c];
          const cnt = (y1 - y0) * (x1 - x0);
          small[dy * dw + dx] = cnt > 0 ? sum / cnt : 0;
        }
      }
      const halo = convolveFFT(small, dw, dh, kern.values, kern.radius, kernKey);
      const inv = 1 / step;
      for (let y = 0; y < h; y++) {
        const fy = (y + 0.5) * inv - 0.5;
        const y0 = Math.min(Math.max(Math.floor(fy), 0), dh - 1);
        const y1 = Math.min(y0 + 1, dh - 1);
        const wy = Math.min(Math.max(fy - y0, 0), 1);
        for (let x = 0; x < w; x++) {
          const fx = (x + 0.5) * inv - 0.5;
          const x0 = Math.min(Math.max(Math.floor(fx), 0), dw - 1);
          const x1 = Math.min(x0 + 1, dw - 1);
          const wx = Math.min(Math.max(fx - x0, 0), 1);
          const top = halo[y0 * dw + x0] * (1 - wx) + halo[y0 * dw + x1] * wx;
          const bot = halo[y1 * dw + x0] * (1 - wx) + halo[y1 * dw + x1] * wx;
          const i = (y * w + x) * 3 + c;
          rgb[i] = Math.max(0, rgb[i] + top * (1 - wy) + bot * wy);
        }
      }
    }
  }

  /* ---------- MTF (MTF.swift) ---------- */

  function mtfResponse(F, c, f) {
    const table = F.mtf[['R', 'G', 'B'][c]];
    const t = Math.min(f / F.mtf.step, table.length - 1);
    const i = Math.min(t | 0, table.length - 2);
    return table[i] + (table[i + 1] - table[i]) * (t - i);
  }

  function mtfHalfKernel(F, c, w, maxRadius = 40) {
    const nyquist = (w / F.frameWidthMm) / 2;
    let worst = 1;
    for (let s = 0; s <= 64; s++) worst = Math.min(worst, mtfResponse(F, c, nyquist * s / 64));
    if (worst >= 0.995) return null;
    const steps = 1024;
    const k = new Float64Array(maxRadius + 1);
    for (let s = 0; s <= steps; s++) {
      const wv = Math.PI * s / steps;
      const m = mtfResponse(F, c, wv * nyquist / Math.PI);
      const weight = s === 0 || s === steps ? 0.5 : 1;
      for (let n = 0; n <= maxRadius; n++) k[n] += weight * m * Math.cos(wv * n);
    }
    for (let n = 0; n <= maxRadius; n++) k[n] *= 1 / steps;
    if (!(k[0] > 0)) return null;
    let radius = 0;
    for (let n = maxRadius; n >= 1; n--) if (Math.abs(k[n]) > 1e-4 * k[0]) { radius = n; break; }
    if (!radius) return null;
    const half = Array.from(k.subarray(0, radius + 1));
    const taperFrom = Math.max(1, Math.floor((radius * 3) / 4));
    if (radius > taperFrom) {
      for (let n = taperFrom; n <= radius; n++) {
        const t = (n - taperFrom + 1) / (radius - taperFrom + 1);
        half[n] *= 0.5 * (1 + Math.cos(Math.PI * t));
      }
    }
    let total = half[0];
    for (let n = 1; n < half.length; n++) total += 2 * half[n];
    if (Math.abs(total) <= 1e-9) return null;
    return Float32Array.from(half, (v) => v / total);
  }

  function mtf(rgb, w, h, F) {
    const count = w * h;
    let plane = null;
    let scratch = null;
    for (let c = 0; c < 3; c++) {
      const half = mtfHalfKernel(F, c, w);
      if (!half || half.length < 2) continue;
      plane ||= new Float32Array(count);
      scratch ||= new Float32Array(count);
      extract(rgb, c, count, plane);
      separable(plane, scratch, w, h, half);
      for (let i = 0; i < count; i++) rgb[i * 3 + c] = plane[i];
    }
  }

  /* ---------- DIR couplers (Couplers.swift) ---------- */

  function neutralReference(neg, samples = 512) {
    const [rRow, gRow, bRow] = neg.rows;
    const lo = gRow[0];
    const hi = gRow[gRow.length - 1];
    const r = new Float32Array(samples);
    const b = new Float32Array(samples);
    let k = 0;
    for (let i = 0; i < samples; i++) {
      const target = lo + (hi - lo) * i / (samples - 1);
      while (k < gRow.length - 2 && gRow[k + 1] < target) k++;
      const span = gRow[k + 1] - gRow[k];
      const t = span > 1e-9 ? (target - gRow[k]) / span : 0;
      r[i] = rRow[k] + (rRow[k + 1] - rRow[k]) * t;
      b[i] = bRow[k] + (bRow[k + 1] - bRow[k]) * t;
    }
    const invSpan = (samples - 1) / (hi - lo);
    return (g) => {
      const t = (g - lo) * invSpan;
      if (t <= 0) return [r[0], b[0]];
      if (t >= samples - 1) return [r[samples - 1], b[samples - 1]];
      const i = t | 0;
      const f = t - i;
      return [r[i] + (r[i + 1] - r[i]) * f, b[i] + (b[i + 1] - b[i]) * f];
    };
  }

  function couplers(d, w, h, F) {
    const C = F.couplers;
    if (!(C.self > 0 || C.cross > 0)) return;
    const radius = C.radius / (F.frameWidthMm * 1000) * w;
    if (!(radius > 0.01)) return;
    const count = w * h;
    const scratch = new Float32Array(count);
    const planes = [0, 1, 2].map((c) => {
      const p = extract(d, c, count, new Float32Array(count));
      gaussian(p, scratch, w, h, radius);
      return p;
    });
    const ref = neutralReference(F.neg);
    const exc = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const l0 = planes[0][i];
      const l1 = planes[1][i];
      const l2 = planes[2][i];
      const [nr, nb] = ref(l1);
      exc[0] = l0 - nr; exc[1] = 0; exc[2] = l2 - nb;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const density = d[j];
        const spatial = density - planes[c][i];
        let others = 0;
        for (let k = 0; k < 3; k++) if (k !== c) others += exc[k];
        const raw = C.self * spatial - C.cross * others;
        d[j] = Math.max(0, density + raw / (1 + C.saturation * Math.abs(raw)));
      }
    }
  }

  /* ---------- Grain (Grain.swift) ---------- */

  function hash(x, y, seed) {
    let h = Math.imul(x, 0x27d4eb2d);
    h ^= Math.imul(y, 0x165667b1);
    h ^= seed;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) * (2 / 4294967295) - 1;
  }

  function valueNoise(x, y, seed) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, seed);
    const b = hash(xi + 1, yi, seed);
    const c = hash(xi, yi + 1, seed);
    const d = hash(xi + 1, yi + 1, seed);
    const top = a + (b - a) * u;
    return top + ((c + (d - c) * u) - top) * v;
  }

  function grain(d, w, h, F, referenceDensity, seedBase = 0x5eed) {
    const G = F.grain;
    const rawCell = G.size / (F.frameWidthMm * 1000) * w;
    const cell = Math.max(1, rawCell);
    const refD = Math.max(referenceDensity, 0.01);
    const selwyn = Math.min(1, rawCell);
    const field = new Float32Array(w * h);
    const inv = 1 / cell;
    const inv2 = inv * 2;
    const w2 = Math.min(Math.max(G.roughness, 0), 1) * 0.5;
    const w1 = 1 - w2;
    for (let c = 0; c < 3; c++) {
      const amp = (G.amplitude[c] || 0) * selwyn;
      if (!(amp > 0)) continue;
      const seed = (seedBase + Math.imul(c, 0x9e3779b9)) >>> 0;
      const seed2 = (seed + 0x68bc21eb) >>> 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = w1 * valueNoise(x * inv, y * inv, seed);
          if (w2 > 0) v += w2 * valueNoise(x * inv2, y * inv2, seed2);
          field[y * w + x] = v;
        }
      }
      // normalizeToUnitRMS
      const stride = Math.max(1, Math.floor(field.length / 200000));
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < field.length; i += stride) { sum += field[i]; sumSq += field[i] * field[i]; n++; }
      const mean = sum / n;
      const scale = 1 / Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-12));
      for (let i = 0, count = w * h; i < count; i++) {
        const j = i * 3 + c;
        const sigma = amp * Math.pow(Math.max(d[j], 0) / refD, G.exponent);
        d[j] = Math.max(0, d[j] + sigma * (field[i] - mean) * scale);
      }
    }
  }

  /* ---------- Print (Print.swift) ---------- */

  // The printing decision K. `opts.placement`:
  //   'scene' - the lab's: the negative's 48th percentile prints mid-grey and the colour is 88%
  //             integrated to grey (rolls' Noritsu profile, for scene-linear RAW input).
  //   'photo' - for a finished photo, where the photographer already chose the brightness and
  //             the white balance: the film's own mid-grey at the rated exposure prints mid-grey
  //             (an enlarger set once for the roll), and the colour is printed faithfully.
  function printExposures(d, count, F, printStops, opts = {}) {
    const step = Math.max(1, Math.floor(count / 120000));
    const sums = [0, 0, 0];
    const luma = [];
    for (let i = 0; i < count; i += step) {
      const r = d[i * 3];
      const g = d[i * 3 + 1];
      const b = d[i * 3 + 2];
      sums[0] += r; sums[1] += g; sums[2] += b;
      luma.push(Math.fround((r + g + b) / 3));
    }
    const n = luma.length;
    luma.sort((a, b) => a - b);
    const mean = sums.map((s) => s / Math.max(n, 1));
    const offsets = (ref) => { const m = (ref[0] + ref[1] + ref[2]) / 3; return ref.map((v) => v - m); };
    const faithful = offsets(F.reference);
    const grey = offsets(mean);
    const photo = opts.placement === 'photo';
    const mix = photo ? 0 : F.printProfile.mix;
    const balance = photo && F.photoBalance ? F.photoBalance : [0, 0, 0];
    let level;
    if (photo) {
      const logH = F.logHReference + (F.ratingStops + (opts.exposureStops || 0)) * 0.30103;
      level = [0, 1, 2].reduce((a, c) => a + lookup(F.neg.rows[c], F.neg.xMin, F.neg.xMax, logH), 0) / 3;
    } else {
      level = luma[Math.min(n - 1, Math.floor(n * Math.round(F.printProfile.percentile * 100) / 100))];
    }
    const t = F.paperCurve.midtoneLogH + F.printProfile.exposureStops * 0.30103;
    return [0, 1, 2].map((c) => t + level + (1 - mix) * faithful[c] + mix * grey[c] + balance[c] + printStops * 0.30103);
  }

  // Writes encoded sRGB: 0..1 floats, or 0..255 RGBA bytes when `rgba` is set.
  function printInto(d, count, K, F, out, rgba) {
    const { xMin, xMax, rows } = F.paper;
    const pivot = F.paperCurve.midtoneLogH;
    const protect = F.printProfile.highlightProtection;
    const N = F.lut.size;
    const lut = F.lutTable;
    const lo = F.lut.dLo;
    const hi = F.lut.dHi;
    const s = [0, 0, 0];
    const idx = [0, 0, 0];
    const fr = [0, 0, 0];
    for (let p = 0; p < count; p++) {
      for (let c = 0; c < 3; c++) {
        let logH = K[c] - d[p * 3 + c];
        if (protect > 0) {
          const t = pivot - logH;
          if (t > 0) logH = pivot - t / (1 + protect * t);
        }
        const dens = lookup(rows[c], xMin, xMax, logH);
        let u = (dens - lo[c]) / (hi[c] - lo[c]) * (N - 1);
        u = Math.min(Math.max(u, 0), N - 1);
        const i0 = Math.min(u | 0, N - 2);
        idx[c] = i0;
        fr[c] = u - i0;
      }
      // Trilinear lookup in the paper colour table (red fastest, then green, then blue).
      for (let c = 0; c < 3; c++) s[c] = 0;
      for (let corner = 0; corner < 8; corner++) {
        const dr = corner & 1;
        const dg = (corner >> 1) & 1;
        const db = (corner >> 2) & 1;
        const wgt = (dr ? fr[0] : 1 - fr[0]) * (dg ? fr[1] : 1 - fr[1]) * (db ? fr[2] : 1 - fr[2]);
        if (wgt === 0) continue;
        const base = (((idx[2] + db) * N + idx[1] + dg) * N + idx[0] + dr) * 3;
        s[0] += wgt * lut[base];
        s[1] += wgt * lut[base + 1];
        s[2] += wgt * lut[base + 2];
      }
      if (rgba) {
        const o = p * 4;
        out[o] = s[0] * (255 / 65535) + 0.5;
        out[o + 1] = s[1] * (255 / 65535) + 0.5;
        out[o + 2] = s[2] * (255 / 65535) + 0.5;
        out[o + 3] = 255;
      } else {
        out[p * 3] = s[0] / 65535;
        out[p * 3 + 1] = s[1] / 65535;
        out[p * 3 + 2] = s[2] / 65535;
      }
    }
  }

  /* ---------- The whole develop ---------- */

  // rgb: scene-linear RGB (interleaved, Float32Array), turned into the negative's densities in
  // place. primaries: 'sRGB' or 'displayP3'.
  function developNegative(F, rgb, w, h, opts = {}) {
    const report = opts.progress || (() => {});
    const count = w * h;
    const m = F.layers[opts.primaries === 'displayP3' ? 'displayP3' : 'sRGB'];
    const gain = Math.pow(2, (opts.exposureStops || 0) + F.ratingStops);
    report('exposing');
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      const r = rgb[j] * gain;
      const g = rgb[j + 1] * gain;
      const b = rgb[j + 2] * gain;
      rgb[j] = Math.max(m[0] * r + m[1] * g + m[2] * b, 1e-9);
      rgb[j + 1] = Math.max(m[3] * r + m[4] * g + m[5] * b, 1e-9);
      rgb[j + 2] = Math.max(m[6] * r + m[7] * g + m[8] * b, 1e-9);
    }
    const spatial = opts.spatial !== false;
    if (spatial) {
      report('halation');
      halation(rgb, w, h, F, opts.preview ? 2 : 1);
      report('sharpness');
      mtf(rgb, w, h, F);
    }
    report('curves');
    const offset = F.logHReference - LOG10(F.middleGrey);
    const { xMin, xMax, rows } = F.neg;
    for (let i = 0; i < count * 3; i++) {
      rgb[i] = lookup(rows[i % 3], xMin, xMax, LOG10(Math.max(rgb[i], 1e-9)) + offset);
    }
    if (spatial) {
      report('couplers');
      couplers(rgb, w, h, F);
      report('grain');
      if (opts.grain !== false) grain(rgb, w, h, F, F.reference[1]);
    }
    return rgb;
  }

  // Prints a negative. With `rgba` (a Uint8ClampedArray of w * h * 4) it writes display bytes
  // there; otherwise it returns encoded sRGB floats. Returns the print exposure K as well.
  function printNegative(F, d, w, h, printStops = 0, rgba = null, opts = {}) {
    const count = w * h;
    const K = printExposures(d, count, F, printStops, opts);
    const out = rgba || new Float32Array(count * 3);
    printInto(d, count, K, F, out, Boolean(rgba));
    return { out, K };
  }

  function develop(F, rgb, w, h, opts = {}) {
    developNegative(F, rgb, w, h, opts);
    (opts.progress || (() => {}))('printing');
    return printNegative(F, rgb, w, h, opts.printStops || 0);
  }

  // A finished photo already carries its camera's tone curve, and the paper adds its own, so
  // decoding a JPEG straight to linear light prints with double the contrast: crushed shadows,
  // blown highlights. This builds the input curve that undoes it. It runs a neutral grey wedge
  // through the film and print (no spatial effects, Exposure 0) and inverts the result, so a
  // grey of any brightness prints back at the brightness it had. What the film then adds is its
  // character - colour, the paper's roll-off, halation, grain - not a second contrast curve.
  // Returns scene-linear light for each 8-bit code value.
  function photoTransfer(F) {
    F.photoBalance ||= photoBalance(F);
    const steps = 640;
    const lo = -12;
    const hi = 6;
    const L = new Float32Array(steps);
    const rgb = new Float32Array(steps * 3);
    for (let i = 0; i < steps; i++) {
      L[i] = F.middleGrey * Math.pow(2, lo + (hi - lo) * i / (steps - 1));
      rgb.fill(L[i], i * 3, i * 3 + 3);
    }
    developNegative(F, rgb, steps, 1, { spatial: false });
    const { out } = printNegative(F, rgb, steps, 1, 0, null, { placement: 'photo' });
    const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const Y = new Float32Array(steps);
    let peak = 0;
    for (let i = 0; i < steps; i++) {
      const y = 0.2126 * dec(out[i * 3]) + 0.7152 * dec(out[i * 3 + 1]) + 0.0722 * dec(out[i * 3 + 2]);
      peak = Math.max(peak, y);
      Y[i] = Math.max(y, i ? Y[i - 1] + 1e-9 : y); // keep it increasing for the inversion
    }
    const cap = 0.97 * peak; // beyond this the paper is at white; stretch the rest into highlights
    const invert = (y) => {
      if (y <= Y[0]) return L[0];
      let i = 1;
      while (i < steps - 1 && Y[i] < y) i++;
      const t = (y - Y[i - 1]) / Math.max(Y[i] - Y[i - 1], 1e-12);
      return Math.exp(Math.log(L[i - 1]) + (Math.log(L[i]) - Math.log(L[i - 1])) * t);
    };
    const top = invert(cap);
    const table = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      const y = dec(v / 255);
      table[v] = y <= cap ? invert(y) : top * Math.pow(2, 2 * (y - cap) / (1 - cap));
    }
    return table;
  }

  // Filtration for finished photos: small offsets to K so a mid-grey prints neutral, as a lab
  // balances a roll. The film's own shifts away from the midtones (its crossover, the paper's
  // tinted blacks) stay.
  function photoBalance(F) {
    const grey = new Float32Array([F.middleGrey, F.middleGrey, F.middleGrey]);
    developNegative(F, grey, 1, 1, { spatial: false });
    const K0 = printExposures(grey, 1, F, 0, { placement: 'photo' });
    const out = new Float32Array(3);
    const print = (K) => { printInto(grey, 1, K, F, out, false); return out; };
    const target = print(K0)[1];
    const offsets = [0, 0, 0];
    for (const c of [0, 2]) {
      // More paper exposure in a channel means more of its dye, so less of that colour.
      let lo = -0.6;
      let hi = 0.6;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const K = K0.slice();
        K[c] += mid;
        if (print(K)[c] > target) lo = mid; else hi = mid;
      }
      offsets[c] = (lo + hi) / 2;
    }
    return offsets;
  }

  const api = { prepare, develop, developNegative, printNegative, photoTransfer };
  root.FilmEngine = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

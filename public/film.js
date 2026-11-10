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

  /* Calibration to real Portra 400 (not in rolls). Measured against public ColorChecker frames
     of real Portra 400 (five scans, timed on the grey patch), rolls' film rendered blues, greens
     and cyans 1.3-2x too saturated and reds 12-18 L* too dark. Each matrix mixes the three
     layers' exposures a little (rows sum to 1, so greys stay grey), fitted by least CIEDE2000
     difference to the scans: mean 10.1 -> 7.5 for ProRAW, 7.6 -> 7.2 for finished photos (the
     scans differ from each other by about 7). Finished photos get a lighter one because
     photoTransfer already flattens their contrast, and with it their colour. */
  const PORTRA_FIT = {
    raw: [0.8842, -0.0386, 0.1544, 0.1305, 0.7299, 0.1396, 0.1209, 0.0603, 0.8188],
    photo: [1.051, -0.0831, 0.0321, 0.0788, 0.8945, 0.0267, 0.0595, -0.0122, 0.9527],
  };

  /* The lab's print decision puts the frame's median at mid-grey. In a night or backlit frame
     the median is shadow, so everything lit prints white. These hold the print back: each pair is
     [share of the frame, density above the printed mid-grey] - the frame's 90th percentile prints
     no brighter than the paper's last highlight detail (0.42), its 75th no brighter than a light
     tone (0.30). Set by eye on a night ProRAW and a sunset; an evenly lit frame never reaches
     them. */
  const HIGHLIGHT_GUARD = [[0.90, 0.42], [0.75, 0.30]];

  /* What is still brighter than that rolls off instead of clipping, the way negative film holds
     its highlights. The print is left alone up to `knee` log exposure above mid-grey (about a
     stop: the midtones keep the film's full contrast); above it a shoulder bends the rest so the
     frame's brightest part (`share` of the frame is darker) lands `target` above mid-grey, at
     paper white, and no harder than `most`. Lamps and screens beyond that still print white. A
     frame whose highlights already fit is not bent at all. */
  const HIGHLIGHT_ROLL = { share: 0.98, knee: 0.15, target: 0.44, most: 6 };

  /* The Highlights slider (opts.highlights, -1 to 1): bends the print above mid-grey only. Log
     exposure t above mid-grey becomes t + lift * t^2 / (t + knee): no change at mid-grey or in the
     shadows, growing to (1 + lift) times in the brightest parts. + prints them lighter, - holds
     them back. `up` and `down` are the lift at the ends of the slider for a finished photo;
     `rawUp` and `rawDown` for RAW, whose highlights the shoulder has already placed at paper
     white, so a smaller bend moves them as far. */
  const HIGHLIGHT_LIFT = { knee: 0.15, up: 0.9, down: 0.6, rawUp: 0.45, rawDown: 0.6 };

  /* RAW and the Exposure slider. The lab's rule (the frame's median prints mid-grey) undoes any
     change of exposure: the negative gets denser and the print is made that much darker, so the
     slider moved the picture along the film's curve and left its brightness where it was. Here
     the print gives back only part: `exposure` is the share of the slider's change, measured at
     the film's mid-grey, that stays in the print. More Exposure prints lighter, less darker. (The
     camera's own metering is no guide to brightness: an iPhone exposes ProRAW for the highlights,
     up to two stops under.) */
  const RAW_PRINT = { exposure: 0.6 };

  // opts.calibrated: false gives rolls' data as baked (for the Swift comparisons).
  function prepare(data, opts = {}) {
    const curve = (c) => ({
      xMin: c.xMin, xMax: c.xMax,
      rows: [Float32Array.from(c.R), Float32Array.from(c.G), Float32Array.from(c.B)],
    });
    const bytes = decodeBase64(data.lutB64);
    const fit = opts.calibrated === false ? null : PORTRA_FIT;
    return {
      ...data,
      layers: fit ? { sRGB: mul3(fit.photo, data.layers.sRGB), displayP3: mul3(fit.photo, data.layers.displayP3) } : data.layers,
      rawFit: fit ? fit.raw : null,
      highlightGuard: fit ? HIGHLIGHT_GUARD : null,
      highlightRoll: fit ? HIGHLIGHT_ROLL : null,
      rawPrint: fit ? RAW_PRINT : null,
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

  // Column sums kept for a whole row at once (same additions per column, in the same order, as
  // going down each column; much faster in memory).
  function boxV(src, dst, w, h, r) {
    const norm = 1 / (2 * r + 1);
    const lastRow = (h - 1) * w;
    const sum = new Float64Array(w);
    for (let x = 0; x < w; x++) sum[x] = src[x] * (r + 1);
    for (let i = 0; i < Math.min(r, h); i++) for (let x = 0; x < w; x++) sum[x] += src[i * w + x];
    for (let y = 0; y < h; y++) {
      const add = y + r < h ? (y + r) * w : lastRow;
      const sub = y - r - 1 >= 0 ? (y - r - 1) * w : 0;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        sum[x] += src[add + x] - src[sub + x];
        dst[row + x] = sum[x] * norm;
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

  // A symmetric kernel k[0..r], rows then columns, with clamped edges. Each output is summed in
  // the same order as rolls' (centre, then n = 1..r) in double precision, so the result is the
  // same to the bit; the loops just run along rows, which is several times faster than per pixel.
  function separable(plane, scratch, w, h, k) {
    const r = k.length - 1;
    const kd = Float64Array.from(k);
    const acc = new Float64Array(w);
    const pad = new Float32Array(w + 2 * r); // one row with its edge pixels repeated
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let i = 0; i < r; i++) { pad[i] = plane[row]; pad[r + w + i] = plane[row + w - 1]; }
      pad.set(plane.subarray(row, row + w), r);
      const k0 = kd[0];
      for (let x = 0; x < w; x++) acc[x] = pad[x + r] * k0;
      for (let n = 1; n <= r; n++) {
        const kn = kd[n];
        const a = r + n;
        const b = r - n;
        for (let x = 0; x < w; x++) acc[x] += (pad[x + a] + pad[x + b]) * kn;
      }
      for (let x = 0; x < w; x++) scratch[row + x] = acc[x];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const k0 = kd[0];
      for (let x = 0; x < w; x++) acc[x] = scratch[row + x] * k0;
      for (let n = 1; n <= r; n++) {
        const kn = kd[n];
        const a = Math.min(y + n, h - 1) * w;
        const b = Math.max(y - n, 0) * w;
        for (let x = 0; x < w; x++) acc[x] += (scratch[a + x] + scratch[b + x]) * kn;
      }
      for (let x = 0; x < w; x++) plane[row + x] = acc[x];
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
  // `fx` (optional, see `look`): halationGain scales the glow, halationSize its reach.
  function halation(rgb, w, h, F, minStep = 1, fx = null) {
    const plan = halationPlan(rgb, w, h, F, minStep, fx);
    const halos = plan.jobs.map((j) => convolveFFT(j.small, plan.dw, plan.dh, j.values, j.radius, j.key));
    halationApply(rgb, w, h, plan, halos);
  }

  // Halation in two halves, so the convolutions (most of its time) can run elsewhere in parallel:
  // the plan holds each channel's frame averaged down to the halation grid and its kernel.
  function halationPlan(rgb, w, h, F, minStep = 1, fx = null) {
    const H = F.halation;
    const n = H.refractiveIndex;
    const t = H.baseThickness * ((fx && fx.halationSize) || 1);
    const micronsPerPixel = F.frameWidthMm * 1000 / w;
    const critical = 2 * t * Math.tan(Math.asin(1 / n));
    const step = Math.max(minStep, Math.round((critical / 5) / micronsPerPixel));
    const cell = micronsPerPixel * step;
    const dw = Math.ceil(w / step);
    const dh = Math.ceil(h / step);
    const jobs = [];
    for (let c = 0; c < 3; c++) {
      const k = H.strength[c] || 0;
      if (!(k > 0)) continue;
      const kernKey = `${c}|${cell}|${t}`;
      const kern = kernels.get(kernKey) || halationKernel(k, n, t, cell);
      if (!kern) continue;
      kernels.set(kernKey, kern);
      const small = new Float32Array(dw * dh);
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
      jobs.push({ c, small, values: kern.values, radius: kern.radius, key: kernKey });
    }
    return { step, dw, dh, jobs, gain: (fx && fx.halationGain) || 1 };
  }

  // Adds each channel's convolved glow (`halos`, in the plan's order) back at full size.
  function halationApply(rgb, w, h, plan, halos) {
    const { step, dw, dh } = plan;
    const gain = plan.gain || 1;
    let cols = null; // the upsampling's per-column indices and weights, the same for every channel
    plan.jobs.forEach(({ c }, jobIndex) => {
      const halo = halos[jobIndex];
      const inv = 1 / step;
      cols ||= (() => {
        const xs0 = new Int32Array(w);
        const xs1 = new Int32Array(w);
        const wxs = new Float64Array(w);
        for (let x = 0; x < w; x++) {
          const fx = (x + 0.5) * inv - 0.5;
          xs0[x] = Math.min(Math.max(Math.floor(fx), 0), dw - 1);
          xs1[x] = Math.min(xs0[x] + 1, dw - 1);
          wxs[x] = Math.min(Math.max(fx - xs0[x], 0), 1);
        }
        return { xs0, xs1, wxs };
      })();
      const { xs0, xs1, wxs } = cols;
      for (let y = 0; y < h; y++) {
        const fy = (y + 0.5) * inv - 0.5;
        const y0 = Math.min(Math.max(Math.floor(fy), 0), dh - 1);
        const y1 = Math.min(y0 + 1, dh - 1);
        const wy = Math.min(Math.max(fy - y0, 0), 1);
        const r0 = y0 * dw;
        const r1 = y1 * dw;
        for (let x = 0; x < w; x++) {
          const x0 = xs0[x];
          const x1 = xs1[x];
          const wx = wxs[x];
          const top = halo[r0 + x0] * (1 - wx) + halo[r0 + x1] * wx;
          const bot = halo[r1 + x0] * (1 - wx) + halo[r1 + x1] * wx;
          const i = (y * w + x) * 3 + c;
          rgb[i] = Math.max(0, rgb[i] + gain * top * (1 - wy) + gain * bot * wy);
        }
      }
    });
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
    return { r, b, lo, invSpan: (samples - 1) / (hi - lo), samples };
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
    const { r: refR, b: refB, lo: refLo, invSpan, samples } = ref;
    const exc = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const l0 = planes[0][i];
      const l1 = planes[1][i];
      const l2 = planes[2][i];
      // The neutral (grey) red and blue densities for this green density.
      let nr;
      let nb;
      const t = (l1 - refLo) * invSpan;
      if (t <= 0) { nr = refR[0]; nb = refB[0]; } else if (t >= samples - 1) { nr = refR[samples - 1]; nb = refB[samples - 1]; } else {
        const k = t | 0;
        const f = t - k;
        nr = refR[k] + (refR[k + 1] - refR[k]) * f;
        nb = refB[k] + (refB[k + 1] - refB[k]) * f;
      }
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

  // `fx` (optional, see `look`): grainSize makes the grains bigger, grainGain stronger.
  function grainSetup(F, w, seedBase = 0x5eed, fx = null) {
    const G = F.grain;
    const rawCell = G.size * ((fx && fx.grainSize) || 1) / (F.frameWidthMm * 1000) * w;
    const inv = 1 / Math.max(1, rawCell);
    const w2 = Math.min(Math.max(G.roughness, 0), 1) * 0.5;
    const channels = [0, 1, 2].map((c) => {
      const amp = (G.amplitude[c] || 0) * ((fx && fx.grainGain) || 1) * Math.min(1, rawCell);
      const seed = (seedBase + Math.imul(c, 0x9e3779b9)) >>> 0;
      return { amp, seed, seed2: (seed + 0x68bc21eb) >>> 0 };
    });
    return { G, inv, inv2: inv * 2, w1: 1 - w2, w2, channels };
  }

  function grainValue(g, ch, x, y) {
    let v = g.w1 * valueNoise(x * g.inv, y * g.inv, ch.seed);
    if (g.w2 > 0) v += g.w2 * valueNoise(x * g.inv2, y * g.inv2, ch.seed2);
    return v;
  }

  // The grain field's mean and scale per channel (normalizeToUnitRMS), from the same samples of
  // the whole frame as rolls takes, so a strip of the frame gets the same grain as the whole.
  function grainStats(F, w, h, fx = null) {
    const g = grainSetup(F, w, undefined, fx);
    const count = w * h;
    const stride = Math.max(1, Math.floor(count / 200000));
    return g.channels.map((ch) => {
      if (!(ch.amp > 0)) return null;
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < count; i += stride) {
        const v = Math.fround(grainValue(g, ch, i % w, Math.floor(i / w)));
        sum += v; sumSq += v * v; n++;
      }
      const mean = sum / n;
      return { mean, scale: 1 / Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-12)) };
    });
  }

  // `y0` is the first row's place in the frame and `stats` the whole frame's, for a strip.
  function grain(d, w, h, F, referenceDensity, y0 = 0, stats = null, fx = null) {
    const g = grainSetup(F, w, undefined, fx);
    const { G } = g;
    const refD = Math.max(referenceDensity, 0.01);
    const field = new Float32Array(w * h);
    for (let c = 0; c < 3; c++) {
      const ch = g.channels[c];
      const amp = ch.amp;
      if (!(amp > 0)) continue;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) field[y * w + x] = grainValue(g, ch, x, y + y0);
      }
      let mean;
      let scale;
      if (stats) {
        ({ mean, scale } = stats[c]);
      } else {
        // normalizeToUnitRMS
        const stride = Math.max(1, Math.floor(field.length / 200000));
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let i = 0; i < field.length; i += stride) { sum += field[i]; sumSq += field[i] * field[i]; n++; }
        mean = sum / n;
        scale = 1 / Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-12));
      }
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
  //             integrated to grey (rolls' Noritsu profile, for scene-linear RAW input). Held
  //             back where that would print the highlights white (HIGHLIGHT_GUARD).
  //   'photo' - for a finished photo, where the photographer already chose the brightness and
  //             the white balance: the film's own mid-grey at the rated exposure prints mid-grey
  //             (an enlarger set once for the roll), and the colour is printed faithfully.
  // The negative's pixels the print decision looks at: every `step`-th of the frame, in order.
  // `from`/`to` (pixel indices in the frame) and `offset` (the frame index of d's first pixel)
  // take them from a strip.
  const printStep = (count) => Math.max(1, Math.floor(count / 120000));
  function printSamples(d, step, from, to, offset = 0) {
    const first = Math.ceil(from / step) * step;
    const out = new Float32Array(Math.max(0, Math.ceil((to - first) / step)) * 3);
    let k = 0;
    for (let i = first; i < to; i += step) {
      const j = (i - offset) * 3;
      out[k++] = d[j]; out[k++] = d[j + 1]; out[k++] = d[j + 2];
    }
    return out.subarray(0, k);
  }

  function printExposures(d, count, F, printStops, opts = {}) {
    return printExposuresFromSamples(printSamples(d, printStep(count), 0, count), F, printStops, opts);
  }

  function printExposuresFromSamples(samples, F, printStops, opts = {}) {
    const sums = [0, 0, 0];
    const luma = [];
    for (let i = 0; i < samples.length; i += 3) {
      const r = samples[i];
      const g = samples[i + 1];
      const b = samples[i + 2];
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
      if (n && F.rawPrint && opts.exposureStops) {
        const grey = (stops) => {
          const logH = F.logHReference + (F.ratingStops + stops) * 0.30103;
          return [0, 1, 2].reduce((a, c) => a + lookup(F.neg.rows[c], F.neg.xMin, F.neg.xMax, logH), 0) / 3;
        };
        level -= F.rawPrint.exposure * (grey(opts.exposureStops) - grey(0));
      }
      for (const [share, above] of (n ? F.highlightGuard || [] : [])) {
        level = Math.max(level, luma[Math.min(n - 1, Math.floor(n * share))] - above);
      }
    }
    const t = F.paperCurve.midtoneLogH + F.printProfile.exposureStops * 0.30103;
    const K = [0, 1, 2].map((c) => t + level + (1 - mix) * faithful[c] + mix * grey[c] + balance[c] + printStops * 0.30103);
    // The print decision's further numbers, where the frame needs them: the highlight
    // protection and the Highlights slider's lift; for RAW, the shoulder's strength in place of
    // the protection, and its knee (a sixth number, which also tells printInto it is RAW).
    const roll = photo || !n ? null : F.highlightRoll;
    const h = Math.min(Math.max(opts.highlights || 0, -1), 1);
    if (roll) {
      const top = luma[Math.min(n - 1, Math.floor(n * roll.share))] - level - printStops * 0.30103;
      const bend = top > roll.target ? Math.min(1 / (roll.target - roll.knee) - 1 / (top - roll.knee), roll.most) : 0;
      K.push(bend, h * (h > 0 ? HIGHLIGHT_LIFT.rawUp : HIGHLIGHT_LIFT.rawDown), roll.knee);
    } else if (h) {
      K.push(F.printProfile.highlightProtection, h * (h > 0 ? HIGHLIGHT_LIFT.up : HIGHLIGHT_LIFT.down));
    }
    return K;
  }

  // Writes encoded sRGB: 0..1 floats, or 0..255 RGBA bytes when `rgba` is set.
  // `grade` (0..1, see `look`): that share of the scan look (gradeTable) on top of the print.
  function printInto(d, count, K, F, out, rgba, grade = 0) {
    const { xMin, xMax, rows } = F.paper;
    const pivot = F.paperCurve.midtoneLogH;
    const protect = K.length > 3 ? K[3] : F.printProfile.highlightProtection;
    const lift = K.length > 4 ? K[4] : 0;
    const knee = HIGHLIGHT_LIFT.knee;
    // RAW (a sixth number): the shoulder starts at `start` above mid-grey, not at mid-grey.
    const raw = K.length > 5;
    const start = raw ? K[5] : 0;
    const N = F.lut.size;
    const lut = F.lutTable;
    const lo = F.lut.dLo;
    const hi = F.lut.dHi;
    const s = [0, 0, 0];
    const idx = [0, 0, 0];
    const fr = [0, 0, 0];
    const G = grade > 0 ? gradeTable(raw) : null;
    const gk = grade * 65535;
    const gScale = (GRADE_N - 1) / 65535;
    for (let p = 0; p < count; p++) {
      for (let c = 0; c < 3; c++) {
        let logH = K[c] - d[p * 3 + c];
        if (protect > 0 || lift) {
          let t = pivot - logH;
          if (t > 0) {
            if (protect > 0 && t > start) t = start + (t - start) / (1 + protect * (t - start));
            if (lift) t += lift * t * t / (t + knee);
            logH = pivot - t;
          }
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
      if (G) {
        // The look's change for this colour (trilinear in its table), `grade` of it added.
        for (let c = 0; c < 3; c++) {
          const u = s[c] * gScale;
          const i0 = Math.min(u | 0, GRADE_N - 2);
          idx[c] = i0;
          fr[c] = u - i0;
        }
        let d0 = 0;
        let d1 = 0;
        let d2 = 0;
        for (let corner = 0; corner < 8; corner++) {
          const dr = corner & 1;
          const dg = (corner >> 1) & 1;
          const db = (corner >> 2) & 1;
          const wgt = (dr ? fr[0] : 1 - fr[0]) * (dg ? fr[1] : 1 - fr[1]) * (db ? fr[2] : 1 - fr[2]);
          if (wgt === 0) continue;
          const base = (((idx[2] + db) * GRADE_N + idx[1] + dg) * GRADE_N + idx[0] + dr) * 3;
          d0 += wgt * G[base];
          d1 += wgt * G[base + 1];
          d2 += wgt * G[base + 2];
        }
        s[0] = Math.min(Math.max(s[0] + gk * d0, 0), 65535);
        s[1] = Math.min(Math.max(s[1] + gk * d1, 0), 65535);
        s[2] = Math.min(Math.max(s[2] + gk * d2, 0), 65535);
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

  /* ---------- DNG: Apple ProRAW and other linear DNGs (DNGReader.swift, LosslessJPEG.swift) ---------- */

  const TYPE_SIZE = { 1: 1, 2: 1, 6: 1, 7: 1, 3: 2, 8: 2, 4: 4, 9: 4, 11: 4, 5: 8, 10: 8, 12: 8 };

  function parseDNG(bytes) {
    const n = bytes.length;
    if (n <= 8) throw new Error('not a DNG file');
    let le;
    if (bytes[0] === 0x49 && bytes[1] === 0x49) le = true;
    else if (bytes[0] === 0x4d && bytes[1] === 0x4d) le = false;
    else throw new Error('not a DNG file');
    const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
    const u32 = (o) => (le
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    const i32 = (o) => u32(o) | 0;
    if (u16(2) !== 42) throw new Error('not a DNG file');

    const ifds = [];
    const queue = [u32(4)];
    const seen = new Set();
    while (queue.length) {
      const offset = queue.pop();
      if (!(offset > 0) || offset + 2 > n || seen.has(offset)) continue;
      seen.add(offset);
      const count = u16(offset);
      const entries = new Map();
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        if (e + 12 > n) break;
        entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), offset: e + 8 });
      }
      ifds.push(entries);
      const sub = entries.get(330);
      if (sub) {
        if ((TYPE_SIZE[sub.type] || 1) * sub.count > 4) {
          const base = u32(sub.offset);
          for (let k = 0; k < sub.count; k++) queue.push(u32(base + k * 4));
        } else {
          queue.push(u32(sub.offset));
        }
      }
      if (offset + 2 + count * 12 + 4 <= n) queue.push(u32(offset + 2 + count * 12));
    }

    const where = (e) => ((TYPE_SIZE[e.type] || 1) * e.count <= 4 ? e.offset : u32(e.offset));
    const readInts = (e) => {
      const base = where(e);
      const size = TYPE_SIZE[e.type] || 1;
      if (base < 0 || base + size * e.count > n) return [];
      const out = [];
      for (let i = 0; i < e.count; i++) {
        const o = base + i * size;
        out.push(size === 1 ? bytes[o] : size === 2 ? u16(o) : u32(o));
      }
      return out;
    };
    const readReals = (e) => {
      const base = where(e);
      const size = TYPE_SIZE[e.type] || 1;
      if (base < 0 || base + size * e.count > n) return [];
      const out = [];
      for (let i = 0; i < e.count; i++) {
        const o = base + i * size;
        if (e.type === 5) { const d = u32(o + 4); out.push(d === 0 ? 0 : u32(o) / d); }
        else if (e.type === 10) { const d = i32(o + 4); out.push(d === 0 ? 0 : i32(o) / d); }
        else if (e.type === 11) { const v = new DataView(bytes.buffer, bytes.byteOffset + o, 4); out.push(v.getFloat32(0, le)); }
        else out.push(size === 1 ? bytes[o] : size === 2 ? u16(o) : u32(o));
      }
      return out;
    };
    const readASCII = (e) => {
      const base = where(e);
      if (base < 0 || base + e.count > n) return '';
      let s = '';
      for (let i = 0; i < e.count && bytes[base + i]; i++) s += String.fromCharCode(bytes[base + i]);
      return s;
    };

    const raw = ifds.find((ifd) => {
      const pi = ifd.get(262);
      const v = pi ? readInts(pi)[0] : 0;
      return v === 34892 || v === 32803;
    });
    if (!raw) throw new Error('no raw image in this DNG');
    const lookupTag = (tag, read) => {
      for (const ifd of [raw, ...ifds]) { const e = ifd.get(tag); if (e) return read(e); }
      return [];
    };
    const ints = (tag) => lookupTag(tag, readInts);
    const reals = (tag) => lookupTag(tag, readReals);
    const text = (tag) => { for (const ifd of ifds) { const e = ifd.get(tag); if (e) return readASCII(e); } return ''; };

    const width = ints(256)[0];
    const height = ints(257)[0];
    if (!width || !height) throw new Error('DNG has no image size');
    const bits = ints(258)[0] || 16;
    const white = reals(50717);
    const meta = {
      width, height,
      components: ints(277)[0] || 3,
      bitsPerSample: bits,
      photometric: readInts(raw.get(262))[0],
      compression: raw.get(259) ? readInts(raw.get(259))[0] : -1,
      model: text(50708) || text(272),
      make: text(271),
      linearizationTable: ints(50712),
      blackLevel: reals(50714).length ? reals(50714) : [0],
      whiteLevel: white.length ? white : [(1 << bits) - 1],
      analogBalance: reals(50727),
      colorMatrix1: reals(50721),
      colorMatrix2: reals(50722),
      baselineExposure: reals(50730)[0] || 0,
      orientation: ints(274)[0] || 1,
    };
    const tiles = {
      tw: raw.get(322) ? readInts(raw.get(322))[0] : 0,
      th: raw.get(323) ? readInts(raw.get(323))[0] : 0,
      offsets: raw.get(324) ? readInts(raw.get(324)) : [],
      counts: raw.get(325) ? readInts(raw.get(325)) : [],
    };
    return { bytes, meta, tiles };
  }

  // Only demosaiced (LinearRaw) DNGs with lossless JPEG tiles: Apple ProRAW and similar.
  function dngSupported(dng) {
    const m = dng.meta;
    return m.photometric === 34892 && m.compression === 7 && m.components === 3
      && dng.tiles.tw > 0 && dng.tiles.th > 0 && dng.tiles.offsets.length > 0;
  }

  function huffTable(counts, values) {
    const minCode = new Int32Array(17);
    const maxCode = new Int32Array(17).fill(-1);
    const valPtr = new Int32Array(17);
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len++) {
      const c = counts[len - 1];
      if (c > 0) { valPtr[len] = k; minCode[len] = code; code += c; k += c; maxCode[len] = code - 1; }
      else maxCode[len] = -1;
      code <<= 1;
    }
    if (k > values.length) throw new Error('bad Huffman table');
    // Fast path: the value and length for every 9-bit prefix whose code fits in 9 bits.
    const fast = new Uint16Array(512);
    for (let len = 1; len <= 9; len++) {
      for (let c = minCode[len]; c <= maxCode[len]; c++) {
        const v = values[valPtr[len] + c - minCode[len]] || 0;
        const shift = 9 - len;
        for (let f = 0; f < (1 << shift); f++) fast[(c << shift) | f] = (len << 8) | v | 0x8000;
      }
    }
    return { minCode, maxCode, valPtr, values, fast };
  }

  // One lossless JPEG (SOF3) tile. Returns { width, height, components, samples: Uint16Array }.
  function decodeLJ92(b, start, count) {
    const end = start + count;
    if (b[start] !== 0xff || b[start + 1] !== 0xd8) throw new Error('tile is not a JPEG');
    const tables = new Map();
    let precision = 0;
    let width = 0;
    let height = 0;
    let components = 0;
    let scanTables = [];
    let predictor = 1;
    let pt = 0;
    let restart = 0;
    let haveFrame = false;
    let haveScan = false;
    let p = start + 2;
    while (p + 1 < end) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xd9) break;
      if (p + 4 > end) throw new Error('tile ends early');
      const length = (b[p + 2] << 8) | b[p + 3];
      const seg = p + 4;
      const segEnd = p + 2 + length;
      if (segEnd > end) throw new Error('tile ends early');
      if (marker === 0xc4) {
        let q = seg;
        while (q < segEnd) {
          const id = b[q] & 0x0f;
          const counts = [];
          let total = 0;
          for (let i = 0; i < 16; i++) { counts.push(b[q + 1 + i]); total += b[q + 1 + i]; }
          if (q + 17 + total > segEnd) throw new Error('bad Huffman table');
          tables.set(id, huffTable(counts, b.subarray(q + 17, q + 17 + total)));
          q += 17 + total;
        }
      } else if (marker === 0xc3) {
        precision = b[seg];
        height = (b[seg + 1] << 8) | b[seg + 2];
        width = (b[seg + 3] << 8) | b[seg + 4];
        components = b[seg + 5];
        haveFrame = true;
      } else if ([0xc0, 0xc1, 0xc2, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb].includes(marker)) {
        throw new Error('not a lossless JPEG tile');
      } else if (marker === 0xdd) {
        restart = (b[seg] << 8) | b[seg + 1];
      } else if (marker === 0xda) {
        const ns = b[seg];
        scanTables = Array.from({ length: ns }, (_, i) => b[seg + 2 + 2 * i] >> 4);
        predictor = b[seg + 1 + 2 * ns];
        pt = b[seg + 3 + 2 * ns] & 0x0f;
        haveScan = true;
        p = segEnd;
        break;
      }
      p = segEnd;
    }
    if (!haveFrame || !haveScan) throw new Error('tile has no image');
    if (precision < 2 || precision > 16) throw new Error('unsupported precision');
    const nc = Math.min(components, scanTables.length);
    const huffs = scanTables.map((t) => { const h = tables.get(t); if (!h) throw new Error('bad Huffman table'); return h; });
    const out = new Uint16Array(width * height * nc);
    const seed = 1 << (precision - pt - 1);
    const mask = (1 << precision) - 1;

    let pos = p;
    let buf = 0;
    let bits = 0;
    const fill = () => {
      while (bits <= 24) {
        let byte = 0;
        if (pos < end) {
          byte = b[pos++];
          if (byte === 0xff) {
            const next = pos < end ? b[pos] : 0xd9;
            if (next === 0) pos++;
            else { pos--; byte = 0; }
          }
        }
        buf = ((buf << 8) | byte) >>> 0;
        bits += 8;
      }
    };
    const receive = (nb) => {
      if (nb === 0) return 0;
      if (bits < nb) fill();
      bits -= nb;
      return (buf >>> bits) & ((1 << nb) - 1);
    };
    const decode = (t) => {
      if (bits < 16) fill();
      const f = t.fast[(buf >>> (bits - 9)) & 511];
      if (f & 0x8000) { bits -= (f >> 8) & 0x7f; return f & 0xff; }
      let code = 0;
      for (let len = 1; len <= 16; len++) {
        code = (code << 1) | ((buf >>> (bits - 1)) & 1);
        bits--;
        if (t.maxCode[len] >= code && code >= t.minCode[len]) {
          const i = t.valPtr[len] + code - t.minCode[len];
          return i < t.values.length ? t.values[i] : 0;
        }
        if (bits < 1) fill();
      }
      return 0;
    };

    let since = 0;
    for (let y = 0; y < height; y++) {
      const row = y * width * nc;
      const above = (y - 1) * width * nc;
      for (let x = 0; x < width; x++) {
        const here = row + x * nc;
        for (let c = 0; c < nc; c++) {
          const sz = decode(huffs[c]);
          let diff = receive(sz);
          if (sz !== 0 && diff < (1 << (sz - 1))) diff = diff - (1 << sz) + 1;
          let pred;
          if (x === 0) pred = y === 0 ? seed : out[above + c];
          else if (y === 0) pred = out[here - nc + c];
          else {
            const a = out[here - nc + c];
            const bb = out[above + x * nc + c];
            const cc = out[above + (x - 1) * nc + c];
            switch (predictor) {
              case 2: pred = bb; break;
              case 3: pred = cc; break;
              case 4: pred = a + bb - cc; break;
              case 5: pred = a + ((bb - cc) >> 1); break;
              case 6: pred = bb + ((a - cc) >> 1); break;
              case 7: pred = (a + bb) >> 1; break;
              default: pred = a;
            }
          }
          out[here + c] = (pred + diff) & mask;
        }
        if (restart > 0 && ++since === restart) {
          since = 0;
          bits = 0;
          buf = 0;
          while (pos + 1 < end) {
            if (b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7) { pos += 2; break; }
            pos++;
          }
        }
      }
    }
    return { width, height, components: nc, samples: out };
  }

  // Linear light, box-downsampled by `ds` as it is decoded (so the full frame never has to be
  // held), normalised to 0..1 by the black and white levels. Interleaved RGB, unrotated.
  function decodeDNG(dng, ds = 1, progress) {
    const { bytes, meta: m, tiles } = dng;
    const nc = m.components;
    const outW = Math.floor(m.width / ds);
    const outH = Math.floor(m.height / ds);
    const sums = new Float32Array(outW * outH * nc);
    const lut = m.linearizationTable;
    const black = m.blackLevel[0] || 0;
    const scale = 1 / Math.max((m.whiteLevel[0] ?? 65535) - black, 1);
    const level = new Float32Array(1 << Math.min(m.bitsPerSample, 16));
    for (let v = 0; v < level.length; v++) level[v] = ((lut.length ? lut[Math.min(v, lut.length - 1)] : v) - black) * scale;
    const across = Math.ceil(m.width / tiles.tw);
    const total = Math.min(tiles.offsets.length, tiles.counts.length);
    const xLimit = outW * ds;
    const yLimit = outH * ds;
    for (let t = 0; t < total; t++) {
      if (progress && t % 16 === 0) progress(t / total);
      const start = tiles.offsets[t];
      const length = tiles.counts[t];
      if (start < 0 || start + length > bytes.length) continue;
      const frame = decodeLJ92(bytes, start, length);
      const tx = (t % across) * tiles.tw;
      const ty = Math.floor(t / across) * tiles.th;
      const fw = frame.width * frame.components;
      for (let row = 0; row < frame.height; row++) {
        const y = ty + row;
        if (y >= yLimit) break;
        const oy = Math.floor(y / ds) * outW;
        const width = Math.min(frame.width, xLimit - tx);
        const s = row * fw;
        for (let x = 0; x < width; x++) {
          const o = (oy + Math.floor((tx + x) / ds)) * nc;
          const si = s + x * frame.components;
          for (let c = 0; c < nc; c++) sums[o + c] += level[frame.samples[si + c]];
        }
      }
    }
    if (ds > 1) { const inv = 1 / (ds * ds); for (let i = 0; i < sums.length; i++) sums[i] *= inv; }
    return { rgb: sums, width: outW, height: outH };
  }

  /* ---------- Matrices (ColorTransform.swift) ---------- */

  const mul3 = (a, b) => {
    const o = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    return o;
  };
  const inv3 = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  };
  const normalized = (m, target) => {
    const out = m.slice();
    for (let r = 0; r < 3; r++) {
      const got = m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2];
      for (let c = 0; c < 3; c++) out[r * 3 + c] *= target[r] / got;
    }
    return out;
  };
  const D50 = [0.96422, 1.0, 0.82521];

  // Camera RGB -> XYZ(D50) for a ProRAW frame (ColorTransform.cameraToXYZ), then on to film
  // layer exposure with neutral pinned to neutral (FilmPipeline.init).
  function cameraToLayers(F, m) {
    const cm1 = m.colorMatrix1.length === 9 ? m.colorMatrix1 : null;
    const cm2 = m.colorMatrix2.length === 9 ? m.colorMatrix2 : null;
    let mix = 1;
    if (m.analogBalance.length === 3 && m.analogBalance[0] > 0 && m.analogBalance[2] > 0) {
      mix = Math.min(1, Math.max(0, 0.5 - Math.log(m.analogBalance[2] / m.analogBalance[0]) * 1.2));
    }
    let cm = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (cm1 && cm2) cm = cm1.map((v, i) => v * (1 - mix) + cm2[i] * mix);
    else cm = cm1 || cm2 || cm;
    const ab = m.analogBalance.length === 3
      ? [m.analogBalance[0], 0, 0, 0, m.analogBalance[1], 0, 0, 0, m.analogBalance[2]]
      : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const toXYZ = normalized(inv3(mul3(ab, cm)), D50);
    const layers = normalized(mul3(F.filmMatrix, toXYZ), [1, 1, 1]);
    return { toXYZ, layers: F.rawFit ? mul3(F.rawFit, layers) : layers };
  }

  // Rotate/flip RGBA bytes by an EXIF orientation (Darkroom.encode).
  function orientRGBA(src, w, h, orientation) {
    if (!(orientation > 1 && orientation <= 8)) return { rgba: src, width: w, height: h };
    const swaps = orientation >= 5;
    const ow = swaps ? h : w;
    const oh = swaps ? w : h;
    const out = new Uint8ClampedArray(ow * oh * 4);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
    const o32 = new Uint32Array(out.buffer);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let dx;
        let dy;
        switch (orientation) {
          case 2: dx = w - 1 - x; dy = y; break;
          case 3: dx = w - 1 - x; dy = h - 1 - y; break;
          case 4: dx = x; dy = h - 1 - y; break;
          case 5: dx = y; dy = x; break;
          case 6: dx = h - 1 - y; dy = x; break;
          case 7: dx = h - 1 - y; dy = w - 1 - x; break;
          default: dx = y; dy = w - 1 - x;
        }
        o32[dy * ow + dx] = s32[y * w + x];
      }
    }
    return { rgba: out, width: ow, height: oh };
  }

  /* ---------- The whole develop ---------- */

  // rgb: scene-linear RGB (interleaved, Float32Array), turned into the negative's densities in
  // place. primaries: 'sRGB' or 'displayP3'.
  function developNegative(F, rgb, w, h, opts = {}) {
    const report = opts.progress || (() => {});
    const count = w * h;
    // opts.matrix: camera -> film layers for a RAW frame; otherwise the display primaries'.
    const m = opts.matrix || F.layers[opts.primaries === 'displayP3' ? 'displayP3' : 'sRGB'];
    const gain = Math.pow(2, (opts.exposureStops || 0) + (opts.baselineExposure || 0) + F.ratingStops);
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
    if (opts.exposeOnly) return rgb;
    if (opts.spatial !== false) {
      report('halation');
      halation(rgb, w, h, F, opts.preview ? 2 : 1, opts.fx);
    }
    return opts.halationOnly ? rgb : developStrip(F, rgb, w, h, opts);
  }

  // Everything after halation: each pixel only needs its neighbours within stripMargin rows, so
  // this can run on strips of the frame in parallel. `strip`: { y0, stats } for a strip that
  // starts at row y0 of the frame, with the frame's grain statistics.
  function developStrip(F, rgb, w, h, opts = {}, strip = null) {
    const report = opts.progress || (() => {});
    const count = w * h;
    const spatial = opts.spatial !== false;
    if (spatial) {
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
      if (opts.grain !== false) grain(rgb, w, h, F, F.reference[1], strip ? strip.y0 : 0, strip ? strip.stats : null, opts.fx);
    }
    return rgb;
  }

  // Rows a strip needs above and below the rows it keeps: the sharpness kernel's reach plus the
  // couplers' blur.
  function stripMargin(F, w) {
    let reach = 0;
    for (let c = 0; c < 3; c++) reach = Math.max(reach, (mtfHalfKernel(F, c, w) || [0]).length - 1);
    const sigma = F.couplers.radius / (F.frameWidthMm * 1000) * w;
    for (const size of boxSizes(sigma)) reach += (size - 1) >> 1;
    return reach + 2;
  }

  function printWithK(F, d, count, K, rgba, grade = 0) {
    printInto(d, count, K, F, rgba, true, grade);
    return rgba;
  }

  // Prints a negative. With `rgba` (a Uint8ClampedArray of w * h * 4) it writes display bytes
  // there; otherwise it returns encoded sRGB floats. Returns the print exposure K as well.
  function printNegative(F, d, w, h, printStops = 0, rgba = null, opts = {}) {
    const count = w * h;
    const K = printExposures(d, count, F, printStops, opts);
    const out = rgba || new Float32Array(count * 3);
    printInto(d, count, K, F, out, Boolean(rgba), opts.grade || 0);
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
    // Each channel's curve stops at `knee`, where it turns steep (the paper's shoulder: the last
    // tenth of a stop of brightness costs stops of light). Brighter pixels are taken the rest of
    // the way by photoLight, which needs each code value's linear light (`light`) and, for a
    // pixel of luminance knee..1, how many times more light it gets (`lift`): the curve's own
    // rise up to the paper's white (cap), then a stretch of 2 stops into highlights.
    const top = invert(cap);
    const knee = dec(PHOTO_KNEE / 255);
    const atKnee = invert(knee);
    const table = new Float32Array(256);
    const light = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      light[v] = dec(v / 255);
      table[v] = invert(Math.min(light[v], knee));
    }
    const lift = new Float32Array(PHOTO_LIFT_STEPS + 1);
    for (let i = 0; i <= PHOTO_LIFT_STEPS; i++) {
      const y = knee + (1 - knee) * i / PHOTO_LIFT_STEPS;
      lift[i] = (y <= cap ? invert(y) : top * Math.pow(2, 2 * (y - cap) / (1 - cap))) / atKnee;
    }
    table.light = light;
    table.knee = knee;
    table.lift = lift;
    return table;
  }

  // The 8-bit value where a finished photo's channels stop being decoded one by one.
  const PHOTO_KNEE = 245;
  const PHOTO_LIFT_STEPS = 1024;

  // Scene light for a finished photo's pixels (`src`: RGBA bytes) through photoTransfer's
  // `table`. `boost` (optional): each pixel's HDR gain.
  // Near white the curve is steep: 245 to 255 is 2.6 stops of light, so lamps and the sun still
  // bloom. That part goes by the pixel's luminance and lifts its three channels alike, so a grey
  // or white pixel gets exactly the curve. Done channel by channel it sent one clipped channel
  // stops up on its own: the red glow round a setting sun (255, 200, 50) printed as a flat pale
  // disc with a hard edge where the red left 255.
  function photoLight(table, src, count, boost = null) {
    const { light, knee, lift } = table;
    const scale = PHOTO_LIFT_STEPS / (1 - knee);
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = src[i * 4];
      const g = src[i * 4 + 1];
      const b = src[i * 4 + 2];
      let k = boost ? boost[i] : 1;
      const y = 0.2126 * light[r] + 0.7152 * light[g] + 0.0722 * light[b];
      if (y > knee) {
        const u = Math.min((y - knee) * scale, PHOTO_LIFT_STEPS);
        const j = Math.min(u | 0, PHOTO_LIFT_STEPS - 1);
        k *= lift[j] + (lift[j + 1] - lift[j]) * (u - j);
      }
      rgb[i * 3] = table[r] * k;
      rgb[i * 3 + 1] = table[g] * k;
      rgb[i * 3 + 2] = table[b] * k;
    }
    return rgb;
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

  /* ---------- Strength: the scan look (not in rolls) ---------- */

  // The film as calibrated gives a finished photo back almost as it was: photoTransfer undoes
  // the contrast, photoBalance the cast, and Portra's colour is close to true. What people know
  // as the look of film is mostly the lab's scan of it. This is that look, designed by eye and
  // not measured: matte blacks and a soft shoulder, shadows toward teal and highlights toward
  // peach, greens toward olive, blues toward cyan, reds toward orange, and paler highlights.
  // It is applied to the print, after everything that keeps the photo as it was.
  const GRADE = {
    // Lightness as an encoded grey, in -> out.
    tone: [[0, 0.16], [0.1, 0.21], [0.25, 0.305], [0.5, 0.555], [0.75, 0.815], [0.9, 0.905], [1, 0.94]],
    // Hue windows in Oklab: centre and half-width (degrees), hue shift (degrees), colour factor,
    // lightness shift.
    hues: [
      [140, 55, -22, 0.72, -0.015], // greens
      [255, 55, -20, 0.8, 0.03], // blues
      [25, 35, 10, 0.95, 0], // reds
      [62, 30, 0, 1.08, 0], // skin and oranges
    ],
    // Tints (Oklab a, b) for the shadows, the midtones and the highlights.
    shadow: [-0.028, -0.012],
    mid: [0.006, 0.018],
    highlight: [0.01, 0.042],
    pastel: 0.3, // colour taken out of the highlights
    muted: 0.12, // and out of the shadows
    colour: 1.05,
  };
  /* The same look for RAW. A finished photo arrives with its camera's contrast and colour, and
     the look softens them; RAW arrives as the film printed it, already soft, so here the look
     keeps the print's blacks and whites and most of its colour. */
  const GRADE_RAW = {
    ...GRADE,
    tone: [[0, 0.03], [0.1, 0.115], [0.25, 0.26], [0.5, 0.53], [0.75, 0.795], [0.9, 0.93], [1, 0.985]],
    pastel: 0.15,
    muted: 0.04,
    colour: 1.12,
  };
  const GRADE_N = 33;

  // A smooth curve through points that never turns back (monotone cubic, Fritsch-Carlson).
  function monotoneCurve(points) {
    const n = points.length;
    const x = points.map((p) => p[0]);
    const y = points.map((p) => p[1]);
    const d = [];
    const m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (v) => {
      if (v <= x[0]) return y[0];
      if (v >= x[n - 1]) return y[n - 1];
      let i = 0;
      while (v > x[i + 1]) i++;
      const h = x[i + 1] - x[i];
      const t = (v - x[i]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  // The look at full strength as the change it makes to each encoded sRGB colour, on a
  // GRADE_N-cubed grid (red fastest, then green, then blue). Built once, on first use.
  const gradeCache = [null, null];
  function gradeTable(raw = false) {
    if (gradeCache[raw ? 1 : 0]) return gradeCache[raw ? 1 : 0];
    const P = raw ? GRADE_RAW : GRADE;
    const N = GRADE_N;
    const RAD = Math.PI / 180;
    const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    const clip = (v) => enc(Math.min(1, Math.max(0, v)));
    const tone = monotoneCurve(P.tone);
    const table = new Float32Array(N * N * N * 3);
    let o = 0;
    for (let bi = 0; bi < N; bi++) {
      for (let gi = 0; gi < N; gi++) {
        for (let ri = 0; ri < N; ri++) {
          const r = ri / (N - 1);
          const g = gi / (N - 1);
          const b = bi / (N - 1);
          // To Oklab (Ottosson 2020): lightness L, green-red a, blue-yellow b.
          const R = dec(r);
          const Gn = dec(g);
          const B = dec(b);
          const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * Gn + 0.0514459929 * B);
          const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * Gn + 0.1073969566 * B);
          const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * Gn + 0.6299787005 * B);
          let L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
          let A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
          let Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
          // Hues: each window turns, quiets and lightens its colours, most at its centre. Greys
          // are left alone.
          let C = Math.hypot(A, Bb);
          let h = Math.atan2(Bb, A) / RAD;
          if (h < 0) h += 360;
          const gate = C / (C + 0.03);
          let turn = 0;
          let scale = 1;
          let lift = 0;
          for (const [centre, width, shift, colour, light] of P.hues) {
            let dist = Math.abs(h - centre);
            if (dist > 180) dist = 360 - dist;
            if (dist >= width) continue;
            const w = Math.cos((dist / width) * 90 * RAD) ** 2 * gate;
            turn += w * shift;
            scale *= 1 + w * (colour - 1);
            lift += w * light;
          }
          h = (h + turn) * RAD;
          C *= scale * P.colour;
          L += lift;
          // Tone, on the lightness as an encoded grey.
          L = Math.cbrt(dec(tone(enc(Math.min(1, Math.max(0, L)) ** 3))));
          // Paler highlights, quieter shadows, and the three tints.
          const wh = L * L;
          const ws = (1 - L) * (1 - L);
          const wm = 4 * L * (1 - L);
          C *= 1 - P.pastel * wh - P.muted * ws;
          A = C * Math.cos(h) + ws * P.shadow[0] + wm * P.mid[0] + wh * P.highlight[0];
          Bb = C * Math.sin(h) + ws * P.shadow[1] + wm * P.mid[1] + wh * P.highlight[1];
          const l3 = (L + 0.3963377774 * A + 0.2158037573 * Bb) ** 3;
          const m3 = (L - 0.1055613458 * A - 0.0638541728 * Bb) ** 3;
          const s3 = (L - 0.0894841775 * A - 1.291485548 * Bb) ** 3;
          table[o++] = clip(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3) - r;
          table[o++] = clip(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3) - g;
          table[o++] = clip(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3) - b;
        }
      }
    }
    gradeCache[raw ? 1 : 0] = table;
    return table;
  }

  // What a Strength s (0 to 1) asks of a develop. At 0, nothing: the film as calibrated. Above it,
  // `grade` is the share of the scan look for the print, and `fx` makes grain and halation
  // stronger and larger, as from a smaller negative. The slider's first half does most of it.
  // GRAIN_TASTE: the user's pick, grain a fifth weaker than first designed.
  const GRAIN_TASTE = 0.8;
  function look(s) {
    const v = Math.min(Math.max(Number(s) || 0, 0), 1);
    if (!(v > 0)) return { grade: 0, fx: null };
    const k = Math.pow(v, 0.6);
    return { grade: k, fx: { grainGain: GRAIN_TASTE * (1 + 1.2 * k), grainSize: 1 + 2.5 * k, halationGain: 1 + 4 * k, halationSize: 1 + 1.5 * k } };
  }

  const api = { prepare, develop, developNegative, printNegative, photoTransfer, photoLight, look,
    developStrip, stripMargin, halationPlan, halationApply, convolveFFT, grainStats, printStep, printSamples, printExposuresFromSamples, printWithK,
    parseDNG, dngSupported, decodeDNG, cameraToLayers, orientRGBA };
  root.FilmEngine = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

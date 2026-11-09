// Fits and checks the Film engine's calibration to real Portra 400 (PORTRA_FIT in public/film.js).
//
//   node tools/film/portra/fit.js check        # the engine as shipped vs the scans
//   node tools/film/portra/fit.js raw [reg]    # fit the ProRAW matrix (default reg 8)
//   node tools/film/portra/fit.js photo [reg]  # fit the finished-photo matrix
//
// The ColorChecker (X-Rite reference values) is exposed through the engine as 32 px patches with
// couplers and sharpness on, grain and halation off. Each print is grey-timed: K is set so
// neutral 5 prints neutral at the scan's own L*, as a lab times a frame on the grey card. Scores
// are mean CIEDE2000 against each scan (colour patches weight 1, greys 0.5, clipped patches
// skipped). Fits start from rolls' data (calibrated: false) and print a matrix for PORTRA_FIT.
const path = require('path');
const C = require('./color.js');
const SITE = path.join(__dirname, '../../../public');
globalThis.self = globalThis;
require(SITE + '/film-data.js');
const E = require(SITE + '/film.js');
const SCANS = require('./scans.json');
const [mode = 'check', regArg] = process.argv.slice(2);
const F = E.prepare(self.FILM_DATA, { calibrated: mode === 'check' });

const P = 32;
const W = 6 * P;
const H = 4 * P;
const mul3 = (a, b) => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), K = d * h - e * g, det = a * A + b * B + c * K;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det,
    -(a * f - c * d) / det, K / det, -(a * h - b * g) / det, (a * e - b * d) / det];
};

// Mean negative density of each patch for scene light `scene` (linear RGB per patch).
function negative(stops, scene, matrix) {
  const rgb = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(scene[Math.floor(y / P) * 6 + Math.floor(x / P)], (y * W + x) * 3);
  E.developNegative(F, rgb, W, H, { exposureStops: stops, spatial: false, exposeOnly: true, matrix });
  E.developStrip(F, rgb, W, H, { spatial: true, grain: false });
  const out = [];
  for (let p = 0; p < 24; p++) {
    const px = (p % 6) * P, py = Math.floor(p / 6) * P, s = [0, 0, 0];
    for (let y = py + 8; y < py + 24; y++) for (let x = px + 8; x < px + 24; x++) for (let c = 0; c < 3; c++) s[c] += rgb[(y * W + x) * 3 + c];
    out.push(s.map((v) => v / 256));
  }
  return out;
}
function print(dens, K) {
  const d = new Float32Array(dens.length * 3);
  dens.forEach((v, i) => d.set(v, i * 3));
  const out = new Float32Array(dens.length * 4);
  E.printWithK(F, d, dens.length, K, out);
  return dens.map((_, i) => [0, 1, 2].map((c) => (out[i * 4 + c] - 0.5) / 255));
}
// K so that neutral 5 prints neutral at L* = targetL.
function timedK(dens, targetL) {
  const n5 = [dens[21]];
  const v = C.enc(Math.pow((targetL + 16) / 116, 3));
  const K = [0, 1, 2].map((c) => dens[21][c] + F.paperCurve.midtoneLogH);
  for (let round = 0; round < 8; round++) {
    for (let c = 0; c < 3; c++) {
      let lo = K[c] - 1.5, hi = K[c] + 1.5;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2, k = K.slice();
        k[c] = mid;
        if (print(n5, k)[0][c] > v) lo = mid; else hi = mid;
      }
      K[c] = (lo + hi) / 2;
    }
  }
  return K;
}

// A ProRAW frame of the chart from a camera that records linear sRGB.
const SRGB_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const rawLayers = () => E.cameraToLayers(F, { colorMatrix1: inv3(SRGB_D50), colorMatrix2: [], analogBalance: [] }).layers;
// A finished photo of the chart: 8-bit sRGB through photoTransfer.
const photoTable = E.photoTransfer(F);
const photoScene = C.CC_LIN.map((v) => v.map((x) => photoTable[Math.round(255 * C.enc(Math.min(1, Math.max(0, x))))]));

function score(densFor) {
  let s = 0, n = 0;
  const per = [];
  for (const scan of SCANS) {
    const dens = densFor(scan);
    const lab = print(dens, timedK(dens, scan.greyL)).map(C.encToLab);
    for (let i = 0; i < 24; i++) {
      if (scan.clipped.includes(i + 1)) continue;
      const w = i < 18 ? 1 : 0.5, d = C.de2000(scan.lab[i], lab[i]);
      s += w * d; n += w;
      (per[i] ||= []).push({ eng: lab[i], film: scan.lab[i] });
    }
  }
  return { mean: s / n, per };
}
const raw = (matrix) => score((scan) => negative(scan.ev - F.ratingStops, C.CC_LIN, matrix));
const photo = (matrix) => { const dens = negative(0, photoScene, matrix); return score(() => dens); };

const med = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function report(label, r) {
  const cx = [];
  console.log(`${label}: mean dE ${r.mean.toFixed(2)}`);
  for (let i = 0; i < 18; i++) {
    const p = r.per[i], L = p.map((x) => [C.LCh(x.eng), C.LCh(x.film)]);
    cx.push(med(L.map(([e, f]) => e[1] / f[1])));
    console.log(`  ${C.NAMES[i].padEnd(13)} dL ${med(L.map(([e, f]) => e[0] - f[0])).toFixed(1).padStart(5)}  chroma x${cx[i].toFixed(2)}  dh ${med(L.map(([e, f]) => C.dHue(f[2], e[2]))).toFixed(0).padStart(4)}`);
  }
  console.log(`  median chroma vs film x${med(cx).toFixed(2)}`);
}

// Neutral-preserving 3x3 from its six off-diagonal terms (rows sum to 1).
function Tof(p) {
  const T = [0, p[0], p[1], p[2], 0, p[3], p[4], p[5], 0];
  for (let r = 0; r < 3; r++) T[r * 4] = 1 - T[r * 3] - T[r * 3 + 1] - T[r * 3 + 2];
  return T;
}
function nelderMead(f, x0, step, iters) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; pts.push(x); }
  let vals = pts.map((x) => f(x));
  for (let k = 0; k < iters; k++) {
    const ord = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = ord.map((i) => pts[i]); vals = ord.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const at = (t) => c.map((v, j) => v + t * (pts[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < vals[0]) { const xe = at(-2), fe = f(xe); [pts[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr]; }
    else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
    else {
      const xc = at(0.5), fc = f(xc);
      if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
      else { for (let i = 1; i <= n; i++) pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals = pts.map((x) => f(x)); }
    }
  }
  return pts[0];
}

if (mode === 'check') {
  report('ProRAW path', raw(rawLayers()));
  report('Finished-photo path', photo(F.layers.sRGB));
} else {
  const reg = +(regArg || 8);
  const base = mode === 'raw' ? rawLayers() : F.layers.sRGB;
  const run = mode === 'raw' ? raw : photo;
  console.log('rolls as baked: mean dE', run(base).mean.toFixed(2));
  const p = nelderMead((x) => run(mul3(Tof(x), base)).mean + reg * x.reduce((a, v) => a + v * v, 0), [0, 0, 0, 0, 0, 0], 0.05, 500);
  const T = Tof(p.map((v) => +v.toFixed(4))).map((v) => +v.toFixed(4));
  report(`fitted (reg ${reg})`, run(mul3(T, base)));
  console.log(`${mode}: [${T.join(', ')}],`);
}

// Colour maths: ColorChecker reference (X-Rite, post-Nov-2014 formulation, L*a*b* D50),
// sRGB <-> XYZ(D65) <-> Lab(D65), Bradford D50->D65, CIEDE2000.
const CC_LAB_D50 = [
  [37.54, 14.37, 14.92], [64.66, 19.27, 17.5], [49.32, -3.82, -22.54], [43.46, -12.74, 22.72],
  [54.94, 9.61, -24.79], [70.48, -32.26, -0.37], [62.73, 35.83, 56.5], [39.43, 10.75, -45.17],
  [50.57, 48.64, 16.67], [30.1, 22.54, -20.87], [71.77, -24.13, 58.19], [71.51, 18.24, 67.37],
  [28.37, 15.42, -49.8], [54.38, -39.72, 32.27], [42.43, 51.05, 28.62], [81.8, 2.67, 80.41],
  [50.63, 51.28, -14.12], [49.57, -29.71, -28.32], [95.19, -1.03, 2.93], [81.29, -0.57, 0.44],
  [66.89, -0.75, -0.06], [50.76, -0.13, 0.14], [35.63, -0.46, -0.48], [20.64, 0.07, -0.46],
];
const NAMES = ['dark skin', 'light skin', 'blue sky', 'foliage', 'blue flower', 'bluish green',
  'orange', 'purplish blue', 'moderate red', 'purple', 'yellow green', 'orange yellow',
  'blue', 'green', 'red', 'yellow', 'magenta', 'cyan',
  'white', 'neutral 8', 'neutral 6.5', 'neutral 5', 'neutral 3.5', 'black'];
const D50 = [0.96422, 1, 0.82521];
const D65 = [0.95047, 1, 1.08883];
const BRAD = [0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.0204830, 1.3299098];
const XYZ2RGB = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252];
const RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
const mul = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
function labToXYZ([L, a, b], W) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = (t) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  return [W[0] * fi(fx), W[1] * fi(fy), W[2] * fi(fz)];
}
function xyzToLab(X, W = D65) {
  const f = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const [fx, fy, fz] = X.map((v, i) => f(v / W[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const linToLab = (rgb) => xyzToLab(mul(RGB2XYZ, rgb));
const encToLab = (rgb) => linToLab(rgb.map(dec));
// Reference chart as linear sRGB (D65-adapted) reflectances.
const CC_LIN = CC_LAB_D50.map((lab) => mul(XYZ2RGB, mul(BRAD, labToXYZ(lab, D50))));
const CC_LAB_D65 = CC_LIN.map(linToLab);
function de2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * rad / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lbp - 50) ** 2 / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
const LCh = ([L, a, b]) => { let h = Math.atan2(b, a) * 180 / Math.PI; if (h < 0) h += 360; return [L, Math.hypot(a, b), h]; };
const dHue = (h1, h2) => { let d = h2 - h1; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
module.exports = { CC_LAB_D50, CC_LIN, CC_LAB_D65, NAMES, dec, enc, linToLab, encToLab, de2000, LCh, dHue, mul, RGB2XYZ };

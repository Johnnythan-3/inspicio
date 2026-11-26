const fs = require('fs');
const [,, site, out] = process.argv;
globalThis.self = globalThis;
require(site + '/film-data.js');
const E = require(site + '/film.js');
const F = E.prepare(self.FILM_DATA, { calibrated: false });
const f32 = (n) => new Float32Array(fs.readFileSync(`${out}/${n}`).buffer.slice(0));
const W = 384, H = 256;
for (const tag of ['flat', 'full']) {
  const scene = f32('ref-scene.f32');
  const t0 = Date.now();
  const { out: img, K } = E.develop(F, scene, W, H, { spatial: tag === 'full' });
  const ms = Date.now() - t0;
  const neg = scene; // develop wrote densities into the scene buffer
  const refNeg = f32(`ref-${tag}-neg.f32`), refOut = f32(`ref-${tag}-out.f32`);
  const refK = JSON.parse(fs.readFileSync(`${out}/ref-${tag}-k.json`)).K;
  let dn = 0, dnMax = 0, d8 = 0, d8Max = 0, over1 = 0;
  for (let i = 0; i < refNeg.length; i++) {
    const a = Math.abs(neg[i] - refNeg[i]); dn += a; dnMax = Math.max(dnMax, a);
    const b = Math.abs(img[i] - refOut[i]) * 255; d8 += b; d8Max = Math.max(d8Max, b); if (b > 1) over1++;
  }
  console.log(tag, `${ms} ms`, 'K js', K.map(v => v.toFixed(5)), 'swift', refK.map(v => v.toFixed(5)));
  console.log('  negative density: mean err', (dn / refNeg.length).toExponential(2), 'max', dnMax.toExponential(2));
  console.log('  output (0-255): mean err', (d8 / refOut.length).toFixed(3), 'max', d8Max.toFixed(2), '>1 code value:', (100 * over1 / refOut.length).toFixed(2) + '%');
}
{
  const W = 4400, H = 160;
  const scene = f32('ref-wide-scene.f32');
  const t0 = Date.now();
  const { out: img, K } = E.develop(F, scene, W, H, {});
  const refNeg = f32('ref-wide-neg.f32'), refOut = f32('ref-wide-out.f32');
  let dn = 0, dnMax = 0, d8 = 0, d8Max = 0;
  for (let i = 0; i < refNeg.length; i++) {
    const a = Math.abs(scene[i] - refNeg[i]); dn += a; dnMax = Math.max(dnMax, a);
    const b = Math.abs(img[i] - refOut[i]) * 255; d8 += b; d8Max = Math.max(d8Max, b);
  }
  console.log('wide', `${Date.now() - t0} ms`, 'K', K.map(v => v.toFixed(5)), JSON.parse(fs.readFileSync(`${out}/ref-wide-k.json`)).K.map(v => v.toFixed(5)));
  console.log('  negative: mean err', (dn / refNeg.length).toExponential(2), 'max', dnMax.toExponential(2), ' output mean', (d8 / refOut.length).toFixed(3), 'max', d8Max.toFixed(2));
}

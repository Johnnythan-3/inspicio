// Benchmarks film-worker.js in Node (see README). Args: <public dir> <cores> [save.rgba]
const { Worker } = require('worker_threads');
const fs = require('fs');
const [,, dir, cores, save] = process.argv;
const W = 3464, H = 4619;
const mk = () => { const px = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; px[i] = (x * 255 / W) | 0; px[i + 1] = (y * 255 / H) | 0; px[i + 2] = ((x ^ y) & 255); px[i + 3] = 255; } return px; };
const w = new Worker(__dirname + '/worker-shim.js', { workerData: { dir, file: 'film-worker.js', cores: +cores } });
const call = (msg, tr) => new Promise((r) => { const marks = []; const t0 = Date.now(); w.removeAllListeners('message'); w.on('message', (d) => { marks.push((d.stage || (d.error ? 'ERR ' + d.error : 'done')) + '@' + (Date.now() - t0)); if (d.done || d.error) r({ d, marks }); }); w.postMessage(msg, tr); });
(async () => {
  await call({ id: 0, key: 1, pixels: new Uint8ClampedArray(16).buffer, width: 2, height: 2, primaries: 'sRGB', exposureStops: 0, printStops: 0, placement: 'photo', keep: false });
  await new Promise((r) => setTimeout(r, 1500));
  for (let run = 0; run < 2; run++) {
    const p = mk().buffer;
    const { d, marks } = await call({ id: 10 + run, key: 2, pixels: p, width: W, height: H, primaries: 'sRGB', exposureStops: 0, printStops: 0, placement: 'photo', keep: false }, [p]);
    console.log(marks.join(' '));
    if (save && run === 0 && d.rgba) fs.writeFileSync(save, Buffer.from(d.rgba.buffer, d.rgba.byteOffset, d.rgba.byteLength));
  }
  process.exit(0);
})();

// Lets a Web Worker script (film-worker.js) run in a Node worker thread, for tools/film benchmarks.
// Runs a Web Worker script in a Node worker thread: self, postMessage, importScripts, nested Worker.
const { parentPort, workerData, Worker: NodeWorker } = require('worker_threads');
const path = require('path');
const os = require('os');
const dir = workerData.dir;
globalThis.self = globalThis;
if (!globalThis.navigator) globalThis.navigator = {};
try { Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { value: workerData.cores || os.cpus().length }); } catch {}
self.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
self.importScripts = (...files) => files.forEach((f) => require(path.join(dir, f)));
class Worker {
  constructor(file) {
    this.w = new NodeWorker(__filename, { workerData: { dir, file: file.split('?')[0], cores: workerData.cores } });
    this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
    this.w.on('error', (e) => this.onerror && this.onerror({ message: e.message, preventDefault() {} }));
  }
  postMessage(m, t) { this.w.postMessage(m, t); }
  terminate() { this.w.terminate(); }
}
globalThis.Worker = Worker;
parentPort.on('message', (d) => self.onmessage && self.onmessage({ data: d }));
require(path.join(dir, workerData.file));

// A pool of test workers whose size follows measured throughput (TESTS.md 7):
// start at hardwareConcurrency - 1, then every few seconds compare simulated
// seconds per wall second with the last window and keep moving the worker
// count the way that helped; back off when the page's frames get slow.

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class Pool {
  /** fixed: a set worker count (no adapting). */
  constructor(fixed = 0) {
    const hc = navigator.hardwareConcurrency || 4;
    this.max = Math.max(1, Math.min(32, hc * 2));
    this.fixed = fixed;
    this.target = fixed || Math.max(1, hc - 1);
    this.workers = [];            // {w, busy, job, resolve, reject, id}
    this.queue = [];
    this.nextId = 1;
    this.doneSim = 0;             // simulated seconds finished in this window
    this.windowStart = performance.now();
    this.lastRate = 0; this.dir = 1;
    this.rate = 0;                // last measured sim-s per wall-s
    this.frameMs = 16;
    this.onChange = null;
    this.watchFrames();
    this.timer = setInterval(() => this.adapt(), 4000);
  }

  watchFrames() {
    let last = performance.now();
    const f = (now) => { this.frameMs = this.frameMs * 0.9 + Math.min(200, now - last) * 0.1; last = now; if (!this.closed) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }

  /** Run a job in a worker. Resolves with its record. */
  run(job) {
    return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.pump(); });
  }

  spawn() {
    const w = new Worker(WORKER_URL, { type: 'module' }), slot = { w, busy: false, ready: false };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.ready) { slot.ready = true; this.pump(); return; }
      const t = slot.task; slot.busy = false; slot.task = null;
      if (!t) return;
      if (d.rec) { this.doneSim += d.rec.simTime; t.resolve(d.rec); } else t.reject(new Error(d.error));
      this.pump();
    };
    w.onerror = (e) => {
      const t = slot.task; slot.busy = false; slot.task = null;
      if (t) t.reject(new Error('worker error: ' + (e.message || e)));
      this.workers = this.workers.filter((x) => x !== slot); w.terminate();
      this.pump();
    };
    this.workers.push(slot);
  }

  pump() {
    while (this.workers.length < this.target && this.queue.length > this.workers.filter((s) => !s.busy).length) this.spawn();
    for (const slot of this.workers) {
      if (!this.queue.length) break;
      if (slot.busy || !slot.ready) continue;
      const t = this.queue.shift();
      slot.busy = true; slot.task = t;
      slot.w.postMessage({ id: this.nextId++, job: t.job });
    }
    // retire idle workers above the target
    for (const slot of [...this.workers]) {
      if (this.workers.length <= this.target) break;
      if (!slot.busy) { slot.w.terminate(); this.workers = this.workers.filter((x) => x !== slot); }
    }
    if (this.onChange) this.onChange();
  }

  adapt() {
    const now = performance.now(), wall = (now - this.windowStart) / 1000;
    this.rate = this.doneSim / Math.max(1e-3, wall);
    this.doneSim = 0; this.windowStart = now;
    const busy = this.workers.filter((s) => s.busy).length;
    if (this.fixed || !this.queue.length || busy < this.workers.length) { this.lastRate = this.rate; if (this.onChange) this.onChange(); return; }
    if (this.frameMs > 20) { this.dir = -1; this.target = Math.max(1, this.target - 1); }
    else {
      if (this.lastRate > 0 && this.rate < this.lastRate * 0.97) this.dir = -this.dir;    // the last move hurt: go the other way
      this.target = Math.max(1, Math.min(this.max, this.target + this.dir));
    }
    this.lastRate = this.rate;
    this.pump();
  }

  /** Drop everything queued (running jobs finish). */
  cancel() { for (const t of this.queue) t.reject(Object.assign(new Error('cancelled'), { cancelled: true })); this.queue.length = 0; }
  close() { this.cancel(); this.closed = true; clearInterval(this.timer); for (const s of this.workers) s.w.terminate(); this.workers = []; }
  get busy() { return this.workers.filter((s) => s.busy).length; }
}

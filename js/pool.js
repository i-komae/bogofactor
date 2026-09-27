'use strict';
/** Coordinator with a Worker-like interface. Exact quotas, bounded reports and a
 * pause/stop barrier. All completed in-flight tests are included in final counts. */
class SearchPool {
  constructor(url) {
    this.url = url; this.nodes = []; this.job = null; this.dead = false; this.onmessage = null; this.onerror = null;
    this.timer = 0; this.frame = 0; this.outstanding = null; this.seq = 0;
    this._spawn().ready.then(() => { if (!this.dead) this._emit({ type: 'ready', engineKind: this.nodes[0].kind }); }).catch(e => this._error(e));
  }
  _emit(data) { if (!this.dead && this.onmessage) this.onmessage({ data }); }
  _spawn() {
    const node = { worker: new Worker(this.url), kind: null, latest: null, sample: null, fieldSamples: [], prepared: false, stopped: false };
    node.ready = new Promise((resolve, reject) => { node.resolve = resolve; node.reject = reject; });
    node.ready.catch(() => {}); // The pool reports startup failures through its own error channel.
    node.timer = setTimeout(() => {
      const error = Error('A Worker did not initialize in time.');
      node.reject(error); this._error(error);
    }, 15000);
    node.worker.onmessage = e => {
      if (this.dead) return;
      const m = e.data;
      if (m.type === 'ready') { node.kind = m.engineKind; clearTimeout(node.timer); node.resolve(); return; }
      if (m.type === 'error' && !node.kind) {
        clearTimeout(node.timer); const error = Error(m.message);
        node.reject(error); this._error(error); return;
      }
      const j = this.job; if (!j || m.id !== j.id) return;
      if (m.type === 'error') { this._error(Error(m.message)); return; }
      if (m.type === 'screened') { this._screened(j, m).catch(e => this._error(e)); return; }
      if (m.type === 'prepared') {
        node.prepared = true; j.candidateCount = m.candidateCount;
        if (this.nodes.every(n => n.prepared) && j.phase === 'setup') {
          j.phase = 'running'; j.started = performance.now();
          for (const n of this.nodes) n.worker.postMessage({ cmd: 'run', id: j.id });
          this._snapshot('running', true);
        }
        return;
      }
      if (m.type === 'snapshot') {
        node.latest = m;
        if (m.sample) node.sample = m.sample;
        if (m.fieldSamples?.length) {
          node.fieldSamples.push(...m.fieldSamples);
          if (node.fieldSamples.length > 64) node.fieldSamples.splice(0, node.fieldSamples.length - 64);
        }
        // Ack immediately: only one report can be in transit, one stored per node.
        if (m.status === 'running') node.worker.postMessage({ cmd: 'ack', id: j.id, seq: m.seq });
        node.stopped = ['found', 'stopped', 'capped'].includes(m.status);
        if (m.factor && !j.factor) {
          const d = BigInt(m.factor.d), q = BigInt(m.factor.q);
          if (d <= 1n || d >= j.n || d * q !== j.n) { this._error(Error('Coordinator factor verification failed.')); return; }
          j.factor = m.factor; this._stop('found');
        }
        if (j.phase === 'stopping') { if (this.nodes.every(n => n.stopped)) this._finish(j.reason); }
        else if (j.phase === 'pausing') {
          if (this.nodes.every(n => n.stopped)) { this._finish(j.cap ? 'capped' : 'counter-limit'); }
          else if (this.nodes.every(n => n.stopped || n.latest?.status === 'paused')) {
            this._freeze(); j.phase = 'paused'; this._snapshot('paused', true);
          }
        } else if (j.phase === 'running') {
          if (this.nodes.every(n => n.stopped)) this._finish(j.factor ? 'found' : (j.cap ? 'capped' : 'counter-limit'));
          else this._requestSnapshot();
        }
      }
    };
    node.worker.onerror = e => { e.preventDefault(); node.reject(Error(e.message)); this._error(Error(e.message || 'A Worker stopped unexpectedly.')); };
    node.worker.onmessageerror = () => this._error(Error('A Worker message could not be decoded.'));
    this.nodes.push(node); return node;
  }
  async _screened(j, m) {
    if (this.job !== j || j.phase !== 'screening') return;
    j.prepMs = m.prepMs;
    if (m.verdict !== 'composite') { this._finish(m.verdict); return; }
    j.phase = 'setup';
    while (this.nodes.length > j.workers) { const n = this.nodes.pop(); clearTimeout(n.timer); n.worker.terminate(); }
    while (this.nodes.length < j.workers) this._spawn();
    await Promise.all(this.nodes.map(n => n.ready));
    if (this.job !== j || j.phase !== 'setup') return;
    const total = j.cap || ((1n << 64n) - 1n), k = BigInt(this.nodes.length);
    this.nodes.forEach((n, i) => {
      n.latest = null; n.sample = null; n.fieldSamples = []; n.prepared = false; n.stopped = false;
      const quota = total / k + (BigInt(i) < total % k ? 1n : 0n);
      n.worker.postMessage({ cmd: 'setup', id: j.id, n: String(j.n), cap: String(quota),
        sampleInterval: 60 * this.nodes.length, sampleOffset: 60 * i,
        // Five background observations per 50 ms across the WHOLE pool.
        fieldInterval: 50 * this.nodes.length, fieldOffset: 50 * i });
    });
  }
  _elapsed() { const j = this.job; return j ? j.elapsed + (j.started === null ? 0 : performance.now() - j.started) : 0; }
  _freeze() { if (this.job?.started !== null && this.job) { this.job.elapsed = this._elapsed(); this.job.started = null; } }
  _requestSnapshot() {
    if (this.frame || this.outstanding !== null || this.dead) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (this.job?.phase === 'running') this._snapshot('running'); });
  }
  _snapshot(status, force = false) {
    const j = this.job; if (!j) return;
    if (!force && this.outstanding !== null) return;
    const trials = this.nodes.reduce((s, n) => s + BigInt(n.latest?.trials || 0), 0n);
    const ms = this._elapsed();
    if (ms - j.rateAt >= 240 || !j.rates.size) { j.rates.record(trials, ms); j.rateAt = ms; }
    const rate = status === 'running' ? j.rates.value(trials, ms) : status === 'paused' ? null : ms >= 1 ? Number(trials) * 1000 / ms : null;
    const seq = ++this.seq; this.outstanding = status === 'running' ? seq : null;
    this._emit({ type: 'snapshot', id: j.id, seq, n: String(j.n), status, trials: String(trials), elapsedMs: ms,
      prepMs: j.prepMs, rate, rateKind: status === 'running' || status === 'paused' ? 'recent' : 'average',
      cap: String(j.cap), candidateCount: j.candidateCount || '', factor: j.factor,
      workers: this.nodes.map((n, i) => {
        // Transfer each bounded batch once; the log still sees only n.sample.
        const fieldSamples = n.fieldSamples; n.fieldSamples = [];
        return { index: i, state: n.latest?.status || (j.phase === 'setup' ? 'ready' : j.phase),
          rate: n.latest?.rate || 0, trials: n.latest?.trials || '0', sample: n.sample,
          fieldSamples, memoryBytes: n.latest?.memoryBytes || 1048576 };
      }),
      activeWorkers: this.nodes.filter(n => n.latest?.status === 'running').length });
  }
  _finish(status) {
    const j = this.job; if (!j) return;
    clearTimeout(this.timer); this._freeze(); j.phase = 'done'; this.outstanding = null;
    this._snapshot(status, true); this.job = null;
  }
  _stop(reason = 'stopped') {
    const j = this.job; if (!j) return;
    if (j.phase === 'screening' || j.phase === 'setup') {
      this.nodes.forEach(n => n.worker.postMessage({ cmd: 'cancel-screen', id: j.id }));
      // Setup engines are still paused; no trial has started at this point.
      this._finish(reason); return;
    }
    if (j.phase !== 'stopping') {
      j.phase = 'stopping'; j.reason = reason;
      for (const n of this.nodes) n.worker.postMessage({ cmd: 'stop', id: j.id });
    } else if (reason === 'found') j.reason = 'found';
    if (this.nodes.every(n => n.stopped)) this._finish(j.reason);
  }
  _error(error) {
    if (this.dead) return;
    const id = this.job?.id;
    this._emit({ type: 'error', id, message: error.message || String(error) });
    this.terminate();
  }
  postMessage(m) {
    if (this.dead) return;
    if (m.cmd === 'run') {
      if (this.job) { this._error(Error('A search is already active.')); return; }
      const n = BOGO.parse(m.n), cap = BigInt(m.cap);
      if (cap < 0n || cap > (1n << 64n) - 1n) { this._error(Error('Invalid global trial limit.')); return; }
      const maximum = Math.min(32, Math.max(1, navigator.hardwareConcurrency || 2));
      const requested = Math.max(1, Math.min(maximum, Math.floor(Number(m.workers) || 1)));
      const workers = cap && cap < BigInt(requested) ? Number(cap) : requested;
      this.nodes.forEach(node => { node.latest = null; node.sample = null; node.fieldSamples = []; node.stopped = false; node.prepared = false; });
      this.outstanding = null;
      this.job = { id: m.id, n, cap, workers, phase: 'screening', elapsed: 0, started: null, prepMs: 0, factor: null,
        rates: new RateWindow(), rateAt: 0 };
      const j = this.job;
      this._emit({ type: 'screening', id: m.id });
      this.nodes[0].ready.then(() => { if (this.job === j) this.nodes[0].worker.postMessage({ cmd: 'screen', id: j.id, n: String(n) }); }).catch(e => this._error(e));
      return;
    }
    const j = this.job; if (!j || j.id !== m.id) return;
    if (m.cmd === 'ack') { if (this.outstanding === m.seq) { this.outstanding = null; } return; }
    if (m.cmd === 'stop') { this._stop(); return; }
    if (m.cmd === 'pause' && j.phase === 'running') {
      j.phase = 'pausing';
      for (const n of this.nodes) n.worker.postMessage({ cmd: 'pause', id: j.id });
    } else if (m.cmd === 'resume' && j.phase === 'paused') {
      j.phase = 'running'; j.started = performance.now(); this.outstanding = null;
      const trials = this.nodes.reduce((s, n) => s + BigInt(n.latest?.trials || 0), 0n);
      j.rates.reset(trials, j.elapsed); j.rateAt = j.elapsed;
      for (const n of this.nodes) if (!n.stopped) n.worker.postMessage({ cmd: 'resume', id: j.id });
      this._snapshot('running', true);
    }
  }
  terminate() {
    if (this.dead) return;
    this.dead = true; this.job = null; clearTimeout(this.timer); cancelAnimationFrame(this.frame);
    this.nodes.forEach(n => { clearTimeout(n.timer); n.worker.terminate(); }); this.nodes.length = 0;
  }
  get diagnostics() { return { workers: this.nodes.length, outstanding: this.outstanding !== null, phase: this.job?.phase || 'idle' }; }
}

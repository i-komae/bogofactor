'use strict';
/** Worker entry point. Dependencies are serialized from their one canonical
 * implementation; no file-origin fetches or cross-origin imports are required. */
const BogoWorker = (() => {
  function start(engineData) {
    // One independent sampler per Worker. No shared PRNG state and no synthetic counts.
    let engine, seedView, engineKind, job = null, screenToken = 0, scheduled = false;
    const queue = new MessageChannel();
    const count = () => BigInt.asUintN(64, engine.get_trials());
    queue.port1.onmessage = () => { scheduled = false; tick(); };
    const ready = (async () => {
      function load(kind) {
        return Uint8Array.from(atob(engineData[kind]), ch => ch.charCodeAt(0));
      }
      const simd = load('simd');
      engineKind = WebAssembly.validate(simd) ? 'simd' : 'scalar';
      engine = (await WebAssembly.instantiate(engineKind === 'simd' ? simd : load('scalar'), {
        env: { refill() { crypto.getRandomValues(seedView); } }
      })).instance.exports;
      seedView = new Uint32Array(engine.memory.buffer, engine.ptr_seed(), 11);
      BOGO.getResidues();
      postMessage({ type: 'ready', engineKind });
    })();
    function schedule() { if (!scheduled) { scheduled = true; queue.port2.postMessage(0); } }
    function elapsed(j) { return j.elapsedMs + (j.started === null ? 0 : performance.now() - j.started); }
    function freeze(j) { if (j.started !== null) { j.elapsedMs += performance.now() - j.started; j.started = null; } }
    function report(j, status) {
      const t = count(), ms = elapsed(j);
      if (ms - j.rateAt >= 240) { j.rates.record(t, ms); j.rateAt = ms; }
      if (status === 'running' && j.outstanding !== null) return;
      const seq = ++j.sequence;
      j.outstanding = status === 'running' ? seq : null;
      let factor = null;
      if (engine.get_found()) {
        const d = BOGO.read(engine, engine.ptr_divisor(), engine.get_found()), q = j.n / d;
        if (d <= 1n || d >= j.n || d * q !== j.n || j.n % d !== 0n) throw Error('Independent factor verification failed.');
        factor = { d: String(d), q: String(q) };
      }
      postMessage({ type: 'snapshot', id: j.id, seq, status, trials: String(t), elapsedMs: ms,
        rate: status === 'running' ? j.rates.value(t, ms) : null, factor,
        sample: j.samplePending ? j.sample : null, memoryBytes: engine.memory.buffer.byteLength });
      j.samplePending = false;
    }
    function captureSample(j) {
      const trial = count();
      const found = engine.get_found();
      const d = BOGO.read(engine, engine.ptr_divisor(), found || j.divisorWords.length);
      if (d < 2n || d > j.root) throw Error('Sampled divisor is outside the search range.');
      // The completed engine verdict is enough for the visual trace. Never
      // repeat big-integer division solely to produce decorative output.
      j.sample = { trial: String(trial), divisor: String(d), hit: !!found,
        fromTrial: String(j.lastSampleTrial + 1n), tested: String(trial - j.lastSampleTrial) };
      j.lastSampleTrial = trial;
      j.samplePending = true;
    }
    function finish(j, status) { freeze(j); j.paused = true; j.done = true; report(j, status); }
    function tick() {
      const j = job;
      if (!j || j.paused || j.done) return;
      try {
        const rem = j.cap - count();
        if (rem <= 0n) { finish(j, 'capped'); return; }
        const budget = Number(rem < BigInt(j.budget) ? rem : BigInt(j.budget));
        const start = performance.now(), sampleDue = start >= j.nextSample;
        if (sampleDue) {
          // The export stores only the last candidate, not its length. Clear
          // unused high words before ONE normal test so its value is unambiguous
          // even when a small candidate follows a large one. Candidate order,
          // distribution, first-hit stopping and the quota are unchanged.
          if (budget > 1) engine.run(budget - 1);
          if (!engine.get_found()) {
            j.divisorWords.fill(0);
            engine.run(1);
          }
          captureSample(j);
          j.nextSample = performance.now() + j.sampleInterval;
        } else {
          engine.run(budget);
          if (engine.get_found()) captureSample(j);
        }
        const dt = performance.now() - start;
        if (engine.get_found()) { finish(j, 'found'); return; }
        if (count() >= j.cap) { finish(j, 'capped'); return; }
        const rate = budget / Math.max(dt, .05);
        j.throughput = j.throughput === null ? rate : .8 * j.throughput + .2 * rate;
        const target = Math.round(j.throughput * 10);
        j.budget = Math.max(16, Math.min(1048576, Math.max(j.budget >> 1, Math.min(j.budget * 2, target))));
        // 30 Hz actual counter reports. Rendering never extrapolates unseen trials.
        if (performance.now() - j.lastReport >= 30) { report(j, 'running'); j.lastReport = performance.now(); }
        schedule();
      } catch (error) { freeze(j); j.paused = true; j.done = true; postMessage({ type: 'error', id: j.id, trials: String(count()), message: error.message }); }
    }
    onmessage = async ({ data: m }) => {
      try {
        if (m.cmd === 'screen') {
          const token = ++screenToken; await ready;
          const t = performance.now(), n = BOGO.parse(m.n);
          const verdict = await BOGO.primality(n, () => token !== screenToken);
          if (token === screenToken) postMessage({ type: 'screened', id: m.id, verdict, prepMs: performance.now() - t });
          return;
        }
        if (m.cmd === 'cancel-screen') { ++screenToken; return; }
        if (m.cmd === 'setup') {
          await ready;
          const n = BOGO.parse(m.n), cap = BigInt(m.cap);
          if (cap < 1n || cap > (1n << 64n) - 1n) throw Error('Invalid per-worker trial quota.');
          const config = BOGO.config(n); BOGO.setup(engine, config);
          job = { id: m.id, n, cap, paused: true, done: false, started: null, elapsedMs: 0, budget: 256,
            lastReport: 0, throughput: null, sequence: 0, outstanding: null, rates: new RateWindow(), rateAt: 0,
            root: config.root,
            divisorWords: new Uint32Array(engine.memory.buffer, engine.ptr_divisor(), Math.ceil(config.root.toString(2).length / 32)),
            sampleInterval: Math.max(60, Math.min(2000, Number(m.sampleInterval) || 60)),
            nextSample: 0, sampleOffset: Math.max(0, Number(m.sampleOffset) || 0),
            sample: null, samplePending: false, lastSampleTrial: 0n };
          job.rates.reset(0n, 0);
          postMessage({ type: 'prepared', id: m.id, candidateCount: String(config.count), engineKind });
          return;
        }
        const j = job; if (!j || j.id !== m.id) return;
        if (m.cmd === 'ack') { if (m.seq === j.outstanding) j.outstanding = null; }
        else if (m.cmd === 'run' || m.cmd === 'resume') {
          if (j.done || !j.paused) return;
          j.paused = false; j.started = performance.now(); j.rates.reset(count(), elapsed(j)); j.rateAt = elapsed(j);
          j.nextSample = performance.now() + j.sampleOffset;
          j.outstanding = null; j.lastReport = performance.now(); report(j, 'running'); schedule();
        } else if (m.cmd === 'pause') {
          if (!j.done) { freeze(j); j.paused = true; }
          report(j, j.done ? (engine.get_found() ? 'found' : 'capped') : 'paused');
        } else if (m.cmd === 'stop') {
          if (!j.done) finish(j, 'stopped');
          else report(j, engine.get_found() ? 'found' : 'capped');
        }
      } catch (error) { postMessage({ type: 'error', id: m.id, message: error.message || String(error) }); }
    };
    ready.catch(error => postMessage({ type: 'error', message: 'Engine initialization failed: ' + error.message }));
  }
  function createURL() {
    const source = [
      "'use strict';",
      'const BOGO = (' + createBogoMath.toString() + ')();',
      'const RateWindow = ' + RateWindow.toString() + ';',
      '(' + start.toString() + ')(' + JSON.stringify(BogoEngineData) + ');'
    ].join('\n');
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }
  return Object.freeze({ createURL });
})();

'use strict';
/** Presentation of measured per-worker throughput. The track is relative to
 * the fastest current lane; it is not an operating-system CPU-usage meter.
 * Three independent clocks: measurements on receipt, bars on animation frames,
 * and decimal readouts through RollingMetric's deliberately slower cadence.
 */
class WorkerMeters {
  constructor(root) {
    this.root = root;
    this.lanes = [];
    this.enabled = true;
    this.visible = !document.hidden;
    this.inView = true;
    this.raf = 0;
    this.previousTime = 0;
    this.frames = 0;
    this.measurements = 0;
    this.pulseSpeed = 68; // CSS pixels/second; identical across workers, no random phase.
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null;
    this.observer?.observe(root);
    if (typeof IntersectionObserver === 'function') {
      this.intersection = new IntersectionObserver(entries => {
        this.inView = entries[0].isIntersecting;
        if (!this.inView) this.stopFrame();
        else this.schedule();
      });
      this.intersection.observe(root);
    }
    this.tick = now => {
      this.raf = 0;
      if (!this.visible || !this.inView) { this.previousTime = 0; return; }
      const dt = this.previousTime ? Math.min(.064, Math.max(0, (now - this.previousTime) / 1000)) : 1 / 60;
      this.previousTime = now;
      const alpha = -Math.expm1(-dt / .17);
      for (const lane of this.lanes) {
        if (lane.state !== 'paused') {
          lane.length += (lane.target - lane.length) * alpha;
          if (Math.abs(lane.target - lane.length) < .00008) lane.length = lane.target;
        }
        if (this.enabled && lane.state === 'running' && lane.width > 0) {
          this.advancePulse(lane, dt);
        }
        this.paint(lane);
      }
      this.frames++;
      this.schedule();
    };
  }
  stopFrame() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0; this.previousTime = 0;
  }
  schedule() {
    if (this.raf || !this.visible || !this.inView || !this.enabled) return;
    const moving = this.lanes.some(lane => lane.width > 0 && lane.state !== 'paused' &&
      (lane.state === 'running' || Math.abs(lane.target - lane.length) > .00008));
    if (moving) this.raf = requestAnimationFrame(this.tick);
    else this.previousTime = 0;
  }
  measure() {
    for (const lane of this.lanes) {
      lane.width = lane.track.clientWidth;
      this.paint(lane);
      lane.metric.resize();
    }
    this.schedule();
  }
  setMotion(enabled, visible) {
    this.enabled = enabled; this.visible = visible;
    if (!enabled || !visible) this.stopFrame();
    if (!enabled) {
      for (const lane of this.lanes) { lane.length = lane.target; this.paint(lane); }
    }
    if (visible) this.schedule();
  }
  rebuild(count) {
    this.stopFrame();
    for (const lane of this.lanes) lane.metric.dispose();
    this.root.replaceChildren(); this.lanes = [];
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div'); row.className = 'worker-lane';
      const name = document.createElement('span'); name.textContent = String(i + 1).padStart(2, '0');
      const track = document.createElement('i'); track.className = 'lane-track'; track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('b'); fill.className = 'lane-fill';
      const glint = document.createElement('em'); glint.className = 'lane-glint';
      const wrappedGlint = glint.cloneNode();
      const output = document.createElement('output');
      track.append(fill, glint, wrappedGlint); row.append(name, track, output); this.root.append(row);
      // All lights start at the origin. Different measured endpoints alone
      // produce different lap times; rates and lengths are never randomized.
      const lane = { row, track, fill, glint, wrappedGlint, metric: new RollingMetric(output),
        length: 0, target: 0, width: 0, pulseX: 0, firstPulse: true, laps: 0, state: 'idle',
        pulseLeft: 0, pulseWidth: 0, labelAt: -Infinity };
      this.lanes.push(lane);
    }
    this.measure();
  }
  update(snapshot) {
    const data = snapshot.workers || [];
    if (this.lanes.length !== data.length) this.rebuild(data.length);
    let maximum = 1, live = 0;
    for (const worker of data) {
      if (worker.state === 'running') {
        live++;
        if (Number.isFinite(worker.rate) && worker.rate > maximum) maximum = worker.rate;
      }
    }
    const countText = `${live} / ${data.length}`;
    document.getElementById('workers-active').textContent = countText;
    document.getElementById('core-workers').textContent = countText + ' WORKERS';
    const now = performance.now();
    data.forEach((worker, i) => {
      const lane = this.lanes[i], changedState = lane.state !== worker.state;
      lane.state = worker.state;
      if (changedState) lane.row.dataset.state = lane.state;
      const rate = Number.isFinite(worker.rate) ? Math.max(0, worker.rate) : 0;
      if (lane.state === 'running') lane.target = Math.max(0, Math.min(1, rate / maximum));
      else if (lane.state === 'paused') lane.target = lane.length; // Preserve the frozen reading.
      else lane.target = 0;
      if (changedState) this.paint(lane);
      if (!this.enabled) { lane.length = lane.target; this.paint(lane); }
      if (changedState || now - lane.labelAt >= lane.metric.interval || snapshot.status !== 'running') {
        const label = lane.state === 'running' && rate > 0 ? BogoNumbers.rate(rate) :
          lane.state === 'paused' ? 'HOLD' : lane.state === 'found' ? 'HIT' : lane.state === 'running' ? 'RUN' : 'IDLE';
        lane.metric.set(label, snapshot.status !== 'running');
        lane.row.title = `Worker ${i + 1}: ${lane.state}; ${rate.toFixed(2)} trials/s; ${worker.trials || '0'} trials`;
        lane.labelAt = now;
      }
    });
    this.measurements++;
    this.schedule();
  }
  pulseGeometry(lane) {
    const end = Math.max(0, lane.width * lane.length);
    const width = Math.min(end, Math.max(10, Math.min(22, lane.width * .18)));
    return { end, width };
  }
  advancePulse(lane, dt) {
    const { end } = this.pulseGeometry(lane);
    if (end <= 0) { lane.pulseX = 0; return; }
    // Show the origin first, including when measurements become available late.
    if (lane.firstPulse) { lane.firstPulse = false; lane.pulseX = 0; return; }
    // The displayed fill is a loop. Preserve overshoot instead of holding at
    // the endpoint or teleporting the whole highlight back to the origin.
    const next = lane.pulseX + this.pulseSpeed * dt;
    lane.laps += Math.floor(next / end);
    lane.pulseX = next % end;
  }
  paint(lane) {
    const { end, width } = this.pulseGeometry(lane);
    // Keep the loop bounded by the actual fill, including after a resize.
    lane.pulseX = end > 0 ? lane.pulseX % end : 0;
    const left = lane.pulseX;
    const overflow = Math.min(width, Math.max(0, left + width - end));
    const opacity = this.enabled && lane.state === 'running' ? Math.min(1, end / 14).toFixed(3) : '0';
    lane.fill.style.transform = `scaleX(${lane.length.toFixed(6)})`;
    // Both pieces retain the full gradient width. Clip complementary portions
    // so the portion leaving the right edge emerges unchanged at the left.
    lane.glint.style.width = width.toFixed(3) + 'px';
    lane.glint.style.transform = `translateX(${left.toFixed(3)}px)`;
    lane.glint.style.clipPath = `inset(0 ${overflow.toFixed(3)}px 0 0)`;
    lane.glint.style.opacity = opacity;
    lane.wrappedGlint.style.width = width.toFixed(3) + 'px';
    lane.wrappedGlint.style.transform = `translateX(${(left - end).toFixed(3)}px)`;
    lane.wrappedGlint.style.clipPath = `inset(0 0 0 ${(width - overflow).toFixed(3)}px)`;
    lane.wrappedGlint.style.opacity = opacity;
    lane.pulseLeft = left; lane.pulseWidth = width;
  }
  reset() { this.rebuild(0); }
  get diagnostics() {
    return { measurements: this.measurements, frames: this.frames, active: !!this.raf,
      lanes: this.lanes.map(lane => ({ state: lane.state, target: lane.target, length: lane.length,
        width: lane.width, pulseLeft: lane.pulseLeft, pulseWidth: lane.pulseWidth,
        laps: lane.laps, speed: this.pulseSpeed, meter: lane.metric.diagnostics })) };
  }
}

/** An optical instrument backplate, on the reactor's existing clock. Geometry
 * is cached at layout/theme changes; moving arcs stay within its annulus.
 * This is decoration, not a candidate-space map or a progress indicator. */
class CoreBackdrop {
  constructor() {
    this.plate = document.createElement('canvas');
    this.key = '';
    this.frames = 0;
    this.meanMs = 0;
  }
  prepare(width, height, cx, cy, radius, palette, dpr) {
    const key = [width, height, cx, cy, radius, dpr, palette.accent, palette.second, palette.line].join('|');
    if (this.key === key) return;
    this.key = key;
    this.plate.width = Math.ceil(width * dpr);
    this.plate.height = Math.ceil(height * dpr);
    const g = this.plate.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tau = Math.PI * 2;
    // Fine registration dots belong to the whole viewport; no floating routes,
    // pseudo-data labels or large waves reaching across neighbouring panels.
    g.fillStyle = palette.accent;
    for (let y = 16; y < height - 12; y += 20) {
      for (let x = 16; x < width - 12; x += 20) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance < radius * 1.09) continue;
        g.globalAlpha = distance < radius * 1.5 ? .15 : .065;
        g.fillRect(x, y, .8, .8);
      }
    }
    g.translate(cx, cy);
    // One shared centre, with deliberately broken arcs rather than a collection
    // of unrelated ellipses. Everything scales with the existing reactor ring.
    g.strokeStyle = palette.line; g.globalAlpha = .7; g.lineWidth = .7;
    g.beginPath(); g.arc(0, 0, radius * 1.20, 0, tau); g.stroke();
    g.strokeStyle = palette.accent; g.globalAlpha = .20;
    g.beginPath();
    for (let i = 0; i < 120; i++) {
      const a = i * tau / 120;
      const inner = radius * 1.24, outer = inner + (i % 10 === 0 ? 7 : i % 5 === 0 ? 4 : 2);
      g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    }
    g.stroke();
    const sections = [[-.64, -.18, 1.15], [.30, 1.02, 1.15], [1.35, 2.17, 1.13], [2.61, 3.55, 1.15], [4.0, 4.58, 1.13]];
    g.strokeStyle = palette.second; g.globalAlpha = .22; g.lineWidth = 2;
    g.beginPath();
    for (const [a, b, r] of sections) {
      g.moveTo(Math.cos(a) * radius * r, Math.sin(a) * radius * r);
      g.arc(0, 0, radius * r, a, b);
    }
    g.stroke();
    // A pair of angular brackets establishes a frame, not additional gauges.
    g.strokeStyle = palette.accent; g.globalAlpha = .24; g.lineWidth = .8;
    const x = Math.min(cx - 22, radius * 1.45), y = Math.min(cy - 14, radius * .88);
    g.beginPath();
    g.moveTo(-x, -y + 24); g.lineTo(-x, -y + 8); g.lineTo(-x + 8, -y); g.lineTo(-x + 26, -y);
    g.moveTo(x - 26, y); g.lineTo(x - 8, y); g.lineTo(x, y - 8); g.lineTo(x, y - 24);
    g.stroke();
  }
  draw(ctx, width, height, cx, cy, radius, palette, dpr, phase, state, enabled) {
    const started = performance.now();
    this.prepare(width, height, cx, cy, radius, palette, dpr);
    ctx.save(); ctx.globalAlpha = 1;
    ctx.drawImage(this.plate, 0, 0, width, height);
    if (enabled) {
      const active = state === 'running' || state === 'screening';
      const color = state === 'found' ? palette.success : state === 'screening' ? palette.amber : palette.accent;
      ctx.translate(cx, cy);
      // Short, tapered arcs travel on the backplate's tracks. Layered strokes
      // give a soft edge without filters, shadows, masks or pixel operations.
      const angle = phase * .22 - Math.PI / 2;
      for (let layer = 0; layer < 3; layer++) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = (active ? .54 : .16) * [.12, .30, .85][layer];
        ctx.lineWidth = [6, 2.6, 1][layer];
        ctx.beginPath(); ctx.arc(0, 0, radius * 1.20, angle - .35, angle + .06); ctx.stroke();
      }
      ctx.strokeStyle = palette.second; ctx.globalAlpha = active ? .48 : .12;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, radius * 1.13, -angle * .71 + 1.8, -angle * .71 + 2.14); ctx.stroke();
    }
    ctx.restore();
    this.frames++;
    this.meanMs += (performance.now() - started - this.meanMs) * .05;
  }
  get diagnostics() {
    return { frames: this.frames, meanDrawMs: this.meanMs,
      cachedPixels: this.plate.width * this.plate.height, design: 'instrument-aperture' };
  }
}

/** Presentation only. Never reads or changes the engine's PRNG or trial counter. */
const BogoVisual = (() => {
  const $ = id => document.getElementById(id);
  const body = document.body;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const canvas = $('reactor'), ctx = canvas.getContext('2d', { alpha: true });
  const fmt = new Intl.NumberFormat('en-US');
  const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
  let peakDisplay = null;
  let state = 'boot', wanted = true, runningFrame = 0, lastFrame = 0, phase = 0;
  let width = 480, height = 300, dpr = 1, visible = !document.hidden, inView = true;
  let palette = {}, frames = 0, drawMs = 0;
  let toastTimer = 0, hitTimer = 0, startTimer = 0;
  let target = '1000000016000000063', lastInput = null, lastSnapshot = null;
  const samples = new Float64Array(48); let sampleHead = 0, sampleCount = 0;
  const points = new Float64Array(9 * 20 * 3);
  const projected = new Float64Array(9 * 20 * 3);
  const scan = new Float64Array(97 * 3);
  let lastTelemetry = -Infinity;
  const workerMeters = new WorkerMeters($('worker-lanes'));
  const activity = new EventStream($('event-log'));
  const backdrop = new CoreBackdrop();
  // Equal angular rings give a stable wireframe, not fabricated factor candidates.
  for (let lat = 0; lat < 9; lat++) for (let lon = 0; lon < 20; lon++) {
    const a = (lat + 1) * Math.PI / 10, b = lon * Math.PI / 10, i = (lat * 20 + lon) * 3;
    points[i] = Math.sin(a) * Math.cos(b); points[i + 1] = Math.cos(a); points[i + 2] = Math.sin(a) * Math.sin(b);
  }
  function motion() { return wanted && !reduce.matches && visible && inView && state !== 'paused'; }
  function toast(text) {
    clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3300);
  }
  function log(tag, text, level = '') { activity.log(tag, text, level); }
  function colors() {
    const style = getComputedStyle(body), get = k => style.getPropertyValue(k).trim();
    palette = { accent: get('--accent'), muted: get('--muted'), line: get('--line'), fine: get('--fine'), second: get('--secondary'), ink: get('--ink'), success: get('--success'), amber: get('--amber') };
    draw();
  }
  function size() {
    const r = canvas.parentElement.getBoundingClientRect();
    width = Math.max(1, r.width); height = Math.max(1, r.height); dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
    if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(); }
  }
  function line(x1, y1, x2, y2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
  function ring(radius, start, end, stroke, weight = 1, opacity = 1) {
    ctx.globalAlpha = opacity; ctx.strokeStyle = stroke; ctx.lineWidth = weight;
    ctx.beginPath(); ctx.arc(0, 0, radius, start, end); ctx.stroke();
  }
  function draw() {
    if (!ctx || !palette.accent || width < 70 || height < 80) return;
    const t0 = performance.now(), tau = Math.PI * 2;
    ctx.clearRect(0, 0, width, height); ctx.save();
    const cx = width / 2, cy = height * .48, R = Math.min(height * .35, width * .34);
    const active = state === 'running' || state === 'screening';
    const main = state === 'found' ? palette.success : state === 'paused' || state === 'screening' ? palette.amber : palette.accent;
    backdrop.draw(ctx, width, height, cx, cy, R, palette, dpr, phase, state, wanted && !reduce.matches);
    ctx.translate(cx, cy);
    ring(R + 8, 0, tau, palette.line, .8, .8);
    ctx.strokeStyle = main; ctx.lineWidth = .8; ctx.globalAlpha = .5; ctx.beginPath();
    for (let i = 0; i < 90; i++) {
      const a = i * tau / 90, l = i % 5 ? 3 : 8;
      line((R + 7) * Math.cos(a), (R + 7) * Math.sin(a), (R + 7 + l) * Math.cos(a), (R + 7 + l) * Math.sin(a));
    }
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + phase * .2;
      ring(R - 1, a, a + 1.0, main, i % 2 ? 1 : 2.5, i % 2 ? .3 : .85);
      ring(R - 11, -phase * .35 + i * Math.PI / 2, -phase * .35 + i * Math.PI / 2 + .72, palette.second, 1, .65);
    }
    // A segmented, counter-rotating inner reticle.
    ctx.save(); ctx.rotate(-phase * .18); ctx.strokeStyle = main; ctx.lineWidth = .8; ctx.globalAlpha = .32; ctx.beginPath();
    for (let i = 0; i < 20; i++) {
      const a = i * tau / 20; ctx.moveTo((R - 22) * Math.cos(a), (R - 22) * Math.sin(a)); ctx.arc(0, 0, R - 22, a, a + .12);
    }
    ctx.stroke(); ctx.restore();
    const s = Math.sin(phase * .23), c = Math.cos(phase * .23), tilt = .32;
    const size = R * .68;
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i] * c - points[i + 2] * s, z = points[i] * s + points[i + 2] * c;
      const y = points[i + 1] * Math.cos(tilt) - z * Math.sin(tilt), zz = points[i + 1] * Math.sin(tilt) + z * Math.cos(tilt);
      const perspective = 2.8 / (2.8 + zz * .3);
      projected[i] = x * size * perspective; projected[i + 1] = y * size * perspective; projected[i + 2] = zz;
    }
    for (let front = 0; front < 2; front++) {
      ctx.strokeStyle = front ? main : palette.second; ctx.globalAlpha = front ? .40 : .13; ctx.lineWidth = .65; ctx.beginPath();
      for (let lat = 0; lat < 9; lat++) for (let lon = 0; lon < 20; lon++) {
        const i = (lat * 20 + lon) * 3, j = (lat * 20 + (lon + 1) % 20) * 3;
        if ((projected[i + 2] < 0 ? 1 : 0) !== front) continue;
        line(projected[i], projected[i + 1], projected[j], projected[j + 1]);
        if (lat < 8) line(projected[i], projected[i + 1], projected[i + 60], projected[i + 61]);
      }
      ctx.stroke();
    }
    // All scan vertices are on the same unit sphere and undergo the same
    // yaw, tilt and perspective as the wireframe. Back-facing arcs are dimmed.
    if (active) {
      for (let trail = 2; trail >= 0; trail--) {
        const latitude = Math.sin(phase * .55 - trail * .065) * .94;
        const radius = Math.sqrt(1 - latitude * latitude);
        for (let k = 0; k <= 96; k++) {
          const a = k * tau / 96, xx = Math.cos(a) * radius, zz = Math.sin(a) * radius;
          const x = xx * c - zz * s, z = xx * s + zz * c;
          const y = latitude * Math.cos(tilt) - z * Math.sin(tilt);
          const depth = latitude * Math.sin(tilt) + z * Math.cos(tilt);
          const p = 2.8 / (2.8 + depth * .3);
          scan[k * 3] = x * size * p; scan[k * 3 + 1] = y * size * p; scan[k * 3 + 2] = depth;
        }
        for (let front = 0; front < 2; front++) {
          ctx.strokeStyle = main; ctx.lineWidth = trail ? 1 : 1.6;
          ctx.globalAlpha = (front ? .86 : .14) / (trail * 3 + 1); ctx.beginPath();
          for (let k = 0; k < 96; k++) {
            const i = k * 3;
            if ((scan[i + 2] < 0 ? 1 : 0) !== front) continue;
            line(scan[i], scan[i + 1], scan[i + 3], scan[i + 4]);
          }
          ctx.stroke();
        }
      }
    }
    // Projected surface nodes: highlights belong to the globe, not a flat overlay.
    for (let k = 0; k < 9; k++) {
      const i = ((k * 19 + Math.floor(phase * .5)) % 180) * 3;
      if (projected[i + 2] > 0) continue;
      ctx.globalAlpha = active ? .55 : .18; ctx.fillStyle = main;
      ctx.beginPath(); ctx.arc(projected[i], projected[i + 1], k % 3 ? 1.3 : 2, 0, tau); ctx.fill();
    }
    // Measured worker activity maps to discrete perimeter sectors, not CPU load.
    const workers = lastSnapshot?.workers || [];
    if (workers.length > 1) workers.forEach((w, i) => {
      const a = i * tau / workers.length - Math.PI / 2;
      ring(R + 18, a + .025, a + tau / workers.length - .025,
        w.state === 'running' ? main : palette.line, 2, w.state === 'running' ? .65 : .4);
    });
    // Sparse orbiting packets and short contrails; constant work and fixed storage.
    for (let i = 0; i < 18; i++) {
      const a = phase * (i % 2 ? -.26 : .32) + i * 2.39996, r = R * (.66 + .24 * (i % 4) / 3);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx.globalAlpha = active ? .4 + (i % 3) * .2 : .22; ctx.fillStyle = main;
      ctx.fillRect(x - 1, y - 1, i % 3 ? 2 : 3, i % 3 ? 2 : 3);
      if (active && i % 3 === 0) ring(r, a - .12, a, main, 1, .2);
    }
    // Four sighting brackets anchor the rotating geometry without dummy labels.
    ctx.globalAlpha = .72; ctx.strokeStyle = main; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2, x = Math.cos(a) * (R + 22), y = Math.sin(a) * (R + 22);
      line(x - Math.sin(a) * 4, y + Math.cos(a) * 4, x, y);
      line(x, y, x + Math.sin(a) * 4, y - Math.cos(a) * 4);
    }
    ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
    frames++; drawMs = drawMs * .95 + (performance.now() - t0) * .05;
  }
  function frame(now) {
    runningFrame = 0;
    if (!motion()) return;
    const fps = state === 'running' || state === 'screening' ? (drawMs > 6 ? 24 : 40) : 16;
    if (now - lastFrame >= 1000 / fps) {
      const dt = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
      phase += dt * (state === 'running' ? 1.8 : state === 'screening' ? 1.25 : .25);
      draw();
    }
    runningFrame = requestAnimationFrame(frame);
  }
  function syncMotion() {
    if (!wanted || reduce.matches || !visible || state === 'paused') {
      RollingMetric.settleAll();
    }
    body.dataset.fx = wanted && !reduce.matches ? 'full' : 'quiet';
    workerMeters.setMotion(wanted && !reduce.matches, visible);
    body.dataset.suspended = String(!visible || !inView);
    $('fx-label').textContent = reduce.matches ? 'FX / REDUCED' : wanted ? 'FX / FULL' : 'FX / OFF';
    $('fx-toggle').setAttribute('aria-pressed', String(wanted && !reduce.matches));
    $('fx-toggle').title = reduce.matches ? 'Reduced motion follows your system preference' : wanted ? 'Turn decorative motion off' : 'Turn decorative motion on';
    if (runningFrame) cancelAnimationFrame(runningFrame); runningFrame = 0;
    if (motion() && ctx) { lastFrame = performance.now(); runningFrame = requestAnimationFrame(frame); }
    else draw();
  }
  const words = {
    boot: ['STANDBY', 'LOADING ENGINE'], idle: ['ARMED', 'AWAITING COMMAND'],
    screening: ['ANALYZING', 'PRIMALITY SCREEN'], running: ['SAMPLING', 'DRAW / TEST / REPEAT'],
    pausing: ['HOLD', 'PAUSE REQUESTED'], paused: ['SUSPENDED', 'STATE PRESERVED'],
    resuming: ['RESTARTING', 'RESUMING SESSION'], stopping: ['HALTING', 'STOP REQUESTED'],
    stopped: ['STOPPED', 'SESSION CLOSED'], found: ['RESOLVED', 'EXACT PRODUCT VERIFIED'],
    prime: ['PRIME', 'NO NON-TRIVIAL FACTOR'], probable: ['PROBABLE', 'BPSW / NOT A PROOF'],
    capped: ['LIMIT', 'NO FACTOR FOUND'], error: ['FAULT', 'CHECK SYSTEM MESSAGE'],
    interrupted: ['INTERRUPTED', 'SESSION CLOSED'], 'counter-limit': ['LIMIT', 'COUNTER CAPACITY']
  };
  function change(next, previous, snapshot) {
    state = next; body.dataset.state = next;
    const w = words[next] || [next.toUpperCase(), '']; $('core-word').textContent = w[0]; $('core-sub').textContent = w[1];
    $('counter-tag').textContent = next === 'running' ? 'LIVE / EXACT' : 'EXACT COUNT';
    const resultLabels = { found: 'FACTOR\nLOCKED', prime: 'PRIME\nINPUT', probable: 'PROBABLE\nPRIME', capped: 'LIMIT\nREACHED', stopped: 'SESSION\nSTOPPED', error: 'SYSTEM\nFAULT', interrupted: 'SESSION\nCLOSED' };
    $('result-heading').textContent = resultLabels[next] || 'AWAITING\nRESULT';
    $('verification').textContent = next === 'found' ? 'VERIFIED / d × q = N' : 'N = d × q';
    const resultMessages = {
      boot: 'Awaiting a search.', idle: 'Awaiting a search.',
      screening: 'Checking the input.', running: 'Searching for a non-trivial divisor.',
      pausing: 'Pausing the search…', paused: 'Search paused.', resuming: 'Resuming the search…',
      stopping: 'Stopping the search…', stopped: 'Stopped before a divisor was found.',
      prime: 'No non-trivial divisor exists.', probable: 'Primality screen passed.',
      capped: 'No divisor found within the trial limit.', error: 'Search could not complete.',
      interrupted: 'Search interrupted.', 'counter-limit': 'Counter capacity reached without a divisor.'
    };
    $('empty-message').textContent = resultMessages[next] || '';
    const messages = {
      screening: ['CHECK', 'primality screen started'], running: ['RUN', previous === 'resuming' || previous === 'paused' ? 'session resumed' : 'sampling eligible divisors'],
      paused: ['HOLD', 'state preserved'], stopped: ['STOP', 'session closed'], found: ['HIT', 'd × q = N verified'],
      prime: ['CHECK', 'prime input; search skipped'], probable: ['CHECK', 'BPSW passed; not a proof'],
      capped: ['LIMIT', 'trial limit reached'], interrupted: ['STOP', 'page session interrupted'], 'counter-limit': ['LIMIT', '64-bit counter exhausted']
    };
    if (next === 'screening' && lastInput) {
      log('INPUT', lastInput.length + ' digits · ' + BigInt(lastInput).toString(2).length + ' bits');
    }
    if (messages[next]) log(...messages[next], next === 'found' ? 'hit' : ['capped', 'probable', 'paused'].includes(next) ? 'warn' : '');
    clearTimeout(startTimer); body.classList.remove('start-effect');
    if (next === 'running' && previous !== 'running') {
      body.classList.add('start-effect'); startTimer = setTimeout(() => body.classList.remove('start-effect'), 1000);
    } else if (next === 'found') {
      const divisor = snapshot?.factor?.d || '';
      const output = $('locked-divisor');
      // Show only actual result digits, never random stand-ins. Long results
      // remain complete in the result panel and share card below.
      output.textContent = divisor.length > 60 ? divisor.slice(0, 28) + '…' + divisor.slice(-28) : divisor;
      output.classList.toggle('long', divisor.length > 24);
      clearTimeout(hitTimer); body.classList.add('hit-effect'); hitTimer = setTimeout(() => body.classList.remove('hit-effect'), 2700);
    }
    syncMotion();
  }
  function chart(rate) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return;
    samples[sampleHead] = rate; sampleHead = (sampleHead + 1) % samples.length; sampleCount = Math.min(samples.length, sampleCount + 1);
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) peak = Math.max(peak, samples[i]);
    const max = Math.max(1, peak);
    let path = '', first = 0, lastX = 0;
    for (let i = 0; i < sampleCount; i++) {
      const idx = (sampleHead - sampleCount + i + samples.length) % samples.length;
      const x = (samples.length - sampleCount + i) * 260 / (samples.length - 1), y = 70 - samples[idx] / max * 60;
      if (!i) first = x;
      path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); lastX = x;
    }
    $('rate-path').setAttribute('d', path);
    $('rate-area').setAttribute('d', path + 'L' + lastX.toFixed(1) + ' 76L' + first.toFixed(1) + ' 76Z');
    if (!peakDisplay) peakDisplay = new RollingMetric($('chart-peak'));
    peakDisplay.set(BogoNumbers.rate(peak));
    $('rate-chart').setAttribute('aria-label', `Measured throughput, ${sampleCount} recent samples; peak ${fmt.format(Math.round(peak))} trials per second`);
  }
  function update(snapshot) {
    lastSnapshot = snapshot;
    workerMeters.update(snapshot);
    if (snapshot.elapsedMs - lastTelemetry >= 500 || snapshot.status !== 'running') {
      if (snapshot.status === 'running' && state !== 'pausing' && state !== 'stopping') chart(snapshot.rate);
      lastTelemetry = snapshot.elapsedMs;
    }
    if (state === 'running') activity.update(snapshot);
  }
  function input(n) {
    if (n === lastInput) return;
    lastInput = n; target = n;
    let hex = '';
    try { hex = n ? BigInt(n).toString(16).toUpperCase() : ''; } catch (_) {}
    const text = hex ? hex.slice(0, 256).match(/.{1,4}/g).join(' ') : 'AWAITING VALID INTEGER';
    $('target-stream').textContent = Array(5).fill(text).join('  //  ');
  }
  function reset() {
    lastTelemetry = -Infinity; samples.fill(0); sampleHead = 0; sampleCount = 0; activity.reset(); lastSnapshot = null; workerMeters.update({ workers: [] });
    $('rate-path').setAttribute('d', 'M0 70H260'); $('rate-area').setAttribute('d', 'M0 76H260Z'); peakDisplay?.reset();
    $('rate-chart').setAttribute('aria-label', 'Measured throughput history; no data yet');
    clearTimeout(hitTimer); body.classList.remove('hit-effect');
    $('locked-divisor').textContent = '';
  }
  $('fx-toggle').addEventListener('click', () => {
    if (reduce.matches) { toast('Reduced motion is enabled in your system settings.'); return; }
    wanted = !wanted; syncMotion();
  });
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else toast('Fullscreen is not available in this browser.');
    } catch (_) { toast('Fullscreen was not permitted. Use your browser’s fullscreen command.'); }
  }
  $('fullscreen').addEventListener('click', fullscreen);
  document.addEventListener('fullscreenchange', () => { $('fullscreen').title = document.fullscreenElement ? 'Exit fullscreen (F or Esc)' : 'Enter fullscreen (F)'; });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName) || e.target.isContentEditable || $('about-dialog').open || $('share-dialog').open) return;
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); fullscreen(); }
  });
  $('about').addEventListener('click', () => $('about-dialog').showModal());
  $('about-dialog').addEventListener('click', e => { if (e.target === $('about-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (!visible) activity.cancelScroll(); syncMotion(); });
  addEventListener('pagehide', () => { visible = false; activity.cancelScroll(); syncMotion(); });
  addEventListener('pageshow', () => { visible = !document.hidden; if (!visible) activity.cancelScroll(); syncMotion(); });
  reduce.addEventListener('change', syncMotion); dark.addEventListener('change', colors);
  if (window.ResizeObserver) new ResizeObserver(size).observe(canvas.parentElement); else addEventListener('resize', size);
  if (window.IntersectionObserver) new IntersectionObserver(entries => { inView = entries[0].isIntersecting; syncMotion(); }, { rootMargin: '80px' }).observe(canvas.parentElement);
  const dismissIntro = () => { $('boot-intro')?.remove(); };
  setTimeout(dismissIntro, 1500);
  document.addEventListener('pointerdown', dismissIntro, { once: true });
  document.addEventListener('keydown', dismissIntro, { once: true });
  // The diagonal covers each rectangular mask at every angle. Update texture
  // size only when layout changes, not during animation or counter updates.
  const edgePanels = Array.from(document.querySelectorAll('.panel.core, .throughput-panel, .panel.payload, .panel.output'));
  const sizeEdge = panel => {
    const size = Math.ceil(Math.hypot(panel.clientWidth, panel.clientHeight)) + 4;
    panel.lastElementChild.style.setProperty('--rim-size', size + 'px');
  };
  for (const panel of edgePanels) {
    const edge = document.createElement('span'); edge.className = 'edge-light';
    edge.setAttribute('aria-hidden', 'true'); panel.append(edge);
    sizeEdge(panel);
  }
  if (window.ResizeObserver) {
    const edgeObserver = new ResizeObserver(entries => { for (const entry of entries) sizeEdge(entry.target); });
    for (const panel of edgePanels) edgeObserver.observe(panel);
  } else addEventListener('resize', () => edgePanels.forEach(sizeEdge));
  colors(); size(); syncMotion(); log('BOOT', 'local engine initializing');
  return {
    state: change, snapshot: update, input, reset, toast,
    ready(kind) { $('core-engine').textContent = 'WASM / ' + kind.toUpperCase(); $('engine-mode').textContent = 'WASM / ' + kind.toUpperCase(); log('CORE', 'WASM/' + kind.toUpperCase() + ' ready'); log('RNG', 'ChaCha20 · local seed'); },
    error(text) { log('FAULT', text, 'warn'); },
    get diagnostics() { return { state, frames, meanDrawMs: drawMs, active: !!runningFrame, fullMotion: wanted && !reduce.matches, visible, inView, sound: BogoAudio.diagnostics.wanted, sampleCount, logRows: $('event-log').children.length, canvasPixels: canvas.width * canvas.height, music: BogoAudio.diagnostics, scanGeometry: 'projected-spherical-latitude', backdrop: backdrop.diagnostics, workerMeters: workerMeters.diagnostics }; }
  };
})();

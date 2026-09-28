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
    this.selectedCount = 1;
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
    this.side = root.closest('.side-stack');
    this.sideObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layout()) : null;
    if (this.side) this.sideObserver?.observe(this.side);
    this.heightQuery = matchMedia('(max-height:790px)');
    this.heightQuery.addEventListener('change', () => this.layout());
    // Phones show the lanes in TARGET (ui.js moves them), in columns of their own.
    this.phoneQuery = matchMedia('(max-width:760px), (pointer:coarse) and (max-height:590px)');
    this.phoneQuery.addEventListener('change', () => { this.layoutKey = ''; this.layout(); });
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
    this.layout();
    for (const lane of this.lanes) {
      lane.width = lane.track.clientWidth;
      this.paint(lane);
      lane.metric.resize();
    }
    this.schedule();
  }
  layout() {
    if (!this.lanes.length) return;
    const count = this.lanes.length;
    if (this.phoneQuery.matches) {
      // Two columns with readings; beyond eight workers, four columns of bars only.
      const columns = count > 8 ? 4 : 2;
      this.root.dataset.columns = String(columns);
      this.root.style.setProperty('--lane-rows', String(Math.ceil(count / columns)));
      this.layoutKey = '';
      return;
    }
    if (!this.side || !this.side.clientHeight || !this.side.contains(this.root)) return;
    const key = [count, this.side.clientWidth, this.side.clientHeight, innerHeight].join('|');
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.side.dataset.dense = 'false';
    const styles = el => getComputedStyle(el), px = value => parseFloat(value) || 0;
    const outer = el => el.getBoundingClientRect().height + px(styles(el).marginTop) + px(styles(el).marginBottom);
    const body = this.side.querySelector('.telemetry-body'), bs = styles(body);
    const log = this.side.querySelector('.log-panel'), ls = styles(log.querySelector('.event-log'));
    const row = this.heightQuery.matches ? 15 : 18, gap = this.heightQuery.matches ? 1 : 2;
    const chrome = outer(this.side.querySelector('.throughput-panel .panel-heading')) + 2 +
      px(bs.paddingTop) + px(bs.paddingBottom) + 4 * px(bs.rowGap) +
      [...body.children].filter(el => el !== this.root).reduce((n, el) => n + outer(el), 0) +
      px(styles(this.root).marginTop) + px(styles(this.root).marginBottom);
    const minimumLog = outer(log.querySelector('.panel-heading')) + outer(log.querySelector('.terminal-prompt')) +
      px(ls.paddingTop) + px(ls.paddingBottom) + 6 * 18 + 2;
    const panelGap = px(styles(this.side).rowGap);
    const fits = rows => chrome + rows * (row + gap) - gap + panelGap + minimumLog <= this.side.clientHeight;
    const columns = count > 16 || !fits(count) ? 2 : 1;
    const rows = Math.ceil(count / columns);
    // At the densest selections only, surrender decorative prompt/padding,
    // never a worker, its value, the chart, six log lines, or animation frames.
    this.side.dataset.dense = String(!fits(rows));
    this.root.dataset.columns = String(columns);
    this.root.style.setProperty('--lane-rows', String(rows));
  }
  setMotion(enabled, visible) {
    this.enabled = enabled; this.visible = visible;
    if (!enabled || !visible) this.stopFrame();
    if (!enabled) {
      for (const lane of this.lanes) { lane.length = lane.target; this.paint(lane); }
    }
    if (visible) this.schedule();
  }
  select(count) {
    this.selectedCount = Math.max(1, Math.min(32, Math.floor(Number(count) || 1)));
    this.rebuild(this.selectedCount);
    this.update({ status: 'idle', workers: [] });
  }
  rebuild(count) {
    this.stopFrame();
    for (const lane of this.lanes) lane.metric.dispose();
    this.root.replaceChildren(); this.lanes = [];
    this.root.setAttribute('aria-label', count + ' worker slots; current throughput relative to the fastest active worker');
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
    const reported = snapshot.workers || [];
    // Selection owns layout. Screening and small trial quotas must not collapse
    // the reserved slots or move the activity stream when workers start/stop.
    const count = Math.max(this.selectedCount, reported.length);
    if (this.lanes.length !== count) this.rebuild(count);
    const data = Array.from({ length: count }, (_, index) => reported[index] ||
      { index, state: 'idle', rate: 0, trials: '0' });
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
  reset() { this.select(this.selectedCount); }
  get diagnostics() {
    return { selectedCount: this.selectedCount, measurements: this.measurements, frames: this.frames, active: !!this.raf,
      lanes: this.lanes.map(lane => ({ state: lane.state, target: lane.target, length: lane.length,
        width: lane.width, pulseLeft: lane.pulseLeft, pulseWidth: lane.pulseWidth,
        laps: lane.laps, speed: this.pulseSpeed, meter: lane.metric.diagnostics })) };
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
  let toastTimer = 0, hitTimer = 0, startTimer = 0, wordTimer = 0;
  let lastInput = null, lastSnapshot = null;
  // Throughput history (newest at NOW): the pool's readings of the recent rate,
  // one per 0.5 s of search time, recorded as reports arrive, hidden tabs included.
  const history = []; let historyDirty = false, historyTotal = 0;
  const points = new Float64Array(9 * 20 * 3);
  const projected = new Float64Array(9 * 20 * 3);
  const scan = new Float64Array(97 * 3);
  const workerMeters = new WorkerMeters($('worker-lanes'));
  const activity = new EventStream($('event-log'));
  const sampleField = new SampleField(canvas);
  const scale = document.createElement('canvas');
  scale.className = 'reactor-scale'; scale.setAttribute('aria-hidden', 'true');
  canvas.before(scale);
  const scaleContext = scale.getContext('2d');
  let scaleKey = '';
  const corePanel = document.querySelector('.panel.core');
  const rims = new PanelRims(document.querySelector('.workspace'), [corePanel, $('output-panel')]);
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
    palette = { accent: get('--accent'), bright: get('--bright'), muted: get('--muted'), line: get('--line'), fine: get('--fine'), second: get('--secondary'), ink: get('--ink'), success: get('--success'), amber: get('--amber'), star: get('--star'), starCool: get('--star-cool'), starWarm: get('--star-warm') };
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
  function prepareScale(cx, cy, R, main) {
    const key = [width, height, dpr, main, palette.fine, palette.line, palette.accent].join('|');
    if (key === scaleKey || !scaleContext) return;
    scaleKey = key; scale.width = Math.ceil(width * dpr); scale.height = Math.ceil(height * dpr);
    const g = scaleContext, tau = Math.PI * 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Faint scanlines, with the same edge fade as the samples. Static, so they live here.
    g.fillStyle = palette.accent;
    for (let y = 2; y < height; y += 4) { g.globalAlpha = .025 * SampleField.edge(y, height); g.fillRect(0, y, width, .5); }
    g.translate(cx, cy);
    g.strokeStyle = palette.fine; g.lineWidth = .8; g.globalAlpha = .9;
    g.beginPath(); g.moveTo(-cx + 17, 0); g.lineTo(cx - 17, 0); g.stroke();
    const fade = g.createLinearGradient(0, -cy, 0, height - cy);
    const fadeScale = Math.min(1, height / 120);
    fade.addColorStop(0, 'transparent'); fade.addColorStop(40 * fadeScale / height, palette.fine);
    fade.addColorStop(1 - 80 * fadeScale / height, palette.fine); fade.addColorStop(1, 'transparent');
    g.strokeStyle = fade; g.beginPath(); g.moveTo(0, -cy); g.lineTo(0, height - cy); g.stroke();
    g.strokeStyle = palette.fine; g.beginPath();
    for (const x of [-1,1]) for (const y of [-1,1]) {
      const px=x*(R+22), py=y*(R-13);
      g.moveTo(px-4,py); g.lineTo(px+4,py); g.moveTo(px,py-4); g.lineTo(px,py+4);
    }
    g.stroke(); g.strokeStyle=palette.line; g.globalAlpha=.8;
    g.beginPath(); g.arc(0,0,R+8,0,tau); g.stroke();
    g.strokeStyle=main; g.globalAlpha=.5; g.beginPath();
    for (let i=0;i<90;i++) {
      const a=i*tau/90,l=i%5?3:8;
      g.moveTo((R+7)*Math.cos(a),(R+7)*Math.sin(a));
      g.lineTo((R+7+l)*Math.cos(a),(R+7+l)*Math.sin(a));
    }
    g.stroke(); g.globalAlpha=.72; g.lineWidth=1; g.beginPath();
    for(let i=0;i<4;i++) {
      const a=i*Math.PI/2,x=Math.cos(a)*(R+22),y=Math.sin(a)*(R+22);
      g.moveTo(x-Math.sin(a)*4,y+Math.cos(a)*4);g.lineTo(x,y);g.lineTo(x+Math.sin(a)*4,y-Math.cos(a)*4);
    }
    g.stroke();
    if(width>510) {
      g.globalAlpha=.35;g.strokeStyle=palette.line;g.lineWidth=.8;g.beginPath();
      g.moveTo(-R-40,R*.54);g.lineTo(-R-24,R*.54);g.lineTo(-R-16,R*.66);
      g.moveTo(R+20,-R*.57);g.lineTo(R+32,-R*.71);g.lineTo(R+48,-R*.71);g.stroke();
    }
  }
  function draw() {
    if (!ctx || !palette.accent || width < 70 || height < 80) return;
    const t0 = performance.now(), tau = Math.PI * 2;
    // Traces end with decorative motion or a hidden page; out of view, they wait briefly.
    rims.draw(t0, wanted && !reduce.matches && visible, motion());
    ctx.clearRect(0, 0, width, height); ctx.save();
    // One shared geometric centre for the full dot rectangle, globe and banner.
    // Keep the scene centred; compact phones use the approved 18px reserve.
    const cx = width / 2, cy = height / 2;
    const reserve = width <= 400 ? 18 : 44;
    const R = Math.max(22, Math.min(width * .34, width / 2 - reserve, height / 2 - reserve));
    const active = state === 'running' || state === 'screening';
    const main = state === 'found' ? palette.success : state === 'paused' ? palette.amber : palette.accent;
    sampleField.prepare(width, height, cx, cy, R, palette, dpr);
    prepareScale(cx, cy, R, main);
    sampleField.drawHit(ctx, state, palette);
    ctx.translate(cx, cy);
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
    ctx.restore(); ctx.globalAlpha = 1;
    frames++; drawMs = drawMs * .95 + (performance.now() - t0) * .05;
  }
  function frame(now) {
    runningFrame = 0;
    if (!motion()) { syncMotion(); return; }
    const dt = Math.min(.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    phase += dt * (state === 'running' ? 1.8 : state === 'screening' ? 1.25 : .25);
    draw();
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
    if (motion() && ctx) { lastFrame = performance.now(); draw(); runningFrame = requestAnimationFrame(frame); }
    else draw();
  }
  const words = {
    boot: ['STANDBY', 'LOADING ENGINE'], idle: ['ARMED', 'AWAITING COMMAND'],
    screening: ['ANALYZING', 'PRIMALITY SCREEN'], running: ['SAMPLING', 'DRAW / TEST / REPEAT'],
    pausing: ['HOLD', 'PAUSE REQUESTED'], paused: ['SUSPENDED', 'STATE PRESERVED'],
    resuming: ['RESTARTING', 'RESUMING SESSION'], stopping: ['HALTING', 'STOP REQUESTED'],
    stopped: ['STOPPED', 'SESSION CLOSED'], found: ['FACTOR LOCKED', 'EXACT PRODUCT VERIFIED'],
    prime: ['PRIME', 'NO NON-TRIVIAL FACTOR'], probable: ['PROBABLE', 'BPSW / NOT A PROOF'],
    capped: ['LIMIT', 'NO FACTOR FOUND'], error: ['FAULT', 'CHECK SYSTEM MESSAGE'],
    interrupted: ['INTERRUPTED', 'SESSION CLOSED'], 'counter-limit': ['LIMIT', 'COUNTER CAPACITY']
  };
  function change(next, previous, snapshot) {
    if (next === 'screening') { sampleField.begin(); rims.cancel(); }
    if (next === 'found') {
      const divisor = snapshot?.factor?.d || '';
      const output = $('locked-divisor');
      output.textContent = divisor.length > 22 && height < 150 ? divisor.slice(0, 10) + '…' + divisor.slice(-10) :
        divisor.length > 60 ? divisor.slice(0, 28) + '…' + divisor.slice(-28) : divisor;
      output.classList.toggle('long', divisor.length > 24);
      output.style.setProperty('--lock-chars', String(Math.max(1, output.textContent.length)));
    }
    state = next; body.dataset.state = next;
    const show = () => { const w = words[next] || [next.toUpperCase(), '']; $('core-word').textContent = w[0]; $('core-sub').textContent = w[1]; };
    // A primality screen usually ends within a frame or two: keep the previous
    // words rather than flash ANALYZING, and show it only if the screen lasts.
    clearTimeout(wordTimer);
    if (next === 'screening') wordTimer = setTimeout(() => { if (state === 'screening') show(); }, 300);
    else show();
    $('counter-tag').textContent = next === 'running' ? 'LIVE / EXACT' : 'EXACT COUNT';
    const resultLabels = { found: 'FACTOR\nLOCKED', prime: 'PRIME\nINPUT', probable: 'PROBABLE\nPRIME', capped: 'LIMIT\nREACHED', stopped: 'SESSION\nSTOPPED', error: 'SYSTEM\nFAULT', interrupted: 'SESSION\nCLOSED', 'counter-limit': 'COUNTER\nLIMIT' };
    $('result-heading').textContent = resultLabels[next] || 'AWAITING\nRESULT';
    $('verification').textContent = next === 'found' ? 'VERIFIED / d × q = N' : 'N = d × q';
    const resultMessages = {
      boot: 'ONE GUESS. ZERO PATIENCE.', idle: 'ONE GUESS. ZERO PATIENCE.',
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
    // One lap of light marks a new search and a verified divisor; nothing orbits.
    const lap = wanted && !reduce.matches;
    if (next === 'running' && previous === 'screening' && lap) rims.trace(corePanel, palette.accent, palette.star, .9);
    else if (next !== 'running') rims.cancel();
    if (next === 'found' && lap) rims.trace($('output-panel'), palette.success, palette.star, 1.2);
    clearTimeout(startTimer); body.classList.remove('start-effect');
    if (next === 'running' && previous !== 'running') {
      body.classList.add('start-effect'); startTimer = setTimeout(() => body.classList.remove('start-effect'), 1000);
    } else if (next === 'found') {
      clearTimeout(hitTimer); body.classList.add('hit-effect'); hitTimer = setTimeout(() => body.classList.remove('hit-effect'), 2700);
    }
    syncMotion();
  }
  function record(values) {
    if (!values?.length) return;
    for (const value of values) if (Number.isFinite(value) && value >= 0) { history.push(value); historyTotal++; }
    if (history.length > SearchPool.HISTORY) history.splice(0, history.length - SearchPool.HISTORY);
    historyDirty = true;
  }
  function chart() {
    if (!historyDirty) return;
    historyDirty = false;
    const size = SearchPool.HISTORY, count = history.length, max = Math.max(1, ...history);
    let path = '', first = 0, lastX = 0;
    history.forEach((value, i) => {
      // Fixed time axis: the newest reading at NOW, each step 0.5 s of search time.
      const x = (size - count + i) * 260 / (size - 1), y = 70 - value / max * 60;
      if (!i) first = x;
      path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); lastX = x;
    });
    $('rate-path').setAttribute('d', path);
    $('rate-area').setAttribute('d', path + 'L' + lastX.toFixed(1) + ' 76L' + first.toFixed(1) + ' 76Z');
    if (!peakDisplay) peakDisplay = new RollingMetric($('chart-peak'));
    const peak = count ? max : 0;
    peakDisplay.set(BogoNumbers.rate(peak));
    $('rate-chart').setAttribute('aria-label', `Measured throughput every 0.5 s of search time, last ${count} readings; peak ${fmt.format(Math.round(peak))} trials per second`);
  }
  function update(snapshot) {
    lastSnapshot = snapshot;
    sampleField.observe(snapshot);
    workerMeters.update(snapshot);
    chart();
    if (state === 'running') activity.update(snapshot);
  }
  function input(n) {
    if (n === lastInput) return;
    lastInput = n;
  }
  function reset() {
    // Retain the previous search raster while editing; begin() clears it.
    history.length = 0; historyDirty = false; historyTotal = 0; activity.reset(); lastSnapshot = null; workerMeters.reset();
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName) || e.target.isContentEditable || $('about-dialog').open || $('share-dialog').open || $('digits-dialog').open) return;
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
  colors(); size(); syncMotion(); log('BOOT', 'local engine initializing');
  return {
    state: change, snapshot: update, input, reset, toast, workers(count) { workerMeters.select(count); },
    samples(snapshot) { sampleField.ingest(snapshot.workers || []); record(snapshot.history); },
    ready(kind) { $('core-engine').textContent = 'WASM / ' + kind.toUpperCase(); log('CORE', 'WASM/' + kind.toUpperCase() + ' ready'); log('RNG', 'ChaCha20 · local seed'); log('SAMPLER', 'wheel/17'); log('DRAW', 'uniform · with replacement'); log('FIELD', 'brightness = |N mod d| / d near 0'); },
    error(text) { log('FAULT', text, 'warn'); },
    get diagnostics() { return { state, frames, meanDrawMs: drawMs, active: !!runningFrame, fullMotion: wanted && !reduce.matches, visible, inView, sound: BogoAudio.diagnostics.wanted, history: history.slice(), historyTotal, logRows: $('event-log').children.length, canvasPixels: canvas.width * canvas.height, music: BogoAudio.diagnostics, scanGeometry: 'projected-spherical-latitude', sampleField: sampleField.diagnostics, rims: rims.diagnostics, workerMeters: workerMeters.diagnostics }; }
  };
})();

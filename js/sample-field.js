'use strict';
/** A raster history of the completed candidates already reported for the log.
 * One received sample is one point, not one pixel per eligible candidate and
 * not exhaustive search coverage. Nothing is requested from the Workers.
 */
class SampleField {
  constructor(reactor) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sample-field';
    this.canvas.setAttribute('aria-hidden', 'true');
    reactor.before(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    // Bounded coordinate history exists only to repaint after resize/theme change.
    this.points = new Float32Array(8192 * 2);
    this.head = 0; this.size = 0; this.accepted = 0;
    this.recent = []; this.seen = new Map();
    this.root = 0n; this.target = ''; this.geometry = null; this.key = '';
    this.hit = null; this.updates = 0; this.totalMs = 0;
  }
  setTarget(value) {
    if (value === this.target) return;
    this.target = value; this.clear();
    try { this.root = value ? BOGO.sqrt(BigInt(value)) : 0n; }
    catch (_) { this.root = 0n; }
  }
  clear() {
    this.head = 0; this.size = 0; this.accepted = 0;
    this.recent.length = 0; this.seen.clear(); this.hit = null;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  project(divisor) {
    const d = BigInt(divisor);
    if (this.root < 2n || d < 2n || d > this.root) return null;
    const angle = Number(d % 510510n) * (2 * Math.PI / 510510) - Math.PI / 2;
    // Fixed-point division avoids Number(bigint) overflow for 2,000-digit N.
    // Precision is far finer than a screen pixel; no candidate values change.
    const fraction = Number((d << 32n) / this.root) / 4294967296;
    const radius = Math.sqrt(fraction);
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }
  observe(snapshot, phase) {
    if (document.hidden || snapshot.status === 'paused') return;
    const started = performance.now();
    for (const worker of snapshot.workers || []) {
      const sample = worker.sample;
      if (!sample || this.seen.get(worker.index) === sample.trial) continue;
      this.seen.set(worker.index, sample.trial);
      const p = this.project(sample.divisor);
      if (!p) continue;
      this.points[this.head * 2] = p.x; this.points[this.head * 2 + 1] = p.y;
      this.head = (this.head + 1) % (this.points.length / 2);
      this.size = Math.min(this.size + 1, this.points.length / 2);
      this.accepted++;
      this.dot(p.x, p.y);
      this.recent.push({ ...p, phase });
      if (this.recent.length > 12) this.recent.shift();
    }
    if (snapshot.factor && !this.hit) this.hit = this.project(snapshot.factor.d);
    this.updates++; this.totalMs += performance.now() - started;
  }
  dot(x, y) {
    const g = this.geometry, ctx = this.ctx;
    if (!g || !ctx) return;
    const px = g.cx + x * g.radius, py = g.cy + y * g.radius;
    ctx.fillStyle = g.accent;
    ctx.globalAlpha = .10; ctx.fillRect(px - 2, py - 2, 4, 4);
    ctx.globalAlpha = .58; ctx.fillRect(px - .8, py - .8, 1.6, 1.6);
  }
  prepare(width, height, cx, cy, radius, palette, dpr) {
    const disk = Math.max(0, Math.min(radius * 1.15, width / 2 - 6, cy - 6, height - cy - 6));
    const key = [width, height, disk, dpr, palette.accent].join('|');
    if (key === this.key) return;
    this.key = key;
    this.canvas.width = Math.ceil(width * dpr); this.canvas.height = Math.ceil(height * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geometry = { cx, cy, radius: disk, accent: palette.accent };
    // The raster is otherwise updated only when a new sample arrives. There is
    // no copy of the full background on every reactor animation frame.
    for (let i = 0; i < this.size; i++) this.dot(this.points[i * 2], this.points[i * 2 + 1]);
  }
  drawHighlights(ctx, phase, state, palette, enabled) {
    const g = this.geometry; if (!g) return;
    ctx.save();
    if (enabled && state === 'running') {
      ctx.strokeStyle = palette.accent; ctx.lineWidth = .8;
      for (const p of this.recent) {
        const age = Math.max(0, phase - p.phase);
        if (age >= 1.6) continue;
        ctx.globalAlpha = .52 * (1 - age / 1.6) ** 2;
        ctx.beginPath(); ctx.arc(g.cx + p.x * g.radius, g.cy + p.y * g.radius, 2 + age * 4, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (this.hit && state === 'found') {
      const x = g.cx + this.hit.x * g.radius, y = g.cy + this.hit.y * g.radius;
      ctx.strokeStyle = palette.success; ctx.fillStyle = palette.success;
      ctx.lineWidth = 1; ctx.globalAlpha = .55;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(g.cx, g.cy); ctx.stroke();
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  get diagnostics() {
    return { acceptedSamples: this.accepted, retainedCoordinates: this.size,
      rasterPixels: this.canvas.width * this.canvas.height,
      meanUpdateMs: this.updates ? this.totalMs / this.updates : 0,
      mapping: 'theta=2pi*(d mod 510510)/510510; r=sqrt(d/floor(sqrt(N)))',
      hit: this.hit ? { ...this.hit } : null };
  }
}

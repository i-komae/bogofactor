'use strict';
/** Sparse completed trials, projected into the background OUTSIDE the reactor.
 * The fixed-size raster is updated on receipt, not redrawn every animation frame.
 * Coordinate history is bounded; clipped points are never moved onto the panel.
 */
class SampleField {
  constructor(reactor) {
    this.reactor = reactor;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sample-field';
    this.canvas.setAttribute('aria-hidden', 'true');
    reactor.before(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    // Store angle/u, not pixels: resizing preserves the annular mapping.
    this.points = new Float64Array(32768 * 2);
    this.head = 0; this.size = 0; this.accepted = 0; this.visiblePoints = 0;
    this.recent = []; this.seen = new Map();
    this.root = 0n; this.geometry = null; this.key = ''; this.clip = null;
    this.hit = null; this.link = null; this.updates = 0; this.totalMs = 0;
  }
  begin(value) {
    // Only an explicit new search clears history. Editing/aborting does not.
    this.clear();
    try { this.root = value ? BOGO.sqrt(BigInt(value)) : 0n; }
    catch (_) { this.root = 0n; }
  }
  clear() {
    this.head = 0; this.size = 0; this.accepted = 0; this.visiblePoints = 0;
    this.recent.length = 0; this.seen.clear(); this.hit = null; this.link = null;
    this.root = 0n;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  project(divisor) {
    const d = BigInt(divisor);
    if (this.root < 2n || d < 2n || d > this.root) return null;
    const angle = Number(d % 510510n) * (2 * Math.PI / 510510) - Math.PI / 2;
    // Avoid conversion of the full integer to Number, including 2,000-digit N.
    const u = Number((d << 32n) / this.root) / 4294967296;
    return { angle, u };
  }
  pixel(p) {
    const g = this.geometry;
    if (!g || g.outer <= g.inner) return null;
    const r = Math.sqrt(g.inner * g.inner + p.u * (g.outer * g.outer - g.inner * g.inner));
    return { x: g.cx + r * Math.cos(p.angle), y: g.cy + r * Math.sin(p.angle) };
  }
  onPanel(p) {
    const g = this.geometry;
    return p && p.x >= 0 && p.x < g.width && p.y >= 0 && p.y < g.height;
  }
  observe(snapshot, phase) {
    if (document.hidden) return;
    const started = performance.now();
    for (const worker of snapshot.workers || []) {
      const records = Array.isArray(worker.fieldSamples) ? worker.fieldSamples :
        worker.sample ? [worker.sample] : [];
      let seen = this.seen.get(worker.index) || 0n;
      for (const sample of records) {
        const trial = BigInt(sample.trial);
        if (trial <= seen) continue;
        seen = trial;
        const p = this.project(sample.divisor);
        if (!p) continue;
        this.points[this.head * 2] = p.angle; this.points[this.head * 2 + 1] = p.u;
        this.head = (this.head + 1) % (this.points.length / 2);
        this.size = Math.min(this.size + 1, this.points.length / 2);
        this.accepted++;
        if (this.dot(p)) {
          this.visiblePoints++;
          this.recent.push({ ...p, phase });
          if (this.recent.length > 12) this.recent.shift();
        }
      }
      this.seen.set(worker.index, seen);
    }
    if (snapshot.factor && !this.hit) {
      this.hit = this.project(snapshot.factor.d);
      this.link = null;
    }
    this.updates++; this.totalMs += performance.now() - started;
  }
  dot(p) {
    const g = this.geometry, ctx = this.ctx, q = this.pixel(p);
    if (!ctx || !this.onPanel(q)) return false;
    // One CSS pixel, no bloom. The persistent clip also protects the inner edge.
    ctx.fillRect(q.x - .5, q.y - .5, 1, 1);
    return true;
  }
  prepare(width, height, cx, cy, radius, palette, dpr) {
    // Enclose the OUTERMOST ends of both corner-cross arms, and ring/worker ticks.
    const outerMark = Math.max(radius + 20, Math.hypot(radius + 26, radius - 13),
      Math.hypot(radius + 22, radius - 9));
    const inner = outerMark + 24;
    const outer = Math.max(Math.hypot(cx, cy), Math.hypot(width - cx, cy),
      Math.hypot(cx, height - cy), Math.hypot(width - cx, height - cy));
    const key = [width, height, cx, cy, inner, outer, dpr, palette.accent].join('|');
    if (key === this.key) return;
    this.key = key; this.link = null;
    this.canvas.width = Math.ceil(width * dpr); this.canvas.height = Math.ceil(height * dpr);
    this.geometry = { width, height, cx, cy, inner, outer, accent: palette.accent };
    this.clip = new Path2D(); this.clip.rect(0, 0, width, height);
    this.clip.moveTo(cx + inner, cy); this.clip.arc(cx, cy, inner, 0, Math.PI * 2);
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clip(this.clip, 'evenodd');
    ctx.fillStyle = palette.accent; ctx.globalAlpha = .30;
    this.visiblePoints = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.dot({ angle: this.points[i * 2], u: this.points[i * 2 + 1] })) this.visiblePoints++;
    }
  }
  drawHighlights(ctx, phase, state, palette, enabled) {
    const g = this.geometry; if (!g || !this.clip) return;
    ctx.save();
    ctx.clip(this.clip, 'evenodd');
    if (enabled && state === 'running') {
      ctx.strokeStyle = palette.accent; ctx.lineWidth = .7;
      for (const p of this.recent) {
        const age = Math.max(0, phase - p.phase), q = this.pixel(p);
        if (age >= 1.3 || !this.onPanel(q)) continue;
        ctx.globalAlpha = .42 * (1 - age / 1.3) ** 2;
        ctx.beginPath(); ctx.arc(q.x, q.y, 2 + age * 3, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
    if (this.hit && state === 'found') {
      const p = this.pixel(this.hit); if (!p) return;
      // The connector is the only mark allowed through the protected aperture.
      // If the real point is off-panel, only the clipped connector is visible.
      if (!this.link) {
        const banner = document.getElementById('lock-banner').getBoundingClientRect();
        const box = this.reactor.getBoundingClientRect();
        const x = banner.left - box.left + banner.width / 2;
        const y = banner.top - box.top + banner.height / 2;
        const dx = p.x - x, dy = p.y - y;
        const t = Math.min(1, banner.width / 2 / Math.max(Math.abs(dx), .001),
          banner.height / 2 / Math.max(Math.abs(dy), .001));
        this.link = { x: x + dx * t, y: y + dy * t };
      }
      ctx.save(); ctx.strokeStyle = palette.success; ctx.fillStyle = palette.success;
      ctx.lineWidth = 1; ctx.globalAlpha = .55;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(this.link.x, this.link.y); ctx.stroke();
      ctx.clip(this.clip, 'evenodd');
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  get diagnostics() {
    return { acceptedSamples: this.accepted, visiblePoints: this.visiblePoints,
      retainedCoordinates: this.size, recentHighlights: this.recent.length,
      rasterPixels: this.canvas.width * this.canvas.height,
      meanUpdateMs: this.updates ? this.totalMs / this.updates : 0,
      geometry: this.geometry ? { ...this.geometry } : null,
      mapping: 'theta=2pi*(d mod 510510)/510510; r=sqrt(Rin^2+(d/floor(sqrt(N)))*(Rout^2-Rin^2))',
      hit: this.hit ? this.pixel(this.hit) : null };
  }
}

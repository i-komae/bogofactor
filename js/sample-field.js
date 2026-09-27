'use strict';
/** Completed samples mapped without rejection into a rectangle minus a circle.
 * Angular quantiles are weighted by available radial area. The radial quantile
 * runs inward, so a divisor close to sqrt(N) lies just outside the reticle.
 * Only the existing worker reports are read; no new trials or random draws.
 */
class SampleField {
  constructor(reactor) {
    this.reactor = reactor;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sample-field';
    this.canvas.setAttribute('aria-hidden', 'true');
    reactor.before(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.points = new Float64Array(32768 * 2);
    this.head = 0; this.size = 0; this.accepted = 0; this.visiblePoints = 0;
    this.recent = []; this.seen = new Map(); this.sectors = [];
    this.root = 0n; this.geometry = null; this.key = ''; this.clip = null;
    this.hit = null; this.link = null; this.updates = 0; this.totalMs = 0;
  }
  begin(value) {
    this.clear();
    try { this.root = value ? BOGO.sqrt(BigInt(value)) : 0n; }
    catch (_) { this.root = 0n; }
  }
  clear() {
    this.head = 0; this.size = 0; this.accepted = 0; this.visiblePoints = 0;
    this.recent.length = 0; this.seen.clear(); this.hit = null; this.link = null;
    this.root = 0n;
    if (this.ctx) {
      this.ctx.save(); this.ctx.resetTransform();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx.restore();
      this.scanlines();
    }
  }
  project(divisor) {
    const d = BigInt(divisor);
    if (this.root < 2n || d < 2n || d > this.root) return null;
    // Use the rank within the wheel, not gaps caused by excluded multiples.
    const residues = BOGO.getResidues(), rem = Number(d % 510510n);
    let lo = 0, hi = residues.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (residues[m] < rem) lo = m + 1; else hi = m; }
    const v = Math.min(1 - Number.EPSILON, (lo + .5) / residues.length);
    const u = Number((d << 32n) / this.root) / 4294967296;
    return { v, u };
  }
  radialLimit(angle) {
    const g = this.geometry, c = Math.cos(angle), s = Math.sin(angle);
    const x = c >= 0 ? g.right : g.left, y = s >= 0 ? g.bottom : g.top;
    const rx = x / Math.max(Math.abs(c), 1e-15), ry = y / Math.max(Math.abs(s), 1e-15);
    return rx < ry ? { r: rx, b: x, normal: c >= 0 ? 0 : Math.PI } :
      { r: ry, b: y, normal: s >= 0 ? Math.PI / 2 : Math.PI * 1.5 };
  }
  buildSectors() {
    const tau = Math.PI * 2, g = this.geometry, R = g.sampleInner;
    const cuts = [0, tau], wrap = a => (a % tau + tau) % tau;
    for (const x of [-g.left, g.right]) for (const y of [-g.top, g.bottom]) cuts.push(wrap(Math.atan2(y, x)));
    [g.right, g.bottom, g.left, g.top].forEach((b, i) => {
      if (b < R) { const a = Math.acos(b / R); cuts.push(wrap(i * Math.PI / 2 - a), wrap(i * Math.PI / 2 + a)); }
    });
    cuts.sort((a, b) => a - b);
    this.sectors = []; let area = 0;
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], z = cuts[i];
      if (z - a < 1e-12) continue;
      const mid = (a + z) / 2, side = this.radialLimit(mid);
      if (side.r <= R) continue;
      const normal = side.normal + Math.round((mid - side.normal) / tau) * tau;
      const phi = a - normal, endPhi = z - normal;
      const span = .5 * (side.b ** 2 * (Math.tan(endPhi) - Math.tan(phi)) - R ** 2 * (z - a));
      if (span <= 1e-9) continue;
      this.sectors.push({ a, z, normal, b2: side.b ** 2, tan: Math.tan(phi), start: area, end: area + span });
      area += span;
    }
    g.area = area;
  }
  pixel(p) {
    const g = this.geometry;
    if (!g || !g.area || !p) return null;
    const area = Math.min(1 - Number.EPSILON, Math.max(0, p.v)) * g.area;
    let lo = 0, hi = this.sectors.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.sectors[m].end <= area) lo = m + 1; else hi = m; }
    const sector = this.sectors[lo], wanted = area - sector.start, r2 = g.sampleInner ** 2;
    // Invert the exact sector-area primitive; bounded work independent of N.
    let a = sector.a, b = sector.z;
    for (let i = 0; i < 28; i++) {
      const mid = (a + b) / 2;
      const value = .5 * (sector.b2 * (Math.tan(mid - sector.normal) - sector.tan) - r2 * (mid - sector.a));
      if (value < wanted) a = mid; else b = mid;
    }
    const angle = (a + b) / 2, outer = this.radialLimit(angle).r;
    const r = Math.sqrt(r2 + (1 - Math.min(1, Math.max(0, p.u))) * Math.max(0, outer ** 2 - r2));
    return { x: g.cx + r * Math.cos(angle), y: g.cy + r * Math.sin(angle) };
  }
  onPanel(p) {
    const g = this.geometry;
    return !!(g && p && p.x >= .5 && p.x <= g.width - .5 && p.y >= .5 && p.y <= g.height - .5);
  }
  observe(snapshot, phase) {
    if (document.hidden) return;
    const started = performance.now();
    for (const worker of snapshot.workers || []) {
      const records = Array.isArray(worker.fieldSamples) ? worker.fieldSamples : worker.sample ? [worker.sample] : [];
      let seen = this.seen.get(worker.index) || 0n;
      for (const sample of records) {
        const trial = BigInt(sample.trial); if (trial <= seen) continue; seen = trial;
        const p = this.project(sample.divisor); if (!p) continue;
        this.points[this.head * 2] = p.v; this.points[this.head * 2 + 1] = p.u;
        this.head = (this.head + 1) % (this.points.length / 2);
        this.size = Math.min(this.size + 1, this.points.length / 2); this.accepted++;
        const q = this.pixel(p);
        if (this.dot(q)) this.visiblePoints++;
        this.recent.push({ ...p, phase, pixel: q }); if (this.recent.length > 12) this.recent.shift();
      }
      this.seen.set(worker.index, seen);
    }
    if (snapshot.factor && !this.hit) { this.hit = this.project(snapshot.factor.d); this.hitPixel = this.pixel(this.hit); this.link = null; }
    this.updates++; this.totalMs += performance.now() - started;
  }
  dot(p) {
    if (!this.ctx || !this.onPanel(p)) return false;
    this.ctx.globalAlpha = .30 * this.edgeOpacity(p.y);
    this.ctx.fillStyle = this.geometry.accent;
    this.ctx.fillRect(p.x - .5, p.y - .5, 1, 1); return true;
  }
  edgeOpacity(y) {
    // The fade changes opacity only, never the mapping or the count of samples.
    const t = Math.min(1, Math.max(0, Math.min(y / 32, (this.geometry.height - y) / 76)));
    return t * t * (3 - 2 * t);
  }
  scanlines() {
    const g = this.geometry, ctx = this.ctx;
    if (!g || !ctx) return;
    ctx.save(); ctx.fillStyle = g.accent;
    for (let y = 2; y < g.height; y += 4) {
      ctx.globalAlpha = .025 * this.edgeOpacity(y);
      ctx.fillRect(0, y, g.width, .5);
    }
    ctx.restore();
  }
  prepare(width, height, cx, cy, radius, palette, dpr) {
    if (width < 2 || height < 2) return;
    const inner = radius + 26;
    const key = [width, height, cx, cy, inner, dpr, palette.accent].join('|');
    if (key === this.key) return;
    this.key = key; this.link = null;
    this.canvas.width = Math.ceil(width * dpr); this.canvas.height = Math.ceil(height * dpr);
    this.geometry = { width, height, cx, cy, inner, sampleInner: inner + .75,
      left: cx - .75, right: width - cx - .75, top: cy - .75, bottom: height - cy - .75,
      ringOuter: radius + 20, gap: 6, accent: palette.accent };
    this.buildSectors();
    this.clip = new Path2D(); this.clip.rect(0, 0, width, height);
    this.clip.moveTo(cx + inner, cy); this.clip.arc(cx, cy, inner, 0, Math.PI * 2);
    const view = this.reactor.parentElement;
    // Half-diagonal < inner - 12: the banner cannot cover a valid sample.
    const safe = Math.max(1, Math.min(inner - 12, cy - 8, height - cy - 8));
    view.style.setProperty('--lock-width', Math.min(360, safe * 1.6) + 'px');
    view.style.setProperty('--lock-height', Math.min(168, safe * 1.12) + 'px');
    // Size the heading within the padded banner, including mobile narrow cases.
    view.style.setProperty('--lock-font', Math.min(24, (Math.min(360, safe * 1.6) - 30) / 9.5) + 'px');
    const ctx = this.ctx; if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scanlines();
    ctx.fillStyle = palette.accent; ctx.globalAlpha = .30;
    // All point centres already lie in-domain; the raster need not discard any.
    let drawable = 0;
    for (let i = 0; i < this.size; i++) if (this.dot(this.pixel({ v: this.points[i * 2], u: this.points[i * 2 + 1] }))) drawable++;
    if (drawable === this.size) this.visiblePoints = this.accepted;
    for (const p of this.recent) p.pixel = this.pixel(p);
    this.hitPixel = this.hit ? this.pixel(this.hit) : null;
  }
  drawHighlights(ctx, phase, state, palette, enabled) {
    const g = this.geometry; if (!g || !this.clip) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, g.width, g.height); ctx.clip();
    if (enabled && state === 'running') {
      ctx.save(); ctx.clip(this.clip, 'evenodd'); ctx.strokeStyle = palette.accent; ctx.lineWidth = .7;
      for (const p of this.recent) {
        const age = Math.max(0, phase - p.phase); if (age >= 1.3) continue;
        const q = p.pixel; if (!q) continue;
        ctx.globalAlpha = .42 * (1 - age / 1.3) ** 2 * this.edgeOpacity(q.y);
        ctx.beginPath(); ctx.arc(q.x, q.y, 2 + age * 3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    if (this.hit && state === 'found') {
      const p = this.hitPixel;
      if (p) {
        if (!this.link) {
          const banner = document.getElementById('lock-banner').getBoundingClientRect();
          const box = this.reactor.getBoundingClientRect();
          const x = banner.left - box.left + banner.width / 2, y = banner.top - box.top + banner.height / 2;
          const dx = p.x - x, dy = p.y - y;
          const t = Math.min(1, banner.width / 2 / Math.max(Math.abs(dx), .001), banner.height / 2 / Math.max(Math.abs(dy), .001));
          this.link = { x: x + dx * t, y: y + dy * t };
        }
        ctx.strokeStyle = palette.success; ctx.fillStyle = palette.success; ctx.lineWidth = 1; ctx.globalAlpha = .6;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(this.link.x, this.link.y); ctx.stroke();
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }
  get diagnostics() {
    return { acceptedSamples: this.accepted, visiblePoints: this.visiblePoints,
      retainedCoordinates: this.size, recentHighlights: this.recent.length,
      rasterPixels: this.canvas.width * this.canvas.height,
      meanUpdateMs: this.updates ? this.totalMs / this.updates : 0,
      geometry: this.geometry ? { ...this.geometry } : null, fade: { top: 32, bottom: 76 },
      mapping: 'area-weighted angular CDF; r²=Rin²+(1-d/floor(sqrt(N)))*(rayLimit²-Rin²)',
      hit: this.hit ? this.pixel(this.hit) : null, link: this.link ? { ...this.link } : null };
  }
}

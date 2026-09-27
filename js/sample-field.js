'use strict';
/** Completed samples mapped without rejection into a rectangle minus a circle.
 * Angular quantiles are weighted by available radial area. The radial quantile
 * runs inward, so a divisor close to sqrt(N) lies just outside the reticle.
 * Workers send (v, u, q) numbers: v is the wheel rank, u = d / floor(sqrt(N)),
 * |q| = min(N mod d, d - N mod d) / d, negative when N / d lies just below an
 * integer. No big-integer work happens here.
 * Brightness shows |q|: how close N / d came to an integer. The brighter
 * stars take a star-like colour from the same sample: toward blue-white when
 * N / d fell just short of an integer, toward pale orange just past it, and
 * whiter the closer it came. Warm tints need a larger |q|, so white and
 * blue-white dominate, as in a real sky.
 * Only the verified divisor (q = 0) becomes the green mark.
 * Samples are drawn on two canvases in blocks of HALF. The older block fades
 * out as the newer one fills, so at most 2 x HALF points are ever shown and
 * the sky's brightness levels off. Fading follows the sample count, not the
 * clock: a paused search keeps its sky. The latest RETAINED samples stay
 * available for redraws.
 */
class SampleField {
  static CAPACITY = SampleRing.RETAINED;
  static HALF = 10000;
  // Every point, including the found divisor, keeps this distance from the panel edges.
  static INSET = 10;
  static BRIGHT = .0075;   // about 1.5 % of samples
  static MEDIUM = .0625;   // about 11 % more
  static STEPS = 32;       // colour resolution of the brighter tiers
  static tier(q) { q = Math.abs(q); return q < SampleField.BRIGHT ? 0 : q < SampleField.MEDIUM ? 1 : 2; }
  // How far a brighter star leans from white toward its side's colour (0..1).
  static tint(signed) {
    const t = Math.min(1, Math.abs(signed) / SampleField.MEDIUM);
    return signed < 0 ? Math.sqrt(t) : t ** 1.6;
  }
  // The fade changes opacity only, never the mapping or the count of samples.
  static edge(y, height) {
    const t = Math.min(1, Math.max(0, Math.min(y / 32, (height - y) / 76)));
    return t * t * (3 - 2 * t);
  }
  constructor(reactor) {
    this.reactor = reactor;
    this.layers = [0, 1].map(() => {
      const canvas = document.createElement('canvas');
      canvas.className = 'sample-field'; canvas.setAttribute('aria-hidden', 'true');
      reactor.before(canvas);
      return { canvas, ctx: canvas.getContext('2d'), half: -1, drawn: 0, opacity: 1 };
    });
    this.points = new Float64Array(SampleField.CAPACITY * 3);
    this.head = 0; this.size = 0; this.accepted = 0; this.pending = 0;
    this.tiers = [0, 0, 0]; this.sectors = [];
    this.geometry = null; this.key = ''; this.colors = null;
    this.hit = null; this.hitPixel = null; this.link = null;
    this.updates = 0; this.totalMs = 0; this.redraws = 0;
    // Samples recorded while the page was hidden are drawn when it returns.
    document.addEventListener('visibilitychange', () => this.flush());
  }
  begin() { this.clear(); }
  clear() {
    this.head = 0; this.size = 0; this.accepted = 0; this.pending = 0;
    this.tiers = [0, 0, 0]; this.hit = null; this.hitPixel = null; this.link = null;
    for (const layer of this.layers) this.reset(layer, -1);
    this.fade();
  }
  reset(layer, half) {
    layer.half = half; layer.drawn = 0;
    if (!layer.ctx) return;
    layer.ctx.save(); layer.ctx.resetTransform();
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height); layer.ctx.restore();
  }
  /** The newest half at full strength; the previous one fades as the newest fills. */
  fade() {
    const current = this.accepted ? Math.floor((this.accepted - 1) / SampleField.HALF) : 0;
    const filled = this.accepted - current * SampleField.HALF;
    for (const layer of this.layers) {
      const value = layer.half === current || layer.half < 0 ? 1 : layer.half === current - 1 ? 1 - filled / SampleField.HALF : 0;
      const opacity = Math.round(value * 200) / 200;
      if (layer.opacity !== opacity) { layer.opacity = opacity; layer.canvas.style.opacity = String(opacity); }
    }
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
  pixel(v, u) {
    const g = this.geometry;
    if (!g || !g.area || !Number.isFinite(v) || !Number.isFinite(u)) return null;
    const area = Math.min(1 - Number.EPSILON, Math.max(0, v)) * g.area;
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
    const r = Math.sqrt(r2 + (1 - Math.min(1, Math.max(0, u))) * Math.max(0, outer ** 2 - r2));
    return { x: g.cx + r * Math.cos(angle), y: g.cy + r * Math.sin(angle) };
  }
  onPanel(p) {
    const g = this.geometry;
    return !!(g && p && p.x >= .5 && p.x <= g.width - .5 && p.y >= .5 && p.y <= g.height - .5);
  }
  /** Records every received sample, visible or not. Called on receipt, not per frame. */
  ingest(workers) {
    const started = performance.now();
    for (const worker of workers) {
      const f = worker.fieldSamples;
      if (!f || !f.length) continue;
      for (let i = 0; i + 2 < f.length; i += 3) this.add(f[i], f[i + 1], f[i + 2]);
    }
    this.fade();
    this.updates++; this.totalMs += performance.now() - started;
  }
  add(v, u, q) {
    const at = this.head * 3;
    this.points[at] = v; this.points[at + 1] = u; this.points[at + 2] = q;
    this.head = (this.head + 1) % SampleField.CAPACITY;
    this.size = Math.min(this.size + 1, SampleField.CAPACITY);
    const seq = this.accepted++; this.tiers[SampleField.tier(q)]++;
    if (document.hidden || !this.geometry) { this.pending++; return; }
    this.plot(seq, v, u, q);
  }
  plot(seq, v, u, q) {
    const half = Math.floor(seq / SampleField.HALF), layer = this.layers[half % 2];
    if (layer.half !== half) this.reset(layer, half);
    if (this.dot(layer.ctx, this.pixel(v, u), q)) layer.drawn++;
  }
  /** Draws what arrived while hidden: point by point, or one full redraw for many. */
  flush() {
    if (!this.pending || document.hidden || !this.geometry) return;
    const count = Math.min(this.pending, this.size); this.pending = 0;
    if (count > 2000) { this.redraw(); return; }
    for (let k = count; k >= 1; k--) {
      const at = ((this.head - k + SampleField.CAPACITY) % SampleField.CAPACITY) * 3;
      this.plot(this.accepted - k, this.points[at], this.points[at + 1], this.points[at + 2]);
    }
    this.fade();
  }
  observe(snapshot) {
    // Record the verified divisor even while the page is hidden.
    const f = snapshot.factor;
    if (f && !this.hit && Number.isFinite(f.v) && Number.isFinite(f.u)) {
      this.hit = { v: f.v, u: f.u }; this.hitPixel = this.pixel(f.v, f.u); this.link = null;
    }
  }
  dot(ctx, p, signed) {
    if (!ctx || !this.onPanel(p)) return false;
    const g = this.geometry, e = SampleField.edge(p.y, g.height), q = Math.abs(signed);
    if (q < SampleField.MEDIUM) {
      const side = signed < 0 ? this.colors.cool : this.colors.warm;
      const step = Math.round(SampleField.tint(signed) * SampleField.STEPS);
      if (q < SampleField.BRIGHT) {
        const glow = side.glows[step];
        if (glow) { ctx.globalAlpha = .18 * e; ctx.drawImage(glow, p.x - 6, p.y - 6, 12, 12); }
        ctx.globalAlpha = .9 * e; ctx.fillStyle = side.fills[step]; ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      } else {
        ctx.globalAlpha = (.75 - .2 * (q - SampleField.BRIGHT) / (SampleField.MEDIUM - SampleField.BRIGHT)) * e;
        ctx.fillStyle = side.fills[step]; ctx.fillRect(p.x - .75, p.y - .75, 1.5, 1.5);
      }
    } else {
      ctx.globalAlpha = (.22 + .28 * (1 - Math.min(.5, q) / .5)) * e;
      ctx.fillStyle = g.accent; ctx.fillRect(p.x - .5, p.y - .5, 1, 1);
    }
    return true;
  }
  /** Colour tables for the two sides, from white (closest) toward blue or orange. */
  palette(palette, dpr) {
    const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = color => {
      probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
      return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const base = rgb(palette.star || palette.ink);
    const side = color => {
      const end = rgb(color), fills = [], glows = [];
      for (let i = 0; i <= SampleField.STEPS; i++) {
        const t = i / SampleField.STEPS, c = base.map((x, k) => Math.round(x + (end[k] - x) * t));
        fills.push(`rgb(${c.join(',')})`);
        glows.push(t <= .5 ? this.makeGlow(fills[i], dpr) : null);   // only the brightest tier glows
      }
      return { fills, glows };
    };
    this.colors = { cool: side(palette.starCool || palette.accent), warm: side(palette.starWarm || palette.accent) };
  }
  prepare(width, height, cx, cy, radius, palette, dpr) {
    if (width < 2 || height < 2) return;
    const inner = radius + 26, inset = SampleField.INSET;
    const key = [width, height, cx, cy, inner, dpr, palette.accent, palette.star, palette.starCool, palette.starWarm].join('|');
    if (key === this.key) return;
    this.key = key; this.link = null;
    for (const layer of this.layers) {
      layer.canvas.width = Math.ceil(width * dpr); layer.canvas.height = Math.ceil(height * dpr);
      layer.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.geometry = { width, height, cx, cy, inner, sampleInner: inner + .75, inset,
      left: cx - inset, right: width - cx - inset, top: cy - inset, bottom: height - cy - inset,
      ringOuter: radius + 20, gap: 6, accent: palette.accent };
    this.buildSectors();
    this.palette(palette, dpr);
    const view = this.reactor.parentElement;
    // Half-diagonal < inner - 12: the banner cannot cover a valid sample.
    const safe = Math.max(1, Math.min(inner - 12, cy - 8, height - cy - 8));
    view.style.setProperty('--lock-width', Math.min(360, safe * 1.6) + 'px');
    view.style.setProperty('--lock-height', Math.min(168, safe * 1.12) + 'px');
    // Size the heading within the padded banner, including mobile narrow cases.
    view.style.setProperty('--lock-font', Math.min(24, (Math.min(360, safe * 1.6) - 30) / 9.5) + 'px');
    this.redraw();
  }
  /** Repaints the two displayed halves: faint tiers first, so bright stars stay on top. */
  redraw() {
    if (!this.geometry) return;
    const current = this.accepted ? Math.floor((this.accepted - 1) / SampleField.HALF) : 0;
    for (const layer of this.layers) this.reset(layer, -1);
    const oldest = Math.max(this.accepted - this.size, (current - 1) * SampleField.HALF);
    for (let tier = 2; tier >= 0; tier--) {
      for (let seq = oldest; seq < this.accepted; seq++) {
        const at = ((this.head - (this.accepted - seq) + SampleField.CAPACITY) % SampleField.CAPACITY) * 3, q = this.points[at + 2];
        if (SampleField.tier(q) === tier) this.plot(seq, this.points[at], this.points[at + 1], q);
      }
    }
    this.fade();
    this.pending = 0; this.redraws++;
    this.hitPixel = this.hit ? this.pixel(this.hit.v, this.hit.u) : null;
  }
  makeGlow(color, dpr) {
    const size = Math.ceil(12 * Math.max(1, dpr)), c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d'); if (!g) return null;
    const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, color); gradient.addColorStop(.4, color); gradient.addColorStop(1, 'transparent');
    g.fillStyle = gradient; g.fillRect(0, 0, size, size);
    return c;
  }
  /** The verified divisor: a green mark joined to the banner. */
  drawHit(ctx, state, palette) {
    const g = this.geometry; if (!g) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, g.width, g.height); ctx.clip();
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
    const retained = [0, 0, 0], sides = [0, 0];
    const first = (this.head - this.size + SampleField.CAPACITY) % SampleField.CAPACITY;
    for (let k = 0; k < this.size; k++) {
      const q = this.points[((first + k) % SampleField.CAPACITY) * 3 + 2];
      retained[SampleField.tier(q)]++; if (Math.abs(q) < SampleField.MEDIUM) sides[q < 0 ? 0 : 1]++;
    }
    return { acceptedSamples: this.accepted, visiblePoints: this.layers.reduce((n, l) => n + (l.opacity > 0 ? l.drawn : 0), 0),
      retainedCoordinates: this.size, pendingPoints: this.pending, redraws: this.redraws,
      tiers: this.tiers.slice(), retainedTiers: retained, brightSides: { below: sides[0], above: sides[1] },
      thresholds: [SampleField.BRIGHT, SampleField.MEDIUM],
      layers: this.layers.map(l => ({ half: l.half, drawn: l.drawn, opacity: l.opacity })),
      rasterPixels: this.layers.reduce((n, l) => n + l.canvas.width * l.canvas.height, 0),
      meanUpdateMs: this.updates ? this.totalMs / this.updates : 0,
      geometry: this.geometry ? { ...this.geometry } : null, fade: { top: 32, bottom: 76 },
      mapping: 'area-weighted angular CDF; r²=Rin²+(1-d/floor(sqrt(N)))*(rayLimit²-Rin²); inset 10px',
      brightness: '|q| = min(N mod d, d - N mod d) / d; colour: sign of q (below/above an integer)',
      hit: this.hit ? this.pixel(this.hit.v, this.hit.u) : null, link: this.link ? { ...this.link } : null };
  }
}

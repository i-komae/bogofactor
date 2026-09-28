'use strict';
/** One-shot border traces. A 1px spark runs exactly once along a panel's own
 * border, clockwise from the top-left corner, and lays down the border colour
 * of the new state behind it: the core when a search starts, the result in
 * green when a divisor is verified. Nothing orbits continuously. Four narrow
 * canvases per traced panel lie on the border line (outside the panel's
 * overflow clip) and are hidden while idle; until the lap completes the panel
 * keeps its previous border (.is-tracing). The caller supplies its animation clock.
 * A lap starts when its panel is first drawn in view (on a phone the LIVE view is still
 * sliding in when a search starts); a panel that stays out of view gives the lap up.
 */
class PanelRims {
  constructor(host, panels) {
    this.host = host; this.items = [];
    for (const panel of panels) {
      const strips = ['top', 'right', 'bottom', 'left'].map(side => {
        const canvas = document.createElement('canvas');
        canvas.className = 'rim-strip rim-' + side; canvas.hidden = true; canvas.setAttribute('aria-hidden', 'true');
        host.append(canvas); return canvas;
      });
      this.items.push({ panel, strips, box: null, run: null, laps: 0 });
    }
    this.textures = new Map(); this.frames = 0; this.stripPaints = 0; this.traces = 0; this.completed = 0;
    const invalidate = () => { for (const item of this.items) item.box = null; };
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(invalidate);
      this.observer.observe(host); for (const item of this.items) this.observer.observe(item.panel);
    } else addEventListener('resize', invalidate);
  }
  trace(panel, color, head, seconds) {
    const item = this.items.find(i => i.panel === panel);
    if (!item) return;
    item.run = { color, head, seconds, start: null, queued: performance.now() }; this.traces++;
    panel.classList.add('is-tracing');
  }
  cancel() { for (const item of this.items) this.end(item); }
  end(item) {
    if (!item.run) return;
    item.run = null; item.panel.classList.remove('is-tracing');
    for (const strip of item.strips) strip.hidden = true;
  }
  measure(item) {
    const p = item.panel.getBoundingClientRect(), h = this.host.getBoundingClientRect();
    if (!p.width || !p.height) return false;
    const dpr = Math.min(devicePixelRatio || 1, 2), snap = v => Math.round(v * dpr) / dpr;
    // Border box in the host's scrolling coordinates, snapped like the border itself.
    const left = snap(p.left - h.left - this.host.clientLeft + this.host.scrollLeft);
    const top = snap(p.top - h.top - this.host.clientTop + this.host.scrollTop);
    const right = left + snap(p.width), bottom = top + snap(p.height);
    const w = right - left, ht = bottom - top;
    // Each strip is rotated about its own origin; its thickness falls inside the border box.
    const placements = [[left, top, 0, w], [right, top, 90, ht], [right, bottom, 180, w], [left, bottom, 270, ht]];
    item.strips.forEach((canvas, i) => {
      const [x, y, angle, length] = placements[i];
      canvas.width = Math.max(1, Math.ceil(length * dpr)); canvas.height = Math.max(1, Math.round(dpr));
      canvas.style.width = length + 'px';
      canvas.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
    });
    item.box = { lengths: [w, ht, w, ht], perimeter: 2 * (w + ht), dpr };
    return true;
  }
  texture(color, head) {
    const key = color + '|' + head;
    let texture = this.textures.get(key);
    if (texture) return texture;
    texture = document.createElement('canvas'); texture.width = 256; texture.height = 1;
    const ctx = texture.getContext('2d'), g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, color); g.addColorStop(1, head);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 1);
    this.textures.set(key, texture); return texture;
  }
  draw(now, enabled, inView = enabled) {
    for (const item of this.items) {
      const run = item.run;
      if (!run) continue;
      if (!enabled) { this.end(item); continue; }
      if (run.start === null) {
        if (!inView) { if (now - run.queued > 1200) this.end(item); continue; }
        run.start = now;
      }
      const t = (now - run.start) / 1000 / run.seconds;
      if (t >= 1) { this.end(item); this.completed++; item.laps++; continue; }
      if (!item.box && !this.measure(item)) continue;
      const { lengths, perimeter: per, dpr } = item.box;
      const spark = Math.min(per * .08, 140);
      // Ease in and out; the spark reaches the starting corner at t = 1.
      const eased = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const headAt = eased * per, from = headAt - spark;
      const texture = this.texture(run.color, run.head);
      let edgeStart = 0;
      item.strips.forEach((canvas, edge) => {
        const length = lengths[edge], end = edgeStart + length;
        if (headAt <= edgeStart) { edgeStart = end; return; }
        const ctx = canvas.getContext('2d');
        ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.scale(dpr, canvas.height);
        // The laid border, then the spark: a gradient ending at the head.
        const solid = Math.min(end, from) - edgeStart;
        if (solid > 0) { ctx.fillStyle = run.color; ctx.fillRect(0, 0, solid, 1); }
        const a = Math.max(edgeStart, from), b = Math.min(end, headAt);
        if (b > a) ctx.drawImage(texture, (a - from) / spark * 256, 0, (b - a) / spark * 256, 1, a - edgeStart, 0, b - a, 1);
        canvas.hidden = false; this.stripPaints++;
        edgeStart = end;
      });
    }
    this.frames++;
  }
  get active() { return this.items.filter(item => item.run).length; }
  get diagnostics() {
    return { frames: this.frames, stripPaints: this.stripPaints, traces: this.traces, completed: this.completed,
      active: this.active, visibleStrips: this.items.reduce((n, item) => n + item.strips.filter(s => !s.hidden).length, 0),
      panels: this.items.map(item => item.panel.id || item.panel.className), laps: this.items.map(item => item.laps), clock: 'requestAnimationFrame',
      tracing: this.items.filter(item => item.panel.classList.contains('is-tracing')).length,
      mode: 'one-shot 1px trace that lays the state border; hidden while idle' };
  }
}

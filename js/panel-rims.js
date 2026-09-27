'use strict';
/** Two opposite perimeter reflections on four 2px canvases per panel.
 * No full-panel rotating layer, mask, filter or independent animation loop.
 * The caller supplies its existing animation clock. Work scales with perimeter.
 */
class PanelRims {
  constructor(panels) {
    this.panels = panels.map((panel, index) => {
      const strips = ['top', 'right', 'bottom', 'left'].map(side => {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 2;
        canvas.className = 'rim-strip rim-' + side; canvas.setAttribute('aria-hidden', 'true');
        panel.append(canvas); return canvas;
      });
      return { panel, strips, width: 0, height: 0, dpr: 1, time: index * .63, active: false, dirty: true, painted: [false, false, false, false],
        period: panel.classList.contains('throughput-panel') ? 5.4 : panel.classList.contains('payload') ? 4.8 : 4.2 };
    });
    this.last = 0; this.texture = document.createElement('canvas'); this.colorKey = '';
    this.frames = 0; this.stripPaints = 0;
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      for (const item of this.panels) this.observer.observe(item.panel);
    } else addEventListener('resize', () => this.resize());
    this.resize();
  }
  resize() {
    for (const item of this.panels) {
      const w = item.panel.clientWidth, h = item.panel.clientHeight, dpr = Math.min(devicePixelRatio || 1, 1.5);
      if (w === item.width && h === item.height && dpr === item.dpr) continue;
      item.width = w; item.height = h; item.dpr = dpr; item.dirty = true;
      item.strips.forEach((c, i) => {
        c.width = Math.max(1, Math.ceil((i % 2 ? h : w) * dpr)); c.height = Math.ceil(2 * dpr);
        c.style.width = (i % 2 ? h : w) + 'px';
      });
    }
  }
  palette(colors) {
    const key = colors.accent + colors.bright;
    if (key === this.colorKey) return;
    for (const item of this.panels) item.dirty = true;
    this.colorKey = key; this.texture.width = 256; this.texture.height = 2;
    const ctx = this.texture.getContext('2d'), g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'transparent'); g.addColorStop(.45, colors.accent);
    g.addColorStop(.8, colors.bright); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 2);
  }
  stop() { this.last = 0; }
  draw(now, state, enabled, colors) {
    this.palette(colors);
    const dt = this.last ? Math.min(.1, Math.max(0, (now - this.last) / 1000)) : 0;
    this.last = enabled ? now : 0;
    for (const item of this.panels) {
      const on = enabled && (item.panel.classList.contains('core') ? ['running', 'screening'].includes(state) :
        item.panel.classList.contains('throughput-panel') ? state === 'running' :
        item.panel.classList.contains('output') ? state === 'found' : item.panel.contains(document.activeElement));
      if (!on && !item.active && !item.dirty) continue;
      item.active = on; if (on) item.time += dt;
      const lengths = [item.width, item.height, item.width, item.height], per = 2 * (item.width + item.height);
      if (!per) { item.dirty = false; continue; }
      const tail = Math.min(180, per * .12), head = item.time / item.period % 1 * per;
      let edgeStart = 0;
      item.strips.forEach((canvas, edge) => {
        const length = lengths[edge], portions = [];
        if (on && length > 0) {
          for (const centre of [head, (head + per / 2) % per]) for (const shift of [-per, 0, per]) {
            const start = centre - tail + shift, end = centre + shift;
            const a = Math.max(edgeStart, start), b = Math.min(edgeStart + length, end);
            if (b > a) portions.push({ a, b, start });
          }
        }
        // Untouched edges need no clear or draw. Clear an edge once when the
        // reflection leaves it, including a transition to OFF/paused.
        if (item.dirty || item.painted[edge] || portions.length) {
          const ctx = canvas.getContext('2d');
          ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.scale(item.dpr, item.dpr);
          for (const { a, b, start } of portions) {
            ctx.drawImage(this.texture, (a - start) / tail * 256, 0, (b - a) / tail * 256, 2,
              a - edgeStart, 0, b - a, 2);
          }
          item.painted[edge] = portions.length > 0;
          this.stripPaints++;
        }
        edgeStart += length;
      });
      item.dirty = false;
    }
    this.frames++;
  }
  get diagnostics() {
    return { frames: this.frames, stripPaints: this.stripPaints, clock: 'requestAnimationFrame', pixels: this.panels.reduce((sum, p) => sum + p.strips.reduce((s, c) => s + c.width * c.height, 0), 0),
      mode: 'four narrow unmasked rasters per panel' };
  }
}

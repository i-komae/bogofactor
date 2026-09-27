'use strict';
/** Exact binary view of N. Every cell is one bit (MSB first), not filler.
 * Rows differ by at most one bit and each fills the available width. Painting
 * happens only on input/theme/size changes; no animation or search work.
 */
class TargetBits {
  constructor(canvas, hex) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hex = hex;
    this.viewport = canvas.parentElement;
    this.button = document.getElementById('target-representation-toggle');
    this.label = document.getElementById('target-representation-label');
    this.bits = ''; this.key = ''; this.rows = 0; this.paints = 0;
    this.hexMode = false;
    this.button.addEventListener('click', () => {
      this.hexMode = !this.hexMode;
      this.button.textContent = this.hexMode ? 'BITS' : 'HEX';
      this.button.setAttribute('aria-pressed', String(this.hexMode));
      this.label.textContent = this.hexMode ? 'TARGET / HEX' : 'TARGET / BITS';
      this.hex.hidden = !this.hexMode; this.canvas.hidden = this.hexMode;
      this.paint();
    });
    this.theme = matchMedia('(prefers-color-scheme: dark)');
    this.theme.addEventListener('change', () => this.paint());
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.paint());
      this.observer.observe(this.viewport);
    } else addEventListener('resize', () => this.paint());
  }
  set(value) {
    let n;
    try { n = value ? BigInt(value) : null; } catch (_) { n = null; }
    this.bits = n === null ? '' : n.toString(2);
    const hex = n === null ? '' : n.toString(16).toUpperCase();
    this.hex.textContent = hex ? hex.match(/.{1,4}/g).join(' ') : '—';
    this.canvas.setAttribute('aria-label', this.bits.length ?
      this.bits.length + ' binary digits of N; most significant bit first, left to right, top to bottom. Bright is 1; dim is 0.' : 'No valid integer');
    this.paint();
  }
  paint() {
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    if (!w || !h || !this.ctx) return;
    // Text fallback uses whole 20px lines without changing the reserved slot.
    this.viewport.style.setProperty('--hex-height', Math.max(20, Math.floor(h / 20) * 20) + 'px');
    const styles = getComputedStyle(document.body);
    const one = styles.getPropertyValue('--accent').trim();
    const zero = styles.getPropertyValue('--line').trim();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const key = [w, h, dpr, one, zero, this.bits].join('|');
    if (key === this.key) return;
    this.key = key;
    this.canvas.width = Math.ceil(w * dpr); this.canvas.height = Math.ceil(h * dpr);
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = this.bits.length;
    if (!n) { this.rows = 0; return; }
    this.rows = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * h / w))));
    const columns = Math.floor(n / this.rows), extra = n % this.rows;
    let index = 0;
    for (let row = 0; row < this.rows; row++) {
      const count = columns + (row < extra ? 1 : 0);
      const cw = w / count, ch = h / this.rows;
      const gap = Math.min(2, cw * .20, ch * .20);
      for (let col = 0; col < count; col++, index++) {
        const bit = this.bits[index] === '1';
        ctx.fillStyle = bit ? one : zero; ctx.globalAlpha = bit ? .74 : .58;
        ctx.fillRect(col * cw + gap / 2, row * ch + gap / 2, cw - gap, ch - gap);
      }
    }
    ctx.globalAlpha = 1; this.paints++;
  }
  get diagnostics() {
    return { bits: this.bits.length, ones: this.bits.replaceAll('0', '').length,
      rows: this.rows, paints: this.paints, hexMode: this.hexMode,
      width: this.viewport.clientWidth, height: this.viewport.clientHeight };
  }
}

'use strict';
/** Expected occupancy under independent sampling with replacement.
 * This is not measured coverage. The exact expectation is 1-(1-1/C)^t;
 * the displayed curve uses the requested large-C approximation 1-exp(-t/C).
 * UI snapshots supply completed trials directly: no polling or new clock.
 */
class CoveragePlot {
  constructor(canvas, output) {
    this.canvas = canvas; this.output = output; this.ctx = canvas.getContext('2d');
    this.plate = document.createElement('canvas');
    this.count = 0n; this.logCount = 0; this.trials = 0n; this.x = 0;
    this.status = 'idle'; this.width = 0; this.height = 0; this.dpr = 1;
    this.drawKey = ''; this.draws = 0; this.updates = 0;
    this.curve = null; this.area = null;
    this.theme = matchMedia('(prefers-color-scheme: dark)');
    this.theme.addEventListener('change', () => this.prepare(true));
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.prepare());
      this.observer.observe(canvas.parentElement);
    } else addEventListener('resize', () => this.prepare());
    this.prepare(true);
  }
  static log10(value) {
    const text = value.toString(), digits = Math.min(16, text.length);
    return text.length - digits + Math.log10(Number(text.slice(0, digits)));
  }
  static scientific(logValue) {
    let exponent = Math.floor(logValue), mantissa = Number((10 ** (logValue - exponent)).toFixed(1));
    if (mantissa >= 10) { mantissa = 1; exponent++; }
    const superscript = String(exponent).replace('-', '⁻').replace(/\d/g, digit => '⁰¹²³⁴⁵⁶⁷⁸⁹'[digit]);
    return mantissa.toFixed(1) + '×10' + superscript + ' %';
  }
  setCandidates(count) {
    const next = BigInt(count);
    if (next < 0n) throw RangeError('Candidate count must be non-negative.');
    if (this.count === next) return;
    this.count = next; this.logCount = next > 0n ? CoveragePlot.log10(next) : 0;
    this.reset();
  }
  reset() {
    this.trials = -1n; this.update(0n, 'idle');
  }
  update(trials, status) {
    const total = BigInt(trials);
    if (total < 0n) throw RangeError('Trial count must be non-negative.');
    if (total === this.trials && status === this.status) return;
    this.trials = total; this.status = status; this.updates++;
    let label = '0 %'; this.x = 0;
    if (this.count > 0n && total > 0n) {
      const logRatio = CoveragePlot.log10(total) - this.logCount;
      // Underflow to zero is harmless for a subpixel dot. The label is derived
      // from the logarithm, so even exponents below -999 remain representable.
      this.x = 10 ** logRatio;
      if (logRatio < -4) label = CoveragePlot.scientific(logRatio + 2);
      else {
        const percent = -Math.expm1(-this.x) * 100;
        label = percent.toFixed(percent < 10 ? 3 : 1) + ' %';
      }
    }
    if (this.output.textContent !== label) this.output.textContent = label;
    this.output.title = 'Expected share, not a distinct-candidate count. C = ' + this.count + '; t = ' + total + '.';
    this.canvas.setAttribute('aria-label', 'Expected coverage ' + label + '; trials ' + total + '. Fixed horizontal range: 0 to 3 times the candidate count.');
    this.draw();
  }
  prepare(force = false) {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const width = box.width, height = box.height, dpr = Math.min(devicePixelRatio || 1, 2);
    if (width < 1 || height < 1) return;
    if (!force && width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width; this.height = height; this.dpr = dpr;
    for (const canvas of [this.canvas, this.plate]) {
      canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
    }
    const css = getComputedStyle(document.body), color = key => css.getPropertyValue(key).trim();
    this.colors = { accent: color('--accent'), success: color('--success'), fine: color('--fine'), muted: color('--muted') };
    const g = this.plate.getContext('2d'); if (!g || !this.ctx) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Half a marker of inset keeps the origin/end marker whole, not clipped.
    this.plot = { left: 3, right: width - 3, top: 6, bottom: Math.max(7, height - 16) };
    const p = this.plot, X = x => p.left + (p.right - p.left) * x / 3, Y = y => p.bottom - (p.bottom - p.top) * y;
    g.strokeStyle = this.colors.fine; g.lineWidth = 1; g.beginPath();
    for (const x of [0, 1, 2, 3]) { g.moveTo(X(x), p.top); g.lineTo(X(x), p.bottom); }
    for (const y of [0, -Math.expm1(-1), 1]) { g.moveTo(p.left, Y(y)); g.lineTo(p.right, Y(y)); }
    g.stroke(); g.font = '8px ' + color('--mono'); g.fillStyle = this.colors.muted; g.textBaseline = 'top';
    ['0', '1C', '2C', '3C'].forEach((label, i) => {
      g.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center'; g.fillText(label, X(i), p.bottom + 4);
    });
    g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText('63.2%', p.left + 3, Y(-Math.expm1(-1)) - 2);
    this.curve = new Path2D(); this.curve.moveTo(X(0), Y(0));
    for (let i = 1; i <= 180; i++) this.curve.lineTo(X(i / 60), Y(-Math.expm1(-i / 60)));
    this.area = new Path2D(this.curve); this.area.lineTo(X(3), Y(0)); this.area.closePath();
    g.strokeStyle = this.colors.accent; g.globalAlpha = .35; g.stroke(this.curve);
    this.drawKey = ''; this.draw();
  }
  draw() {
    const g = this.ctx, p = this.plot; if (!g || !p || !this.curve) return;
    const x = Math.max(0, Math.min(3, this.x));
    const px = p.left + (p.right - p.left) * x / 3, py = p.bottom - (p.bottom - p.top) * -Math.expm1(-x);
    const hit = this.status === 'found';
    const key = [px, py, hit].join('|'); if (key === this.drawKey) return;
    this.drawKey = key;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.width, this.height);
    g.drawImage(this.plate, 0, 0, this.width, this.height);
    if (x > 0) {
      g.save(); g.beginPath(); g.rect(0, 0, px, this.height); g.clip();
      g.fillStyle = this.colors.accent; g.globalAlpha = .14; g.fill(this.area);
      g.strokeStyle = this.colors.accent; g.globalAlpha = 1; g.lineWidth = 1.5; g.stroke(this.curve); g.restore();
    }
    const color = hit ? this.colors.success : this.colors.accent;
    g.strokeStyle = color; g.lineWidth = 1; g.globalAlpha = .55;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, p.bottom); g.stroke();
    g.globalAlpha = 1; g.fillStyle = color; g.beginPath(); g.arc(px, py, 2.5, 0, Math.PI * 2); g.fill();
    this.marker = { x: px, y: py, color }; this.draws++;
  }
  get diagnostics() {
    return { candidates: String(this.count), trials: String(this.trials), ratio: this.x, status: this.status,
      label: this.output.textContent, width: this.width, height: this.height, draws: this.draws, updates: this.updates,
      marker: this.marker ? { ...this.marker } : null, plot: this.plot ? { ...this.plot } : null };
  }
}

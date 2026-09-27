'use strict';
/** Width-bounded instruments; exact integers remain exact in records and exports. */
const BogoNumbers = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const group = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
  const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
  // One scale per search, shared by the main meter, peak and worker meters.
  // Crossing 1,000 or 1,000,000 must not relocate the decimal point or unit.
  let rateExponent = null;
  function resetRateScale() { rateExponent = null; }
  function selectRateScale(value) {
    if (rateExponent !== null || !Number.isFinite(value) || value <= 0) return;
    rateExponent = Math.max(0, Math.floor(Math.log10(value) / 3) * 3);
  }
  function rate(value) {
    if (!Number.isFinite(value) || value < 0) return { text: '—', unit: '' };
    const exponent = rateExponent ?? 0;
    const prefixes = { 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P', 18: 'E' };
    const unit = (prefixes[exponent] ?? ('e' + exponent)) + '/s';
    const scaled = value / 10 ** exponent;
    // Keep two decimal places, including trailing zeroes. Expand rare, very
    // large values rather than smuggling a moving exponent into a digit reel.
    let text = scaled.toFixed(2);
    if (/e/i.test(text)) {
      const [mantissa, power] = text.toLowerCase().split('e');
      const [whole, fraction = ''] = mantissa.split('.');
      text = (whole + fraction).padEnd(whole.length + Number(power), '0') + '.00';
    }
    return { text, unit, value, belowResolution: value > 0 && text === '0.00' };
  }
  function compactInteger(value) {
    const n = BigInt(value), digits = String(n);
    if (n < 1000000000000000n) return short.format(n);
    return digits[0] + '.' + digits.slice(1, 3) + 'e' + (digits.length - 1);
  }
  function seconds(ms, places = 3) {
    if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) return '—';
    // Do not divide a huge floating-point value and silently lose milliseconds.
    const scale = 10 ** places, wholeMs = Math.floor(ms);
    const fractionUnits = Math.round((ms - wholeMs) * scale / 1000);
    const units = BigInt(wholeMs) * BigInt(scale) / 1000n + BigInt(fractionUnits);
    return String(units / BigInt(scale)) + (places ? '.' + String(units % BigInt(scale)).padStart(places, '0') : '');
  }
  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return { text: '—', unit: '' };
    if (ms < 1000) return { text: ms.toFixed(ms < 1 ? 2 : 1), unit: 'ms' };
    if (ms < 60000) return { text: (ms / 1000).toFixed(2), unit: 's' };
    const totalSeconds = Math.floor(ms / 1000), pad = n => String(n).padStart(2, '0');
    if (ms < 3600000) return { text: Math.floor(totalSeconds / 60) + ':' + pad(totalSeconds % 60), unit: 'm:s' };
    if (ms < 86400000) return { text: Math.floor(totalSeconds / 3600) + ':' + pad(Math.floor(totalSeconds / 60) % 60) + ':' + pad(totalSeconds % 60), unit: 'h:m:s' };
    const days = ms / 86400000;
    return { text: days < 1e6 ? group(Math.floor(days)) + (days < 1000 ? '.' + String(Math.floor(days * 100) % 100).padStart(2, '0') : '') : days.toExponential(2).replace('e+', 'e'), unit: 'd' };
  }
  function fit(el, text, previous = '') {
    const parent = el.parentElement;
    if (!ctx || !parent || !parent.clientWidth) return;
    const base = getComputedStyle(parent), own = getComputedStyle(el);
    let width = parent.clientWidth;
    if (parent.tagName === 'DD') {
      const unit = parent.querySelector('.unit');
      if (unit && unit.textContent) width -= unit.getBoundingClientRect().width + 6;
    } else if (parent.classList.contains('worker-lane')) {
      // A grid item may span only its track, not the entire parent grid.
      width = el.clientWidth;
    } else if (el.id === 'chart-peak') {
      width = Math.min(width * .46, el.clientWidth || 90);
    }
    const size = parseFloat(base.fontSize) || 20;
    ctx.font = `${own.fontWeight} ${size}px ${own.fontFamily}`;
    const measured = Math.max(ctx.measureText(text).width, ctx.measureText(previous).width, 1);
    const chosen = Math.min(size, (Math.max(1, width) - 2) * size / measured);
    const key = [text, previous, width, size].join('|');
    if (el.dataset.fitKey === key) return;
    el.dataset.fitKey = key;
    el.style.fontSize = chosen + 'px';
  }
  return { group, rate, resetRateScale, selectRateScale, compactInteger, seconds, duration, fit };
})();

/** Exact counts switch directly. No interpolation, extrapolation or rolling. */
class ExactCounter {
  constructor(root, exact, output) {
    this.root = root; this.exact = exact; this.output = output;
    this.text = ''; this.updates = 0; this.times = []; this.width = 0;
  }
  set(n) {
    const text = String(n);
    if (text === this.text) return;
    this.text = text;
    const groups = text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ').split(' ');
    // Full-size numerals with narrow inter-group space, not oversized commas.
    while (this.root.childElementCount > groups.length) this.root.lastElementChild.remove();
    groups.forEach((value, i) => {
      let el = this.root.children[i];
      if (!el) { el = document.createElement('span'); el.className = 'count-group'; this.root.append(el); }
      if (el.textContent !== value) el.textContent = value;
    });
    this.exact.textContent = text;
    this.output.dataset.value = text;
    this.output.setAttribute('aria-label', text + ' trials');
    this.times.push(performance.now()); if (this.times.length > 256) this.times.shift();
    this.updates++; this.resize();
  }
  resize() {
    const width = this.output.parentElement.clientWidth;
    if (!width) return;
    const ceiling = matchMedia('(max-width:760px), (pointer:coarse) and (max-height:590px)').matches ? 55 : innerHeight < 760 ? 52 : 72;
    const key = `${width}/${this.text.length}/${ceiling}`;
    if (key === this.fitKey) return;
    this.fitKey = key;
    const units = this.text.length * .63 + Math.floor((this.text.length - 1) / 3) * .15;
    this.output.style.fontSize = Math.min(ceiling, (width - 2) / Math.max(1, units)) + 'px';
  }
  get diagnostics() { return { updates: this.updates, updateTimes: this.times.slice(), lastValue: this.text, mode: 'direct-exact' }; }
}

/** Low-frequency measurement display. Only changed digit columns move.
 * Direction follows the whole rounded reading, not the shortest route of an
 * individual digit. A reverse carry is therefore the reverse of a carry.
 * Intermediate glyphs belong to the reel, never to the measured data record.
 */
class RollingMetric {
  static instances = new Set();
  static settleAll() { for (const metric of RollingMetric.instances) metric.finish(); }
  constructor(el, interval = 1600, externalUnit = null) {
    RollingMetric.instances.add(this);
    this.el = el; this.interval = interval; this.at = -Infinity;
    this.text = ''; this.unit = ''; this.columns = []; this.integerPlaces = 4;
    this.animations = new Map(); this.times = []; this.updates = 0;
    this.lastPaths = []; this.direction = 0;
    this.valueRoot = document.createElement('span');
    this.valueRoot.className = 'metric-value'; this.valueRoot.setAttribute('aria-hidden', 'true');
    this.unitRoot = externalUnit || document.createElement('span');
    this.unitRoot.classList.add('metric-unit');
    this.externalUnit = !!externalUnit;
    this.el.classList.add('metric-instrument');
    this.el.replaceChildren(this.valueRoot);
    if (!externalUnit) this.el.append(this.unitRoot);
    this.reset();
  }
  static path(from, to, direction) {
    const sequence = [from];
    if (from === to || !direction) return sequence;
    let current = from;
    for (let i = 0; i < 9 && current !== to; i++) {
      current = (current + direction + 10) % 10; sequence.push(current);
    }
    return sequence;
  }
  finish() {
    for (const [cell, animation] of this.animations) {
      animation.onfinish = null; animation.oncancel = null;
      animation.cancel();
      cell.querySelector('.digit-strip')?.remove();
      cell.classList.remove('is-rolling');
      cell.removeAttribute('data-path');
    }
    this.animations.clear();
  }
  rotate(cell, from, to, direction) {
    const sequence = RollingMetric.path(from, to, direction);
    if (sequence.length < 2) return;
    this.lastPaths.push({ place: cell.dataset.place, from, to, direction, sequence });
    const strip = document.createElement('span'); strip.className = 'digit-strip';
    const rows = direction > 0 ? sequence : sequence.slice().reverse();
    for (const digit of rows) {
      const row = document.createElement('span'); row.textContent = String(digit); strip.append(row);
    }
    strip.setAttribute('aria-hidden', 'true');
    const distance = (rows.length - 1) * 1.16;
    const fromY = direction > 0 ? 0 : -distance;
    const toY = direction > 0 ? -distance : 0;
    strip.style.transform = `translateY(${toY}em)`;
    cell.classList.add('is-rolling'); cell.dataset.path = sequence.join(','); cell.append(strip);
    const animation = strip.animate([
      { transform: `translateY(${fromY}em)` },
      { transform: `translateY(${toY}em)` }
    ], { duration: 260 + (rows.length - 2) * 14, easing: 'cubic-bezier(.32,.05,.2,1)' });
    this.animations.set(cell, animation);
    animation.onfinish = () => {
      // A previous animation cannot remove a newly started strip.
      if (this.animations.get(cell) !== animation) return;
      this.animations.delete(cell); strip.remove();
      cell.classList.remove('is-rolling'); cell.removeAttribute('data-path');
    };
  }
  set(reading, settle = false) {
    if (typeof reading === 'string') reading = { text: reading, unit: '' };
    const text = reading.text, unit = reading.unit || '';
    const now = performance.now();
    if (!settle && now - this.at < this.interval) return false;
    this.at = now;
    const numeric = /^\d+\.\d{2}$/.test(text);
    const wasNumeric = /^\d+\.\d{2}$/.test(this.text);
    const quiet = settle || document.hidden || document.body.dataset.fx === 'quiet' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (quiet) this.finish();
    if (text === this.text && unit === this.unit && !!reading.belowResolution === this.belowResolution) return false;
    const previous = this.text, previousUnit = this.unit;
    this.finish(); this.lastPaths = []; this.direction = 0;
    this.text = text; this.unit = unit; this.belowResolution = !!reading.belowResolution;
    this.el.dataset.value = text;
    this.el.setAttribute('aria-label', (this.belowResolution ? 'Less than 0.01' : text) + (unit ? ' ' + unit : ''));
    if (this.unitRoot.textContent !== unit) this.unitRoot.textContent = unit;
    this.unitRoot.style.setProperty('--unit-width', Math.max(3, unit.length) + 'ch');
    if (!numeric || this.belowResolution) {
      this.columns = [];
      this.valueRoot.textContent = this.belowResolution ? '<0.01' : text;
    } else {
      const [whole, fraction] = text.split('.');
      const places = Math.max(4, this.integerPlaces, whole.length);
      const padded = whole.padStart(places, ' ') + '.' + fraction;
      const rebuild = !this.columns.length || this.integerPlaces !== places;
      this.integerPlaces = places;
      if (rebuild) {
        this.columns = []; this.valueRoot.replaceChildren();
        for (let i = 0; i < padded.length; i++) {
          const cell = document.createElement('span');
          cell.className = padded[i] === '.' ? 'metric-mark' : 'metric-digit';
          cell.dataset.place = i < places ? String(places - i - 1) : String(places - i);
          const glyph = document.createElement('span'); glyph.className = 'digit-glyph';
          cell.append(glyph); this.valueRoot.append(cell); this.columns.push(cell);
        }
      }
      const oldPadded = wasNumeric ? previous.split('.')[0].padStart(places, ' ') + '.' + previous.split('.')[1] : '';
      if (wasNumeric && previousUnit === unit) {
        const before = BigInt(previous.replace('.', '')), after = BigInt(text.replace('.', ''));
        this.direction = after > before ? 1 : after < before ? -1 : 0;
      }
      for (let i = 0; i < padded.length; i++) {
        const cell = this.columns[i], glyph = cell.firstChild, next = padded[i], old = oldPadded[i];
        // The same digit, decimal point and unit keep the same DOM nodes.
        if (glyph.textContent !== next) glyph.textContent = next;
        cell.classList.toggle('leading-place', next === ' ');
        const canRoll = !quiet && !rebuild && this.direction && next !== old &&
          /^\d$/.test(next) && /^\d$/.test(old || '') && typeof cell.animate === 'function';
        if (canRoll) this.rotate(cell, Number(old), Number(next), this.direction);
      }
    }
    this.resize();
    this.times.push(now); if (this.times.length > 100) this.times.shift(); this.updates++;
    return true;
  }
  resize() {
    // Compact worker lanes omit leading blank columns. Fit the actual reading,
    // not four invisible integer places, so the requested 9px text stays 9px.
    const worker = this.el.parentElement.classList.contains('worker-lane');
    const digits = worker && /^\d+\.\d{2}$/.test(this.text) ? this.text : '0'.repeat(this.integerPlaces) + '.00';
    BogoNumbers.fit(this.el, digits + (this.externalUnit ? '' : ' ' + (this.unit || 'M/s')));
  }
  reset() {
    this.finish(); this.at = -Infinity; this.text = ''; this.unit = ''; this.integerPlaces = 4;
    this.set({ text: '—', unit: '' }, true);
  }
  dispose() { this.finish(); RollingMetric.instances.delete(this); }
  get diagnostics() {
    return { mode: 'directional-digit-reels', intervalMs: this.interval, updates: this.updates,
      updateTimes: this.times.slice(), text: this.text, unit: this.unit, direction: this.direction,
      paths: this.lastPaths.map(p => ({ ...p, sequence: p.sequence.slice() })), activeDigits: this.animations.size };
  }
}

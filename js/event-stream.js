'use strict';
/** Presentation-only trace. Completed tests supply all candidate data. The
 * independent editorial RNG chooses layouts and pacing, never search values.
 * No complete trial history, frame-by-frame arithmetic, or background timers. */
class EventStream {
  constructor(root) {
    this.root = root;
    this.preview = document.getElementById('core-activity');
    this.mobile = matchMedia('(max-width:760px), (pointer:coarse) and (max-height:590px)');
    this.mobile.addEventListener('change', () => this.syncPreview());
    this.seen = new Map();
    this.recentStyles = [];
    this.pending = [];
    this.worker = 0;
    this.nextAt = 0;
    this.entries = 0;
    this.groups = 0;
    this.styles = new Uint32Array(10);
    this.timings = [];
    this.renderMs = 0;
    this.announced = false;
    this.following = true;
    this.scrollFrame = 0;
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const hold = () => { this.following = false; };
    root.addEventListener('wheel', hold, { passive: true });
    root.addEventListener('touchstart', hold, { passive: true });
    root.addEventListener('pointerdown', hold);
    root.addEventListener('keydown', e => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) hold();
    });
    root.addEventListener('scroll', () => {
      this.following = root.scrollHeight - root.scrollTop - root.clientHeight < 5;
    }, { passive: true });
  }
  syncPreview() {
    if (!this.preview || !this.mobile.matches) return;
    const rows = Array.from(this.root.children).slice(-2).map(row => {
      const copy = row.cloneNode(true); copy.removeAttribute('title'); return copy;
    });
    this.preview.replaceChildren(...rows);
  }
  quiet() { return this.reduce.matches || document.body.dataset.fx === 'quiet' || document.hidden; }
  cancelScroll() { this.pending.length = 0; }
  line(mark, tokens, level = '', detail = '') {
    const t = performance.now(), root = this.root;
    const row = document.createElement('div');
    row.className = 'event trace-line'; row.dataset.level = level;
    row.title = detail;
    const badge = document.createElement('b'); badge.className = 'trace-mark'; badge.textContent = mark;
    const body = document.createElement('span'); body.className = 'event-message';
    for (const [kind, text] of tokens) {
      const span = document.createElement('span'); span.className = 'token-' + kind;
      span.textContent = text; body.append(span);
    }
    row.append(badge, body);
    const top = this.following ? 0 : root.scrollTop;
    root.append(row);
    if (this.preview && this.mobile.matches && !document.hidden) {
      const previewRow = row.cloneNode(true);
      previewRow.removeAttribute('title');
      this.preview.append(previewRow);
      while (this.preview.children.length > 2) this.preview.firstElementChild.remove();
    }
    let removed = 0;
    while (root.children.length > 96) { root.firstElementChild.remove(); removed++; }
    if (this.following) root.scrollTop = 1e7;
    else if (removed) root.scrollTop = Math.max(0, top - removed * 18);
    this.entries++;
    this.timings.push(t); if (this.timings.length > 192) this.timings.shift();
    this.renderMs += performance.now() - t;
  }
  log(tag, text, level = '', detail = text) {
    if (['HOLD','STOP','HIT','LIMIT','FAULT'].includes(tag)) this.pending.length = 0;
    this.line(level === 'warn' ? '!' : level === 'hit' ? '✓' : '›',
      [['label', tag.toLowerCase()], ['dim', '  '], ['text', text]], level, detail);
  }
  short(s, n = 15) {
    s = String(s); return s.length <= n ? s : s.slice(0, n - 6) + '…' + s.slice(-5);
  }
  group(lane) {
    const s = lane.sample, who = 'w' + (lane.index + 1);
    const d = BigInt(s.divisor), hex = d.toString(16).toUpperCase();
    const value = '0x' + this.short(hex, 16), decimal = this.short(s.divisor, 18);
    const hit = !!s.hit || s.remainder === '0';
    const detail = `Worker ${lane.index + 1}; completed trial ${s.trial}; d = ${s.divisor}; ` +
      (hit ? 'divides N exactly.' : 'does not divide N.') +
      ` Completed interval ${s.fromTrial}–${s.trial}: ${s.tested} trials.`;
    const row = (mark, ...tokens) => ({ mark, tokens, detail, level: hit ? 'hit' : '' });
    if (hit) return [
      row('✓', ['worker', who], ['hit', '  DIVISOR FOUND']),
      row('│', ['dim', '  d = '], ['literal', decimal]),
      row('└', ['hit', '  N mod d = 0'])
    ];
    // Mix views of real completed records, not scripts or invented operations.
    // Avoid a repeating layout cycle; the choice never changes search state.
    const choices = Array.from({ length: 10 }, (_, i) => i).filter(i => !this.recentStyles.includes(i));
    const mode = choices[Math.floor(Math.random() * choices.length)];
    this.recentStyles.push(mode); if (this.recentStyles.length > 3) this.recentStyles.shift();
    this.styles[mode]++; this.groups++;
    const num = x => BogoNumbers.compactInteger(BigInt(x));
    const trial = '#' + this.short(s.trial, 12);
    switch (mode) {
      case 0:
        return [row('›', ['worker', who], ['label', '  TEST '], ['literal', trial]),
          row('└', ['dim', 'd = '], ['literal', decimal], ['verdict', '  rejected'])];
      case 1: {
        // A real hexadecimal excerpt, with its digit offset (from the most
        // significant hex digit) shown explicitly. No memory addresses or data
        // outside the sampled candidate are fabricated.
        const wordCount = Math.ceil(hex.length / 4);
        const count = Math.min(wordCount, 4 + Math.floor(Math.random() * 9));
        const startWord = Math.floor(Math.random() * Math.max(1, wordCount - count + 1));
        const start = startWord * 4, end = Math.min(hex.length, (startWord + count) * 4);
        const rows = [row('›', ['worker', who], ['label', '  d / HEX '],
          ['dim', start + '–' + (end - 1)])];
        for (let offset = start; offset < end; offset += 16) {
          const segment = hex.slice(offset, Math.min(offset + 16, end));
          rows.push(row(offset + 16 >= end ? '└' : '│', ['dim', '  '],
            ['hex', segment.match(/.{1,4}/g).join(' ')]));
        }
        return rows;
      }
      case 2:
        return [row('›', ['worker', who], ['dim', '  d = '], ['literal', decimal]),
          row('└', ['dim', '  N mod d '], ['verdict', '≠ 0'])];
      case 3:
        return [row('·', ['worker', who], ['dim', '  '], ['literal', num(s.tested)], ['verdict', ' rejected']),
          row('└', ['dim', '  #' + this.short(s.fromTrial, 10) + ' → #' + this.short(s.trial, 10)])];
      case 4:
        return [row('›', ['worker', who], ['dim', '  d = '], ['literal', value]),
          row('└', ['verdict', '  REJECTED'], ['dim', ' / '], ['literal', trial])];
      case 5:
        return [row('›', ['worker', who], ['dim', '  '], ['literal', decimal], ['verdict', '  reject'])];
      case 6:
        return [row('·', ['worker', who], ['label', '  TEST '], ['literal', trial]),
          row('│', ['dim', '  d / '], ['literal', d.toString(2).length + ' bits']),
          row('└', ['dim', '  '], ['literal', value])];
      case 7:
        return [row('›', ['worker', who], ['label', '  DIVISIBILITY']),
          row('│', ['dim', '  d = '], ['literal', value]),
          row('└', ['verdict', '  NOT A DIVISOR'])];
      case 8:
        return [row('›', ['worker', who], ['dim', '  '], ['literal', value]),
          row('└', ['verdict', '  NONZERO RESIDUE'])];
      case 9:
        return [row('·', ['worker', who], ['label', '  COMPLETED INTERVAL']),
          row('│', ['dim', '  #' + this.short(s.fromTrial, 10) + ' → #' + this.short(s.trial, 10)]),
          row('└', ['literal', '  ' + num(s.tested)], ['dim', ' tests / '], ['verdict', '0 hits'])];
    }
  }
  update(snapshot) {
    if (snapshot.status !== 'running' || document.hidden) return;
    const ms = snapshot.elapsedMs, workers = snapshot.workers || [];
    if (!this.announced) {
      this.announced = true;
      this.log('EXEC', 'divisor search started');
      this.nextAt = ms + 30;
      return;
    }
    if (ms < this.nextAt) return;
    if (!this.pending.length) {
      for (let k = 0; k < workers.length; k++) {
        const i = (this.worker + k) % workers.length, lane = workers[i], s = lane.sample;
        if (!s || this.seen.get(i) === s.trial) continue;
        this.seen.set(i, s.trial); this.worker = (i + 1) % workers.length;
        this.pending = this.group(lane); break;
      }
    }
    const item = this.pending.shift();
    if (!item) { this.nextAt = ms + 25; return; }
    this.line(item.mark, item.tokens, item.level, item.detail);
    // Short bursts alternate with breathing spaces; no replay of missed slots.
    this.nextAt = ms + (this.pending.length ? 12 + Math.random() * 25 : 35 + Math.random() * 90);
  }
  reset() {
    this.preview?.replaceChildren();
    this.seen.clear(); this.recentStyles.length = 0; this.pending.length = 0;
    this.worker = 0; this.nextAt = 0; this.announced = false;
  }
  get diagnostics() {
    return { entries: this.entries, groups: this.groups, styles: Array.from(this.styles),
      retained: this.root.children.length, pending: this.pending.length, updateTimes: this.timings,
      totalRenderMs: this.renderMs };
  }
}

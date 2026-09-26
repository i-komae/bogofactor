'use strict';
/** Bounded, presentation-only activity feed. Every record is derived from an
 * actual engine event or snapshot; no random statuses or pretend work. */
class EventStream {
  constructor(root) {
    this.root = root;
    this.nextAt = 0;
    this.interval = 1000 / 12;
    this.lastWork = 0n;
    this.step = 0;
    this.worker = 0;
    this.announced = false;
    this.scrollFrame = 0;
    this.following = true;
    this.entries = 0;
    this.nf = new Intl.NumberFormat('en-US');
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const stopFollowing = () => { this.cancelScroll(); this.following = false; };
    root.addEventListener('wheel', stopFollowing, { passive: true });
    root.addEventListener('touchstart', stopFollowing, { passive: true });
    root.addEventListener('pointerdown', stopFollowing);
    root.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stopFollowing();
    });
  }
  quiet() {
    return this.reduce.matches || document.body.dataset.fx === 'quiet' || document.hidden;
  }
  cancelScroll() {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
  }
  scrollToEnd() {
    this.cancelScroll();
    const from = this.root.scrollTop, end = this.root.scrollHeight - this.root.clientHeight;
    if (this.quiet() || this.root.clientHeight === 0 || end <= from) {
      this.root.scrollTop = end; return;
    }
    const start = performance.now();
    const scroll = now => {
      this.scrollFrame = 0;
      const t = Math.min(1, Math.max(0, (now - start) / 70));
      this.root.scrollTop = from + (end - from) * (1 - (1 - t) ** 3);
      if (t < 1 && !this.quiet()) this.scrollFrame = requestAnimationFrame(scroll);
      else this.root.scrollTop = end;
    };
    this.scrollFrame = requestAnimationFrame(scroll);
  }
  log(tag, text, level = '', detail = text) {
    const root = this.root;
    const tail = this.following || root.scrollHeight - root.scrollTop - root.clientHeight <= 12;
    const oldTop = root.scrollTop, oldHeight = root.scrollHeight;
    this.cancelScroll();
    const row = document.createElement('div'); row.className = 'event'; row.dataset.level = level;
    const time = document.createElement('time'), code = document.createElement('b'), message = document.createElement('span');
    const now = new Date(); time.dateTime = now.toISOString();
    time.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
    code.textContent = tag;
    message.className = 'event-message'; message.textContent = text;
    // Full details stay available without turning one record into two rows.
    row.title = time.textContent + ' ' + tag + ' ' + detail;
    row.append(time, code, message); root.append(row);
    const addedHeight = root.scrollHeight - oldHeight;
    while (root.children.length > 96) root.firstElementChild.remove();
    this.entries++;
    this.following = tail;
    if (tail) this.scrollToEnd();
    else root.scrollTop = Math.max(0, oldTop - (oldHeight + addedHeight - root.scrollHeight));
  }
  rate(value) {
    if (!Number.isFinite(value)) return '—';
    const formatted = BogoNumbers.rate(Math.max(0, value));
    return formatted.text + (formatted.unit ? ' ' + formatted.unit : '');
  }
  update(snapshot) {
    if (snapshot.status !== 'running' || document.hidden) return;
    const ms = snapshot.elapsedMs, total = BigInt(snapshot.trials);
    if (!this.announced && snapshot.candidateCount) {
      this.announced = true;
      this.log('SPACE', BogoNumbers.compactInteger(BigInt(snapshot.candidateCount)), '',
        snapshot.candidateCount + ' eligible integers');
      this.nextAt = ms + this.interval; return;
    }
    // Twelve records/second on the existing snapshot stream. Advance along a
    // fixed timeline so frame quantization does not slow the feed to 10 Hz.
    // Emit at most one record per snapshot; skip missed slots, never replay
    // a backlog after pause, a hidden tab or a slow frame.
    if (ms < this.nextAt) return;
    this.nextAt += (Math.floor((ms - this.nextAt) / this.interval) + 1) * this.interval;
    const workers = snapshot.workers || [];
    const active = workers.filter(worker => worker.state === 'running');
    switch (this.step++ % 6) {
      case 0: {
        const delta = total - this.lastWork; this.lastWork = total;
        this.log('TEST', '+' + BogoNumbers.compactInteger(delta), '',
          '+' + this.nf.format(delta) + ' evaluated'); break;
      }
      case 1:
        this.log('RATE', this.rate(snapshot.rate)); break;
      case 2: {
        const lane = active.length ? active[this.worker++ % active.length] : workers[0];
        if (lane) this.log('WORKER', 'W' + (lane.index + 1) + ' · ' + this.rate(lane.rate));
        else this.log('POOL', 'Awaiting data');
        break;
      }
      case 3: {
        const bytes = workers.reduce((sum, worker) => sum + (worker.memoryBytes || 0), 0);
        this.log('MEMORY', (bytes / 1048576).toFixed(1) + ' MiB', '',
          (bytes / 1048576).toFixed(1) + ' MiB · ' + active.length + '/' + workers.length + ' workers'); break;
      }
      case 4:
        this.log('TOTAL', BogoNumbers.compactInteger(total), '', this.nf.format(total) + ' completed'); break;
      case 5: {
        const elapsed = BogoNumbers.duration(ms);
        this.log('TIME', elapsed.text + ' ' + elapsed.unit); break;
      }
    }
  }
  reset() {
    this.nextAt = 0; this.lastWork = 0n; this.step = 0; this.worker = 0; this.announced = false;
  }
}

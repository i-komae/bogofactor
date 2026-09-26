'use strict';
/** Bounded, presentation-only activity feed. Every record is derived from an
 * actual engine event or snapshot; no random statuses or pretend work. */
class EventStream {
  constructor(root) {
    this.root = root;
    this.lastAt = 0;
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
      const t = Math.min(1, Math.max(0, (now - start) / 170));
      this.root.scrollTop = from + (end - from) * (1 - (1 - t) ** 3);
      if (t < 1 && !this.quiet()) this.scrollFrame = requestAnimationFrame(scroll);
      else this.root.scrollTop = end;
    };
    this.scrollFrame = requestAnimationFrame(scroll);
  }
  log(tag, text, level = '') {
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
    row.append(time, code, message); root.append(row);
    const addedHeight = root.scrollHeight - oldHeight;
    while (root.children.length > 48) root.firstElementChild.remove();
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
      this.log('SPACE', BogoNumbers.compactInteger(BigInt(snapshot.candidateCount)) + ' eligible integers');
      this.lastAt = ms; return;
    }
    // Four new records per second at most, independent of counter and reels.
    // Missed intervals are not replayed after pausing or hiding the page.
    if (ms - this.lastAt < 250) return;
    this.lastAt = ms;
    const workers = snapshot.workers || [];
    const active = workers.filter(worker => worker.state === 'running');
    switch (this.step++ % 6) {
      case 0: {
        const delta = total - this.lastWork; this.lastWork = total;
        this.log('TEST', '+' + this.nf.format(delta) + ' evaluated'); break;
      }
      case 1:
        this.log('RATE', this.rate(snapshot.rate)); break;
      case 2: {
        const lane = active.length ? active[this.worker++ % active.length] : workers[0];
        if (lane) this.log('WORKER', 'W' + (lane.index + 1) + ' · ' + this.rate(lane.rate));
        else this.log('POOL', 'Waiting for first worker report');
        break;
      }
      case 3: {
        const bytes = workers.reduce((sum, worker) => sum + (worker.memoryBytes || 0), 0);
        this.log('MEMORY', (bytes / 1048576).toFixed(1) + ' MiB · ' + active.length + '/' + workers.length + ' workers'); break;
      }
      case 4:
        this.log('TOTAL', this.nf.format(total) + ' completed'); break;
      case 5: {
        const ticks = Math.floor(Math.max(0, ms) / 10);
        const minutes = Math.floor(ticks / 6000);
        const clock = String(minutes).padStart(2, '0') + ':' +
          String(Math.floor(ticks / 100) % 60).padStart(2, '0') + '.' + String(ticks % 100).padStart(2, '0');
        this.log('TIME', clock + ' active'); break;
      }
    }
  }
  reset() {
    this.lastAt = 0; this.lastWork = 0n; this.step = 0; this.worker = 0; this.announced = false;
  }
}

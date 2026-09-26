'use strict';
/** A bounded trace of completed divisor tests, not a carousel of dashboard
 * metrics. Sparse Worker samples retain exact trial IDs and remainders. */
class EventStream {
  constructor(root) {
    this.root = root;
    this.nextAt = 0;
    this.interval = 1000 / 12;
    this.seen = new Map();
    this.sampleRows = 0;
    this.pendingBatch = null;
    this.worker = 0;
    this.announced = false;
    this.scrollFrame = 0;
    this.following = true;
    this.entries = 0;
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
  brief(value) {
    const text = String(value);
    return text.length <= 7 ? text : text.slice(0, 3) + '…' + text.slice(-3);
  }
  update(snapshot) {
    if (snapshot.status !== 'running' || document.hidden) return;
    const ms = snapshot.elapsedMs, workers = snapshot.workers || [];
    if (!this.announced && snapshot.candidateCount) {
      this.announced = true;
      const root = BOGO.sqrt(BigInt(snapshot.n));
      this.log('CHECK', 'Composite confirmed', '', 'The primality screen returned composite; divisor sampling is now running.');
      this.log('BOUND', '2 ≤ d ≤ ' + this.brief(root), '',
        'Draw d uniformly from eligible integers between 2 and ' + root + ', with replacement.');
      this.log('SIEVE', '2·3·5·7·11·13·17', '',
        'Exclude multiples of these primes, but retain the primes themselves as candidate divisors.');
      this.log('POOL', workers.length + ' samplers started', '',
        workers.length + ' independent Worker samplers; first verified factor stops the pool.');
      this.nextAt = ms + this.interval;
      return;
    }
    if (ms < this.nextAt) return;
    // No catch-up bursts and no cycling through static memory/time/rate values.
    this.nextAt += (Math.floor((ms - this.nextAt) / this.interval) + 1) * this.interval;
    if (this.pendingBatch) {
      const { index, sample } = this.pendingBatch;
      this.pendingBatch = null;
      this.log('BATCH', 'W' + (index + 1) + ' +' + BogoNumbers.compactInteger(BigInt(sample.tested)) + ' misses', '',
        'Worker ' + (index + 1) + ': completed trials ' + sample.fromTrial + '–' + sample.trial +
        '; all ' + sample.tested + ' candidates in this interval failed divisibility.');
      return;
    }
    // Round-robin across fresh samples. Keep only each worker's latest sample;
    // never print the same completed test twice or invent one to fill a slot.
    for (let k = 0; k < workers.length; k++) {
      const i = (this.worker + k) % workers.length, lane = workers[i], sample = lane.sample;
      if (!sample || this.seen.get(i) === sample.trial) continue;
      this.worker = (i + 1) % workers.length;
      this.seen.set(i, sample.trial);
      const hit = sample.remainder === '0';
      this.log('W' + (i + 1), 'N%' + this.brief(sample.divisor) + '=' + this.brief(sample.remainder), hit ? 'hit' : '',
        'Worker ' + (i + 1) + ', completed trial #' + sample.trial + ': ' +
        snapshot.n + ' mod ' + sample.divisor + ' = ' + sample.remainder +
        (hit ? '; non-trivial factor verified.' : '; nonzero remainder, candidate rejected.'));
      // An occasional real rejection interval gives context to the individual
      // tests. This is a count of attempts, not an exhausted candidate range.
      if (!hit && ++this.sampleRows % 4 === 0 && BigInt(sample.tested) > 1n) {
        this.pendingBatch = { index: i, sample };
      }
      return;
    }
  }
  reset() {
    this.nextAt = 0; this.seen.clear(); this.sampleRows = 0; this.pendingBatch = null;
    this.worker = 0; this.announced = false; this.cancelScroll();
  }
}

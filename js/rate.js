'use strict';
/** Fixed-capacity recent wall-throughput window. Counts are never rounded first. */
class RateWindow {
  constructor() {
    this.counts = new BigUint64Array(16);
    this.times = new Float64Array(16);
    this.head = 0;
    this.size = 0;
  }
  reset(trials, ms) {
    this.head = 0;
    this.size = 1;
    this.counts[0] = trials;
    this.times[0] = ms;
  }
  record(trials, ms) {
    if (!this.size) { this.reset(trials, ms); return; }
    const last = (this.head + this.size - 1) % 16;
    if (ms <= this.times[last]) return;
    if (this.size === 16) { this.head = (this.head + 1) % 16; this.size--; }
    const at = (this.head + this.size) % 16;
    this.counts[at] = trials;
    this.times[at] = ms;
    this.size++;
    // Keep one sample at/before the boundary. Window is about 2–2.3 seconds.
    while (this.size > 2 && this.times[(this.head + 1) % 16] <= ms - 2000) {
      this.head = (this.head + 1) % 16;
      this.size--;
    }
  }
  value(trials, ms) {
    if (this.size < 2 || ms - this.times[this.head] < 200) return null;
    return Number(trials - this.counts[this.head]) * 1000 / (ms - this.times[this.head]);
  }
}

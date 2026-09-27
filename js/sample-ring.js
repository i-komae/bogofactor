'use strict';
/** Fixed-capacity FIFO of background samples as (v, u, q) number triples.
 * When full, the oldest triple is overwritten. Shared with the Worker; the
 * display keeps the latest RETAINED samples, so no stage needs to hold more.
 */
class SampleRing {
  static RETAINED = 32768;
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
    this.data = new Float64Array(this.capacity * 3);
    this.head = 0; this.size = 0; this.dropped = 0;
  }
  push(v, u, q) {
    let at;
    if (this.size < this.capacity) at = (this.head + this.size++) % this.capacity;
    else { at = this.head; this.head = (this.head + 1) % this.capacity; this.dropped++; }
    at *= 3;
    this.data[at] = v; this.data[at + 1] = u; this.data[at + 2] = q;
  }
  append(triples) {
    for (let i = 0; i + 2 < triples.length; i += 3) this.push(triples[i], triples[i + 1], triples[i + 2]);
  }
  /** Oldest first; the ring is empty afterwards. */
  take() {
    const out = new Float64Array(this.size * 3);
    const first = Math.min(this.size, this.capacity - this.head);
    out.set(this.data.subarray(this.head * 3, (this.head + first) * 3));
    if (first < this.size) out.set(this.data.subarray(0, (this.size - first) * 3), first * 3);
    this.head = 0; this.size = 0;
    return out;
  }
}

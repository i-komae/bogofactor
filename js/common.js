'use strict';
/** Exact integer helpers shared with the Worker. No work is done at import. */
function createBogoMath() {
  const LIMBS = 256;
  const WHEEL = 510510;
  const PHI = 92160;
  const PRIMES = [2, 3, 5, 7, 11, 13, 17];
  const BASES64 = [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n];
  const CANCELLED = Symbol('cancelled');
  let residues;

  function parse(value) {
    const s = String(value).normalize('NFKC').replace(/[\s,_]/g, '');
    if (!/^\d+$/.test(s)) throw Error('Enter an integer greater than or equal to 2.');
    if (s.length > 2000) throw Error('The input must not exceed 2,000 decimal digits.');
    const n = BigInt(s);
    if (n < 2n) throw Error('Enter an integer greater than or equal to 2.');
    return n;
  }

  function sqrt(n) {
    if (n < 0n) throw RangeError('Cannot take the square root of a negative integer.');
    if (n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) {
      const y = (x + n / x) >> 1n;
      if (y >= x) return x;
      x = y;
    }
  }

  function getResidues() {
    if (residues) return residues;
    const excluded = new Uint8Array(WHEEL);
    for (const p of PRIMES) for (let i = p; i < WHEEL; i += p) excluded[i] = 1;
    const result = new Uint32Array(PHI);
    let j = 0;
    for (let i = 1; i < WHEEL; i++) if (!excluded[i]) result[j++] = i;
    if (j !== PHI) throw Error('Could not construct the candidate table.');
    residues = result;
    return residues;
  }

  function countAllowed(x) {
    if (x < 2n) return 0n;
    const table = getResidues(), rem = Number(x % BigInt(WHEEL));
    let lo = 0, hi = table.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (table[m] <= rem) lo = m + 1;
      else hi = m;
    }
    const pc = PRIMES.filter(p => BigInt(p) <= x).length;
    return x / BigInt(WHEEL) * BigInt(PHI) + BigInt(lo - 1 + pc);
  }

  function config(n) {
    const root = sqrt(n);
    if (root < 2n) throw Error('There are no eligible candidates.');
    return { n, root, count: countAllowed(root), small: PRIMES.filter(p => BigInt(p) <= root) };
  }

  function write(ex, ptr, n) {
    if (n < 0n) throw RangeError('Invalid integer value.');
    const a = new Uint32Array(ex.memory.buffer, ptr, LIMBS);
    a.fill(0);
    let i = 0;
    while (n) {
      if (i === LIMBS) throw RangeError('The integer exceeds the arithmetic capacity.');
      a[i++] = Number(n & 0xffffffffn);
      n >>= 32n;
    }
    return i;
  }

  function read(ex, ptr, len) {
    if (len > LIMBS) throw RangeError('The result has an invalid length.');
    const a = new Uint32Array(ex.memory.buffer, ptr, len);
    let n = 0n;
    for (let i = len - 1; i >= 0; i--) n = (n << 32n) | BigInt(a[i]);
    return n;
  }

  function setup(ex, c) {
    const nl = write(ex, ex.ptr_n(), c.n);
    const bl = write(ex, ex.ptr_bound(), c.count - 1n);
    new Uint32Array(ex.memory.buffer, ex.ptr_residues(), PHI).set(getResidues());
    const small = new Uint32Array(ex.memory.buffer, ex.ptr_small(), 7);
    small.fill(0);
    small.set(c.small);
    if (!ex.init(nl, bl, c.small.length)) throw Error('Could not initialize the calculation.');
  }

  // A real task yield, only when the time budget is spent. No timer clamping
  // between primality bases. The same pacer covers the entire check.
  let yieldChannel;
  const pendingYields = [];
  function yieldTask() {
    if (!yieldChannel) {
      yieldChannel = new MessageChannel();
      yieldChannel.port1.onmessage = () => { const done = pendingYields.shift(); if (!pendingYields.length) yieldChannel.port1.unref?.(); done(); };
      yieldChannel.port1.unref?.(); yieldChannel.port2.unref?.();
    }
    return new Promise(resolve => { pendingYields.push(resolve); yieldChannel.port1.ref?.(); yieldChannel.port2.postMessage(0); });
  }
  class Pacer {
    constructor(cancel) { this.cancel = cancel; this.deadline = performance.now() + 12; this.steps = 0; this.rests = 0; }
    due() { return (++this.steps & 31) === 0 && performance.now() >= this.deadline; }
    async rest() {
      // A periodic timer turn prevents MessageChannel microtask chains from
      // starving timers/other task sources (notably in Node and some runtimes).
      if ((++this.rests & 3) === 1) await new Promise(resolve => setTimeout(resolve,0));
      else await yieldTask();
      if (this.cancel()) throw CANCELLED;
      this.deadline = performance.now() + 12;
    }
  }
  const mod = (a,n) => { a %= n; return a < 0n ? a + n : a; };
  function jacobi(a,n) {
    if (n <= 0n || !(n & 1n)) throw RangeError('Jacobi denominator must be positive and odd');
    a = mod(a,n);
    let sign = 1;
    while (a) {
      while (!(a & 1n)) {
        a >>= 1n;
        if ((n & 7n) === 3n || (n & 7n) === 5n) sign = -sign;
      }
      [a,n] = [n,a];
      if ((a & 3n) === 3n && (n & 3n) === 3n) sign = -sign;
      a %= n;
    }
    return n === 1n ? sign : 0;
  }
  async function power(a,bits,n,pacer) {
    let x=1n;
    a %= n;
    for (let i=0;i<bits.length;i++) {
      x=x*x%n;
      if (bits[i]==='1') x=x*a%n;
      if (pacer.due()) await pacer.rest();
    }
    return x;
  }
  async function strongMR(n,base,bits,s,pacer) {
    const a=base%n;
    if (a<2n) return true;
    let x=await power(a,bits,n,pacer);
    if (x===1n || x===n-1n) return true;
    for (let r=1;r<s;r++) {
      x=x*x%n;
      if (x===n-1n) return true;
      if (x===1n) return false;
      if (pacer.due()) await pacer.rest();
    }
    return false;
  }
  // Strong Lucas-Selfridge (method A), together with base-2 strong MR: BPSW.
  async function strongLucas(n,pacer) {
    let D=5n;
    for (;;) {
      const j=jacobi(D,n);
      if (j===-1) break;
      if (j===0 && (D<0n?-D:D)<n) return false;
      D=D>0n?-(D+2n):-D+2n;
      if (pacer.due()) await pacer.rest();
    }
    const Q=(1n-D)/4n;
    let k=n+1n,s=0;
    while (!(k&1n)) { k>>=1n; s++; }
    const bits=k.toString(2);
    let U=1n,V=1n,Qk=mod(Q,n);
    const half = x => { x=mod(x,n); return (x+(x&1n?n:0n))>>1n; };
    for (let i=1;i<bits.length;i++) {
      U=U*V%n;
      V=mod(V*V-2n*Qk,n);
      Qk=Qk*Qk%n;
      if (bits[i]==='1') {
        const prevU=U;
        U=half(U+V);
        V=half(D*prevU+V);
        Qk=mod(Qk*Q,n);
      }
      if (pacer.due()) await pacer.rest();
    }
    if (U===0n || V===0n) return true;
    for (let r=1;r<s;r++) {
      V=mod(V*V-2n*Qk,n); Qk=Qk*Qk%n;
      if (V===0n) return true;
      if (pacer.due()) await pacer.rest();
    }
    return false;
  }
  async function primality(n,cancel=()=>false) {
    if (n<2n) return 'composite';
    if (n===2n || n===3n) return 'prime';
    if (!(n&1n)) return 'composite';
    if (cancel()) return 'cancelled';
    const pacer=new Pacer(cancel);
    try {
      // A square must be rejected before searching for Selfridge's D.
      if ((n&15n)===1n || (n&15n)===9n) {
        const r=sqrt(n); if (r*r===n) return 'composite';
      }
      let d=n-1n,s=0;
      while (!(d&1n)) { d>>=1n; s++; }
      const bits=d.toString(2), exact=n<(1n<<64n);
      for (const a of exact?BASES64:[2n]) {
        if (!await strongMR(n,a,bits,s,pacer)) return 'composite';
        if (cancel()) return 'cancelled';
      }
      if (exact) return 'prime';
      return await strongLucas(n,pacer) ? 'probable' : 'composite';
    } catch(e) { if (e===CANCELLED) return 'cancelled'; throw e; }
  }

  return { parse, sqrt, config, getResidues, countAllowed, read, write, setup, primality, jacobi, LIMBS, WHEEL, PHI, PRIMES };
}

const BOGO = createBogoMath();

// Engine checks (Node 18+, no dependencies). Run from the repository root:
//   node tests/engine.test.mjs
// Black-box tests through the same JS glue the app uses (js/common.js, js/engine-data.js).
// Exit code is non-zero on any failure. Never loosen a threshold to make a change pass.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const load = (file, name) => new Function(readFileSync(file, 'utf8') + `\nreturn ${name};`)();
const BOGO = load('js/common.js', 'BOGO');
const DATA = load('js/engine-data.js', 'BogoEngineData');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failed++; };

async function engine(kind) {
  let seed;
  const bytes = Buffer.from(DATA[kind], 'base64');
  const { instance } = await WebAssembly.instantiate(bytes, { env: { refill() { crypto.getRandomValues(seed); } } });
  const ex = instance.exports;
  seed = new Uint32Array(ex.memory.buffer, ex.ptr_seed(), 11);
  return ex;
}
const trials = ex => BigInt.asUintN(64, ex.get_trials());
function search(ex, c, cap) {            // one search from a fresh setup; returns {d, t} or null
  BOGO.setup(ex, c);
  let done = 0;
  while (done < cap) {
    done += ex.run(Math.min(1 << 16, cap - done));
    const len = ex.get_found();
    if (len) return { d: BOGO.read(ex, ex.ptr_divisor(), len), t: trials(ex) };
  }
  return null;
}

for (const kind of ['simd', 'scalar']) {
  console.log(`\n[${kind}]`);
  const ex = await engine(kind);

  // 1. Every reported divisor is a real, non-trivial divisor no larger than floor(sqrt(N)).
  const composites = [10403n, 30030n, 2n * 1000000007n, 3n * 1000000007n, 17n * 1000000007n, 19n * 1000000007n,
    1000003n * 1000033n, 10000019n * 10000079n, 7n ** 11n, 2n ** 40n, 101n * 103n * 107n];
  // Each N above has an expected waiting time far below the cap (C / divisor candidates <= 2e6).
  let good = true;
  for (const n of composites) {
    const c = BOGO.config(n), r = search(ex, c, 50_000_000);
    const ok = r && r.d > 1n && r.d < n && n % r.d === 0n && r.d <= c.root;
    if (!ok) { good = false; console.log('    bad result for', String(n), r && String(r.d)); }
  }
  check(good, `divisors verified for ${composites.length} composites`);

  // 2. A prime is never "factored".
  check(search(ex, BOGO.config(1000000007n), 2_000_000) === null, 'prime 1000000007: no divisor in 2,000,000 trials');

  // 3. Trial counting is exact: run(k) adds exactly k when nothing is found.
  {
    const c = BOGO.config(BigInt('2519590847565789349402718324004839857142928212620403202777713783604366202070759555626401852588078440691829064124951508218929855914917618450280848912007284499268739280728777673597141834727026189637501497182469116507761337985909570009733045974880842840179742910064245869181719511874612151517265463228221686998754918242243363725908514186546204357679842338718477444792073993423658482382428119816381501067481045166037730605620161967625613384414360383390441495263443219011465754445417842402092461651572335077870774981712577246796292638635637328991215483143816789988504044536402352738195137863656439121201039712282120720357'));
    BOGO.setup(ex, c);
    let expect = 0n, ok = true;
    for (let i = 0; i < 200; i++) {
      const k = 1 + Math.floor(Math.random() * 5000);
      const got = ex.run(k); expect += BigInt(k);
      if (got !== k || trials(ex) !== expect || ex.get_found()) { ok = false; break; }
    }
    check(ok, `RSA-2048: 200 run(k) calls, trial counter exact (${expect} trials)`);
  }

  // 4. Uniform draw: for N = 2*3*5*7*11*13 the first divisor hit is uniform over the six primes.
  {
    const c = BOGO.config(30030n), hits = new Map(), runs = 12000;
    for (let i = 0; i < runs; i++) { const r = search(ex, c, 1_000_000); hits.set(String(r.d), (hits.get(String(r.d)) || 0) + 1); }
    const keys = ['2', '3', '5', '7', '11', '13'], e = runs / 6;
    const chi = keys.reduce((s, k) => s + ((hits.get(k) || 0) - e) ** 2 / e, 0);
    const extra = [...hits.keys()].filter(k => !keys.includes(k));
    check(chi < 20.5 && extra.length === 0, `first hit uniform over 6 divisors: chi2=${chi.toFixed(2)} (<20.5, df=5), unexpected=${extra}`);
  }

  // 5. Geometric waiting time: N = 101*103 has exactly one divisor among C candidates, mean trials = C.
  {
    const c = BOGO.config(10403n), C = Number(c.count), runs = 20000;
    let sum = 0;
    for (let i = 0; i < runs; i++) sum += Number(search(ex, c, 1_000_000).t);
    const mean = sum / runs;
    check(Math.abs(mean - C) / C < 0.04, `mean trials to hit ${mean.toFixed(2)} vs candidates C=${C} (within 4%)`);
  }
}
console.log(failed ? `\n${failed} failed check(s)` : '\nall engine checks passed');
process.exit(failed ? 1 : 0);

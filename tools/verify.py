#!/usr/bin/env python3
"""Browser checks for bogo factor (Playwright, Chromium).

Run from the repository root:
    pip install playwright && python -m playwright install chromium
    python tools/verify.py            # all checks
    python tools/verify.py hit perf   # selected groups

Groups: shots, hit, hidden, chart, stars, mobile, rims, bgm, share, lanes, reels, input, layout, perf.
Screenshots go to verify-out/ (add it to .gitignore). Exit code is non-zero if any check fails.
The checks rely on element ids and window.bogoDiagnostics; update the
selectors here if the markup changes, never weaken a threshold to pass.
"""
import asyncio, http.server, json, os, socket, sys, threading
from functools import partial
from playwright.async_api import async_playwright

ROOT = os.getcwd()
OUT = os.path.join(ROOT, 'verify-out')
SEMI = str(10000019 * 10000079)          # found within a second or two
SIZES = {'1920': (1920, 1080), '1440': (1440, 900), '1280': (1280, 720)}
PHONE = (390, 844)
FAILS = []

def check(ok, message):
    print(('  ok   ' if ok else '  FAIL ') + message)
    if not ok: FAILS.append(message)

def serve():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    handler = partial(Quiet, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{port}/'

async def open_page(browser, url, size=(1440, 900), phone=False, scheme='dark', cores=8, reduce=False, init=None):
    ctx = await browser.new_context(viewport={'width': size[0], 'height': size[1]}, color_scheme=scheme,
                                    is_mobile=phone, has_touch=phone, reduced_motion='reduce' if reduce else 'no-preference')
    await ctx.add_init_script(f"Object.defineProperty(navigator,'hardwareConcurrency',{{get:()=>{cores}}})")
    if init: await ctx.add_init_script(init)
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.audio_requests = []
    page.on('request', lambda r: '/assets/audio/' in r.url and page.audio_requests.append(r.url))
    await page.goto(url)
    await page.wait_for_function("window.bogoDiagnostics && bogoDiagnostics.status==='idle'", timeout=20000)
    await page.wait_for_timeout(1700)          # opening sequence
    return page

async def status(page, states, timeout=120000):
    await page.wait_for_function('(s)=>s.includes(bogoDiagnostics.status)', arg=states, timeout=timeout)

async def press(page, phone, desktop_id, phone_id=None):
    sel = '#' + (phone_id if phone and phone_id else desktop_id)
    await (page.tap(sel) if phone else page.click(sel))

# Headless Chromium never hides a tab, so visibility is simulated. As in a real hidden
# tab, animation frames are held while hidden and run when the tab shows again.
HIDE = """(h)=>{ window.__hidden=h; if(!window.__patched){ window.__patched=true;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__hidden?'hidden':'visible'});
  const raf=window.requestAnimationFrame.bind(window), caf=window.cancelAnimationFrame.bind(window), held=new Map(); let next=-1;
  window.requestAnimationFrame=cb=>{ if(!window.__hidden) return raf(cb); const id=next--; held.set(id,cb); return id; };
  window.cancelAnimationFrame=id=>{ if(!held.delete(id)) caf(id); };
  window.__release=()=>{ const cbs=[...held.values()]; held.clear(); for(const cb of cbs) raf(cb); }; }
  document.dispatchEvent(new Event('visibilitychange')); if(!h) window.__release(); }"""

# Hit marker: present, fully inside the panel, and green pixels at the marker and the line midpoint.
HIT = """(()=>{ const d=bogoDiagnostics.visuals.sampleField, g=d.geometry, h=d.hit, L=d.link;
  if(!h) return {hit:false};
  const c=document.getElementById('reactor'), x=c.getContext('2d'), k=c.width/c.getBoundingClientRect().width;
  const t=document.createElement('canvas').getContext('2d'); t.fillStyle=getComputedStyle(document.body).getPropertyValue('--success').trim(); t.fillRect(0,0,1,1);
  const [r,gr,b]=t.getImageData(0,0,1,1).data;
  const green=(px,py)=>{ for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ const p=x.getImageData(Math.round((px+dx)*k),Math.round((py+dy)*k),1,1).data;
    if(p[3]>40 && Math.abs(p[0]-r)+Math.abs(p[1]-gr)+Math.abs(p[2]-b)<90) return true; } return false; };
  return {hit:true, inside:h.x-6>=0&&h.y-6>=0&&h.x+6<=g.width&&h.y+6<=g.height, marker:green(h.x,h.y),
          line: !!L && green((h.x+L.x)/2,(h.y+L.y)/2), at:[Math.round(h.x),Math.round(h.y)], panel:[Math.round(g.width),Math.round(g.height)]}; })()"""

async def group_hit(browser, url):
    print('\n[hit] found divisor marker and line')
    cases = [('semiprime', SEMI, {}), ('factor 2', str(2 * 1000000007), {}), ('factor 3', str(3 * 1000000007), {}),
             ('factor 17', str(17 * 1000000007), {}), ('FX off', SEMI, {'fx_off': True}), ('reduced motion', SEMI, {'reduce': True}),
             ('light', SEMI, {'scheme': 'light'}), ('phone', SEMI, {'phone': True}), ('resize after found', SEMI, {'resize': True}),
             ('found while hidden', SEMI, {'hidden': True})]
    for name, n, o in cases:
        page = await open_page(browser, url, PHONE if o.get('phone') else (1440, 900), o.get('phone', False),
                               o.get('scheme', 'dark'), reduce=o.get('reduce', False))
        if o.get('fx_off'): await page.click('#fx-toggle')
        await page.fill('#n-input', n)
        if o.get('hidden'): await page.evaluate(HIDE, True)
        await press(page, o.get('phone'), 'start')
        await status(page, ['found'], 300000)
        if o.get('hidden'):
            await page.wait_for_timeout(300); await page.evaluate(HIDE, False)
        if o.get('resize'):
            await page.set_viewport_size({'width': 1280, 'height': 720})
        await page.wait_for_timeout(900)
        r = await page.evaluate(HIT)
        check(r.get('hit') and r['inside'] and r['marker'] and r['line'], f'{name}: {json.dumps(r)}')
        await page.context.close()

async def group_hidden(browser, url):
    print('\n[hidden] background samples keep being recorded while the tab is hidden')
    page = await open_page(browser, url)
    await page.select_option('#preset', 'rsa2048'); await page.click('#start'); await page.wait_for_timeout(5000)
    get = "bogoDiagnostics.visuals.sampleField.acceptedSamples"
    a = await page.evaluate(get); await page.wait_for_timeout(5000); b = await page.evaluate(get)
    rate = (b - a) / 5
    await page.evaluate(HIDE, True); await page.wait_for_timeout(10000); await page.evaluate(HIDE, False)
    await page.wait_for_timeout(1500); c = await page.evaluate(get)
    gained = c - b
    check(abs(gained - rate * 11.5) <= rate * 11.5 * 0.15, f'visible rate {rate:.1f}/s; hidden 10 s + 1.5 s gained {gained} (expected ≈{rate*11.5:.0f})')
    await page.context.close()

# Throughput chart: one reading of the recent rate per 0.5 s of search time, recorded as
# worker reports arrive. A hidden tab draws no frames, yet its time is on the chart after.
async def group_chart(browser, url):
    print('\n[chart] the throughput history keeps its clock while the tab is hidden')
    page = await open_page(browser, url)
    await page.select_option('#preset', 'rsa2048'); await page.select_option('#workers', '2'); await page.click('#start')
    await page.wait_for_timeout(6000)
    get = "[bogoDiagnostics.visuals.historyTotal, bogoDiagnostics.lastSnapshot.elapsedMs]"
    a = await page.evaluate(get)
    await page.evaluate(HIDE, True); await page.wait_for_timeout(15000)
    frozen = await page.evaluate(get)
    await page.evaluate(HIDE, False); await page.wait_for_timeout(700)
    b = await page.evaluate(get)
    gained, expected = b[0] - a[0], (b[1] - a[1]) / 500
    check(frozen[0] == a[0] and abs(gained - expected) <= 2,
          f'hidden 15 s: no frames while hidden ({a[0]} -> {frozen[0]}), then {gained} readings for {(b[1] - a[1]) / 1000:.1f} s of search (expected ≈{expected:.0f})')
    check(abs(b[0] - b[1] // 500) <= 2, f'readings match search time: {b[0]} readings, elapsed {b[1] / 1000:.1f} s')
    await page.context.close()

# Background stars (5-2): brightness tiers follow q = min(N mod d, d - N mod d) / d, which is
# uniform on [0, 0.5]; snapshots carry (v, u, q) numbers only, never divisor strings.
FIELD = """(()=>{ const w=(bogoDiagnostics.lastSnapshot||{}).workers||[]; return w.map(x=>{ const f=x.fieldSamples;
  const typed=Object.prototype.toString.call(f)==='[object Float64Array]', a=Array.from(f||[]);
  return {typed, n:a.length, strings:a.filter(y=>typeof y!=='number').length, bad:a.filter((y,i)=>!Number.isFinite(y)||(i%3===2?Math.abs(y)>.5:(y<0||y>1))).length}; }); })()"""

async def group_stars(browser, url):
    print('\n[stars] brightness tiers from real residues; numeric samples only')
    page = await open_page(browser, url)
    await page.select_option('#preset', 'rsa2048'); await page.click('#start')
    batches = []
    for _ in range(40):
        await page.wait_for_timeout(300); batches += await page.evaluate(FIELD)
    d = await page.evaluate('bogoDiagnostics.visuals.sampleField')
    n, t = sum(d['tiers']), d['tiers']
    expect = [n * .015, n * .11, n * .875]
    chi = sum((o - e) ** 2 / e for o, e in zip(t, expect))
    check(n >= 1000 and chi < 13.82, f'tiers {t} of {n} (expected ≈ 1.5 %, 11 %, 87.5 %): chi2={chi:.2f} (< 13.82, df=2)')
    below, above = d['brightSides']['below'], d['brightSides']['above']
    check(abs(below - above) <= 3.3 * (below + above) ** .5, f'bright stars by side: below {below}, above {above} (balanced within 3.3 sigma)')
    filled = [b for b in batches if b['n']]
    check(bool(filled) and all(b['typed'] and b['n'] % 3 == 0 and not b['strings'] and not b['bad'] for b in batches),
          f'fieldSamples are Float64Array (v, u, q) triples: {len(filled)} non-empty batches, {sum(b["n"] for b in filled) // 3} samples, no strings')
    check(d['visiblePoints'] <= 20000, f'at most 20000 points shown: {d["visiblePoints"]} (layers {d["layers"]})')
    await page.context.close()

# Phones (5-3): coverage moves to the LIVE tab's fixed 116px slot while a search is active.
SLOT = """(()=>{ const o=document.getElementById('output-panel'), c=document.querySelector('.coverage'), r=document.getElementById('result-coverage');
  return {state:bogoDiagnostics.status, slot:Math.round(o.getBoundingClientRect().height), inTarget:document.getElementById('form').contains(c),
    inSlot:o.contains(c), shown:c.getBoundingClientRect().height>0, body:document.querySelector('.output-body').getBoundingClientRect().height>0,
    final:r.hidden?null:r.textContent}; })()"""
# The two views slide side by side; TARGET holds TELEMETRY and never scrolls; the actions stay put.
PAGER = """(()=>{ const ws=document.getElementById('workspace'), f=id=>{const e=document.getElementById(id); return [e.scrollHeight, e.clientHeight]};
  const c=document.getElementById('reactor');
  return {view:bogoDiagnostics.view, scroll:Math.round(ws.scrollLeft), max:ws.scrollWidth-ws.clientWidth, target:f('pane-input'), live:f('pane-live'),
    start:Math.round(document.getElementById('start').getBoundingClientRect().y), telemetry:!!document.querySelector('.payload .telemetry-body'),
    slide:+getComputedStyle(document.getElementById('dock-track')).getPropertyValue('--slide'),
    canvas:[c.width, c.height], redraws:bogoDiagnostics.visuals.sampleField.redraws}; })()"""

SIDEWAYS = """(()=>{ const pane=document.getElementById('pane-live'), core=pane.querySelector('.core').getBoundingClientRect();
  const right=s=>{const r=document.querySelector(s).getBoundingClientRect(); return r.width>0 && r.left>=core.right-1};
  return {live:[pane.scrollHeight, pane.clientHeight], coreHeight:Math.round(core.height),
    beside: right('#live-readout') && right('#trial-count') && right('#output-panel') && right('#mobile-main')}; })()"""

async def drag(page, cdp, x0, x1, y=450, release=True):
    touch = lambda kind, x: cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
    await touch('touchStart', x0)
    for k in range(1, 13): await touch('touchMove', x0 + (x1 - x0) * k / 12); await page.wait_for_timeout(16)
    if release: await touch('touchEnd', x1)

async def group_mobile(browser, url):
    print('\n[mobile] swipeable views that fit, upright and on the side; coverage in the 116px LIVE slot during a search')
    for size in [PHONE, (390, 664)]:
        page = await open_page(browser, url, size, True)
        tag = f'{size[0]}x{size[1]}'
        ys = set()
        for preset in ['long19', 'rsa1024', 'rsa2048']:
            await page.select_option('#preset', preset); await page.wait_for_timeout(250)
            r = await page.evaluate(PAGER); ys.add(r['start'])
            check(r['target'][0] <= r['target'][1] and r['telemetry'], f'{tag} {preset}: TARGET fits without scrolling, TELEMETRY inside {json.dumps({k: r[k] for k in ("target", "telemetry")})}')
        check(len(ys) == 1, f'{tag}: INITIATE stays at y {sorted(ys)}')
        await page.tap('#start'); await page.wait_for_timeout(2500)
        r = await page.evaluate(PAGER)
        check(r['view'] == 'live' and r['live'][0] <= r['live'][1], f'{tag} running: LIVE fits without scrolling {json.dumps({k: r[k] for k in ("view", "live")})}')
        await page.context.close()
    # On its side: the core takes the full height; the count, result and actions stand beside it.
    for size in [(844, 390), (667, 375)]:
        page = await open_page(browser, url, size, True)
        tag = f'{size[0]}x{size[1]}'
        for preset in ['long19', 'rsa2048']:
            await page.select_option('#preset', preset); await page.wait_for_timeout(250)
            r = await page.evaluate(PAGER)
            check(r['target'][0] <= r['target'][1], f'{tag} {preset}: TARGET fits without scrolling {json.dumps(r["target"])}')
        await page.tap('#start'); await page.wait_for_timeout(2500)
        r = await page.evaluate(SIDEWAYS)
        check(r['live'][0] <= r['live'][1] and r['coreHeight'] >= r['live'][1] - 4 and r['beside'],
              f'{tag} running: core takes the full height, the rest beside it {json.dumps(r)}')
        check(not page.errors, f'{tag}: no page errors {page.errors[:2]}')
        await page.context.close()
    page = await open_page(browser, url, PHONE, True)
    cdp = await page.context.new_cdp_session(page)
    r = await page.evaluate(SLOT)
    check(not r['inTarget'] and r['inSlot'], f'idle: coverage not in TARGET {json.dumps(r)}')
    await drag(page, cdp, 330, 60); await page.wait_for_timeout(600)
    r = await page.evaluate(PAGER)
    check(r['scroll'] == 0 and r['view'] == 'input', f'before the first search a swipe stays on TARGET {json.dumps({k: r[k] for k in ("scroll", "view")})}')
    await page.select_option('#preset', 'rsa2048'); await page.tap('#start'); await page.wait_for_timeout(2500)
    for name in ['running', 'paused']:
        if name == 'paused': await page.tap('#mobile-main'); await status(page, ['paused'])
        r = await page.evaluate(SLOT)
        check(r['slot'] == 116 and r['shown'] and not r['body'] and not r['inTarget'], f'{name}: coverage in the slot {json.dumps(r)}')
    await page.tap('#mobile-main'); await status(page, ['running']); await page.wait_for_timeout(500)
    a = await page.evaluate(PAGER)
    await drag(page, cdp, 80, 80 + 390 * .4, release=False); await page.wait_for_timeout(50)
    m = await page.evaluate(PAGER)
    check(0 < m['scroll'] < m['max'] and abs(m['slide'] - m['scroll'] / m['max']) < .01,
          f'mid-swipe: views, tab thumb and actions move together (scroll {m["scroll"]}/{m["max"]}, slide {m["slide"]:.3f})')
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); await page.wait_for_timeout(700)
    await drag(page, cdp, 60, 330); await page.wait_for_timeout(700)
    b = await page.evaluate(PAGER)
    await drag(page, cdp, 330, 60); await page.wait_for_timeout(700)
    c = await page.evaluate(PAGER)
    check(b['view'] == 'input' and b['scroll'] == 0 and c['view'] == 'live' and c['scroll'] == c['max'], f'swipes switch views: right -> {b["view"]}, left -> {c["view"]}')
    check(a['canvas'] == b['canvas'] == c['canvas'] and a['redraws'] == c['redraws'],
          f'switching never resizes the core or redraws its stars: canvas {a["canvas"]} -> {c["canvas"]}, redraws {a["redraws"]} -> {c["redraws"]}')
    await page.tap('#mobile-stop'); await status(page, ['stopped'])
    r = await page.evaluate(SLOT)
    check(r['slot'] == 116 and not r['shown'] and r['body'] and (r['final'] or '').startswith('COVERAGE '), f'stopped: result with final coverage {json.dumps(r)}')
    await page.tap('#mobile-new'); await page.wait_for_timeout(700)
    await page.fill('#n-input', SEMI); await page.tap('#start'); await status(page, ['found']); await page.wait_for_timeout(500)
    r = await page.evaluate(SLOT)
    check(r['slot'] == 116 and r['body'] and (r['final'] or '').startswith('COVERAGE '), f'found: result with final coverage {json.dumps(r)}')
    check(not page.errors, f'phone: no page errors {page.errors[:2]}')
    await page.context.close()

# Border light (5-4): one lap on the core at a search start, one green lap on the result
# when found, nothing on TELEMETRY, and no continuous orbit.
RIMS = "bogoDiagnostics.visuals.rims"

async def group_rims(browser, url):
    print('\n[rims] one-shot traces only; nothing orbits')
    page = await open_page(browser, url)
    d0 = await page.evaluate(RIMS)
    check(not any('throughput' in p for p in d0['panels']), f'traced panels exclude TELEMETRY: {d0["panels"]}')
    await page.select_option('#preset', 'rsa2048'); await page.click('#start')
    await page.wait_for_function(f'{RIMS}.active>0', timeout=3000)
    await page.wait_for_timeout(1500); a = await page.evaluate(RIMS)
    await page.wait_for_timeout(2000); b = await page.evaluate(RIMS)
    check(a['active'] == 0 and a['visibleStrips'] == 0 and a['completed'] == 1 and b['stripPaints'] == a['stripPaints'],
          f'core lap ends and nothing repaints while running: {a["stripPaints"]} -> {b["stripPaints"]} paints, completed {a["completed"]}')
    await page.click('#stop'); await status(page, ['stopped'])
    await page.fill('#n-input', SEMI); await page.click('#start'); await status(page, ['found'])
    await page.wait_for_timeout(1800); c = await page.evaluate(RIMS)
    laps = dict(zip(c['panels'], c['laps']))
    check(laps.get('output-panel') == 1 and c['active'] == 0 and c['visibleStrips'] == 0,
          f'one green lap on the result when found, then idle: laps {laps}, active {c["active"]}')
    await page.context.close()
    page = await open_page(browser, url)
    await page.click('#fx-toggle'); await page.select_option('#preset', 'rsa2048'); await page.click('#start'); await page.wait_for_timeout(1000)
    d = await page.evaluate(RIMS)
    check(d['traces'] == 0 and d['visibleStrips'] == 0, f'FX OFF: no trace {json.dumps({k: d[k] for k in ("traces", "visibleStrips")})}')
    await page.context.close()

# Soundtrack (5-5): fetched during the opening, not when the connection asks to save data;
# decoding waits for intent.
async def group_bgm(browser, url):
    print('\n[bgm] preload during the opening; none with saveData')
    page = await open_page(browser, url)
    m = await page.evaluate('bogoDiagnostics.visuals.music')
    check(len(page.audio_requests) == 1 and m['preload'] in ('loading', 'loaded') and not m['decoded'],
          f'preload started, not decoded before intent: requests {len(page.audio_requests)}, preload {m["preload"]}, decoded {m["decoded"]}')
    await page.hover('#sound-toggle')
    await page.wait_for_function('bogoDiagnostics.visuals.music.decoded', timeout=15000)
    check(True, 'hover decodes the preloaded bytes')
    await page.context.close()
    page = await open_page(browser, url, init="Object.defineProperty(navigator,'connection',{get:()=>({saveData:true,effectiveType:'4g'})})")
    await page.wait_for_timeout(1500)
    m = await page.evaluate('bogoDiagnostics.visuals.music')
    check(not page.audio_requests and m['preload'].startswith('skipped'), f'saveData: no preload (requests {len(page.audio_requests)}, preload {m["preload"]})')
    await page.context.close()

# Sharing: the text is a complete, post-sized summary (X counts a link as 23; limit 280).
POST = """(()=>{ const q='1'+'0'.repeat(1998)+'7', long=BogoCard.post(BogoCard.model({status:'found', n:String(3n*BigInt(q)),
  factor:{d:'3', q}, trials:'18446744073709551615', elapsedMs:123456789}));
  const found=BogoCard.post(BogoCard.model(bogoDiagnostics.lastSnapshot));
  return {found, foundWeight:BogoCard.weight(found), long, longWeight:BogoCard.weight(long)}; })()"""

async def group_share(browser, url):
    print('\n[share] shared text carries the result and fits a post')
    page = await open_page(browser, url)
    await page.context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=url.rstrip('/'))
    await page.fill('#n-input', SEMI); await page.click('#start'); await status(page, ['found'])
    r = await page.evaluate(POST)
    check(r['foundWeight'] <= 280 and '10000019 × 10000079' in r['found'] and 'trials' in r['found'] and r['found'].endswith('https://i-komae.github.io/bogofactor/'),
          f'found: {r["foundWeight"]} / 280 {json.dumps(r["found"], ensure_ascii=False)}')
    check(r['longWeight'] <= 280 and '(2,000 digits)' in r['long'], f'2000-digit result abridged: {r["longWeight"]} / 280 {json.dumps(r["long"], ensure_ascii=False)}')
    await page.click('#copy'); await page.wait_for_function("!document.getElementById('share-copy-text').disabled")
    await page.click('#share-copy-text'); await page.wait_for_timeout(300)
    copied = await page.evaluate('navigator.clipboard.readText()')
    check(copied == r['found'], f'COPY TEXT copies the post: {json.dumps(copied, ensure_ascii=False)}')
    await page.context.close()

LANES = """(()=>{ const lanes=[...document.querySelectorAll('#worker-lanes .worker-lane')], box=document.getElementById('worker-lanes').getBoundingClientRect();
  const visible=lanes.filter(l=>{const r=l.getBoundingClientRect(); return r.height>0&&r.top>=box.top-1&&r.bottom<=box.bottom+1;}).length;
  const reading=lanes.filter(l=>{const o=l.querySelector('output'); return o&&o.getBoundingClientRect().width>0;}).length;
  const log=document.getElementById('event-log'), row=log.querySelector('.event'); const rh=row?row.getBoundingClientRect().height:17;
  return {lanes:lanes.length, visible, reading, logRows:Math.floor(log.getBoundingClientRect().height/rh)}; })()"""

async def group_lanes(browser, url):
    print('\n[lanes] every worker visible with a reading; log keeps >= 6 rows')
    for label, size in SIZES.items():
        page = await open_page(browser, url, size, cores=32)
        for w in [1, 4, 8, 16, 17, 32]:
            await page.select_option('#workers', str(w)); await page.wait_for_timeout(250)
            r = await page.evaluate(LANES)
            check(r['visible'] == r['lanes'] == w and r['reading'] == w and r['logRows'] >= 6, f'{label} workers={w}: {json.dumps(r)}')
        await page.context.close()

async def group_reels(browser, url):
    print('\n[reels] rolling digits readable most of the time')
    page = await open_page(browser, url)
    await page.select_option('#preset', 'rsa2048'); await page.select_option('#workers', '8'); await page.click('#start'); await page.wait_for_timeout(4000)
    r = await page.evaluate("""(async()=>{let f=0,l=0,t=0;const s=performance.now();while(performance.now()-s<4000){await new Promise(r=>requestAnimationFrame(r));f++;
      const lanes=[...document.querySelectorAll('.worker-lane')];l+=lanes.filter(x=>x.querySelector('.is-rolling')).length/Math.max(1,lanes.length);
      if(document.querySelector('#rate .is-rolling'))t++;}return {lanes:l/f, rate:t/f};})()""")
    check(r['lanes'] <= .25 and r['rate'] <= .25, f"rolling share lanes {r['lanes']:.2f}, throughput {r['rate']:.2f} (<= 0.25)")
    await page.context.close()

async def group_input(browser, url):
    print('\n[input] controls never move; long N is never silently hidden')
    for label, size in SIZES.items():
        page = await open_page(browser, url, size)
        ys = set()
        for preset in ['long19', 'rsa1024', 'rsa2048']:
            await page.select_option('#preset', preset); await page.wait_for_timeout(300)
            ys.add(await page.evaluate("Math.round(document.getElementById('start').getBoundingClientRect().y)"))
            r = await page.evaluate("""(()=>{const i=document.getElementById('n-input'), f=i.closest('.input-frame')||i.parentElement;
              return {hiddenScroll: i.scrollHeight>i.clientHeight+1 && !f.classList.contains('abridged'), abridged:f.classList.contains('abridged')};})()""")
            check(not r['hiddenScroll'], f'{label} {preset}: all digits shown or abridged explicitly {json.dumps(r)}')
        check(len(ys) == 1, f'{label}: start button y constant across presets {sorted(ys)}')
        await page.context.close()

BOXES = """(()=>{const q=s=>{const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map(Math.round).join(',')};
  return {core:q('#core-view'), output:q('#output-panel'), start:q('#start'), log:q('#event-log')};})()"""

async def group_layout(browser, url):
    print('\n[layout] no geometry change between states')
    for label, size in SIZES.items():
        page = await open_page(browser, url, size)
        seen = {}
        async def snap(state): seen[state] = await page.evaluate(BOXES)
        await snap('idle')
        await page.select_option('#preset', 'rsa2048'); await page.select_option('#cap', '0'); await page.click('#start'); await page.wait_for_timeout(2500); await snap('running')
        await page.click('#start'); await status(page, ['paused']); await snap('paused')
        await page.click('#stop'); await status(page, ['stopped']); await snap('stopped')
        await page.select_option('#cap', '100000'); await page.click('#start'); await status(page, ['capped']); await snap('capped')
        await page.select_option('#cap', '0'); await page.fill('#n-input', SEMI); await page.click('#start'); await status(page, ['found']); await page.wait_for_timeout(800); await snap('found')
        await page.fill('#n-input', '1000000007'); await page.click('#start'); await status(page, ['prime']); await snap('prime')
        for key in ['core', 'output', 'log']:
            values = {s: v[key] for s, v in seen.items()}
            check(len(set(values.values())) == 1, f'{label} {key} stable: {json.dumps(values)}')
        check(not page.errors, f'{label}: no page errors {page.errors[:2]}')
        await page.context.close()

async def throughput(browser, url, fx):
    page = await open_page(browser, url, cores=2)
    if not fx: await page.click('#fx-toggle')
    await page.select_option('#preset', 'rsa2048'); await page.select_option('#workers', '1'); await page.click('#start'); await page.wait_for_timeout(1500)
    a = await page.evaluate("[performance.now(), +bogoDiagnostics.lastSnapshot.trials]"); await page.wait_for_timeout(6000)
    b = await page.evaluate("[performance.now(), +bogoDiagnostics.lastSnapshot.trials]")
    await page.context.close(); return (b[1] - a[1]) / ((b[0] - a[0]) / 1000)

async def group_perf(browser, url):
    print('\n[perf] FX FULL keeps at least half of FX OFF throughput (RSA-2048, 1 worker)')
    full = [await throughput(browser, url, True) for _ in range(2)]
    off = [await throughput(browser, url, False) for _ in range(2)]
    ratio = (sum(full) / 2) / (sum(off) / 2)
    check(ratio >= .5, f'FULL {sum(full)/2:,.0f}/s, OFF {sum(off)/2:,.0f}/s, ratio {ratio:.2f} (>= 0.50)')

async def group_shots(browser, url):
    print('\n[shots] screenshots for review in verify-out/')
    os.makedirs(OUT, exist_ok=True)
    for label, size in list(SIZES.items()) + [('390', PHONE)]:
        phone = label == '390'
        for scheme in ['dark', 'light']:
            page = await open_page(browser, url, size, phone, scheme)
            base = os.path.join(OUT, f'{label}-{scheme}')
            await page.screenshot(path=base + '-idle.png')
            await page.select_option('#preset', 'rsa2048'); await press(page, phone, 'start'); await page.wait_for_timeout(4000)
            await page.screenshot(path=base + '-running.png')
            await press(page, phone, 'stop', 'mobile-stop'); await status(page, ['stopped'])
            if phone: await page.tap('#mobile-new'); await page.wait_for_timeout(400)
            await page.fill('#n-input', SEMI); await press(page, phone, 'start'); await status(page, ['found']); await page.wait_for_timeout(1500)
            await page.screenshot(path=base + '-found.png')
            await page.context.close()
    print(f'  saved to {OUT}')

GROUPS = {'shots': group_shots, 'hit': group_hit, 'hidden': group_hidden, 'chart': group_chart, 'stars': group_stars, 'mobile': group_mobile,
          'rims': group_rims, 'bgm': group_bgm, 'share': group_share, 'lanes': group_lanes, 'reels': group_reels, 'input': group_input,
          'layout': group_layout, 'perf': group_perf}

async def main():
    wanted = sys.argv[1:] or list(GROUPS)
    url = serve()
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for name in wanted:
            try: await GROUPS[name](browser, url)
            except Exception as e: check(False, f'{name}: {type(e).__name__}: {e}')
        await browser.close()
    print(f'\n{len(FAILS)} failed check(s)' if FAILS else '\nall browser checks passed')
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    asyncio.run(main())

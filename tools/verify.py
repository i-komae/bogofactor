#!/usr/bin/env python3
"""Browser checks for bogo factor (Playwright, Chromium).

Run from the repository root:
    pip install playwright && python -m playwright install chromium
    python tools/verify.py            # all checks
    python tools/verify.py hit perf   # selected groups

Groups: shots, hit, hidden, lanes, reels, input, layout, perf.
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

async def open_page(browser, url, size=(1440, 900), phone=False, scheme='dark', cores=8, reduce=False):
    ctx = await browser.new_context(viewport={'width': size[0], 'height': size[1]}, color_scheme=scheme,
                                    is_mobile=phone, has_touch=phone, reduced_motion='reduce' if reduce else 'no-preference')
    await ctx.add_init_script(f"Object.defineProperty(navigator,'hardwareConcurrency',{{get:()=>{cores}}})")
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    await page.goto(url)
    await page.wait_for_function("window.bogoDiagnostics && bogoDiagnostics.status==='idle'", timeout=20000)
    await page.wait_for_timeout(1700)          # opening sequence
    return page

async def status(page, states, timeout=120000):
    await page.wait_for_function('(s)=>s.includes(bogoDiagnostics.status)', arg=states, timeout=timeout)

async def press(page, phone, desktop_id, phone_id=None):
    sel = '#' + (phone_id if phone and phone_id else desktop_id)
    await (page.tap(sel) if phone else page.click(sel))

# Headless Chromium never hides a tab, so visibility is simulated.
# requestAnimationFrame keeps running here, unlike a real hidden tab.
HIDE = """(h)=>{ window.__hidden=h; if(!window.__patched){ window.__patched=true;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__hidden?'hidden':'visible'}); }
  document.dispatchEvent(new Event('visibilitychange')); }"""

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

GROUPS = {'shots': group_shots, 'hit': group_hit, 'hidden': group_hidden, 'lanes': group_lanes,
          'reels': group_reels, 'input': group_input, 'layout': group_layout, 'perf': group_perf}

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

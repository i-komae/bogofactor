'use strict';
/** Result-only export. Immutable verified arithmetic is separate from drawing.
 * Every digit is laid out explicitly; neither CSS screenshots nor remote assets
 * are involved. This keeps image export origin-clean and deterministic. */
const BogoCard = (() => {
  const URL = 'https://i-komae.github.io/bogofactor/';
  const DISPLAY_URL = 'i-komae.github.io/bogofactor';
  const W = 1440, M = 64, INNER = W - 2 * M;
  const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
  const SANS = "'Helvetica Neue', Arial, sans-serif";
  const nf = new Intl.NumberFormat('en-US');

  function resolveName(n, presets = PRESETS) {
    const canonical = String(BigInt(n));
    const found = presets.find(p => p.group === 'RSA challenges' && p.n === canonical);
    return found ? found.label.match(/^RSA-\d+/)?.[0] || null : null;
  }
  function model(snapshot) {
    if (!snapshot || snapshot.status !== 'found' || !snapshot.factor) throw Error('No completed factorization to share.');
    const integer = value => {
      if (!/^\d{1,2000}$/.test(String(value))) throw Error('Invalid result integer.');
      return BigInt(value);
    };
    const n = integer(snapshot.n), d = integer(snapshot.factor.d), q = integer(snapshot.factor.q);
    if (d <= 1n || q <= 1n || d >= n || q >= n || d * q !== n) throw Error('The result could not be verified.');
    if (!/^\d{1,20}$/.test(String(snapshot.trials))) throw Error('Invalid trial count.');
    const trials = BigInt(snapshot.trials);
    if (trials < 1n || trials > (1n << 64n) - 1n) throw Error('Invalid trial count.');
    const ms = Number(snapshot.elapsedMs);
    if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) throw Error('Invalid elapsed time.');
    return Object.freeze({ n: String(n), d: String(d), q: String(q), trials: String(trials),
      elapsedMs: ms, name: resolveName(n), digits: String(n).length,
      workers: Array.isArray(snapshot.workers) ? snapshot.workers.length : 0 });
  }
  function text(result) {
    const expression = `${result.name || result.n} = ${result.d} × ${result.q}`;
    return `BOGO / FACTOR\n${expression}\n` + (result.name ? `N = ${result.n}\n` : '') +
      `Trials: ${result.trials}\nElapsed: ${BogoNumbers.seconds(result.elapsedMs, 6)} s\n${URL}`;
  }
  function elapsed(ms) {
    const parts = BogoNumbers.seconds(ms, 3).split('.');
    return BogoNumbers.group(parts[0]) + '.' + parts[1] + ' s';
  }
  function colors() {
    const s = getComputedStyle(document.body);
    const get = name => s.getPropertyValue('--' + name).trim();
    return { page: get('page'), panel: get('panel'), alt: get('panel-alt'), ink: get('ink'),
      accent: get('accent'), muted: get('muted'), line: get('line'), fine: get('fine'), success: get('success') };
  }
  function font(ctx, size, weight = 400, family = MONO) { ctx.font = `${weight} ${size}px ${family}`; }
  function fit(ctx, str, max, ceiling, floor = 26, family = MONO) {
    let size = ceiling; font(ctx, size, 400, family);
    while (ctx.measureText(str).width > max && size > floor) { size--; font(ctx, size, 400, family); }
    return size;
  }
  function wrap(ctx, str, max, size) {
    font(ctx, size);
    const lines = [];
    let line = '';
    for (const ch of str) {
      if (line && ctx.measureText(line + ch).width > max) { lines.push(line); line = ''; }
      line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }
  function layout(ctx, result) {
    const textWidth = INNER - 100;
    const target = result.name || result.n;
    const targetSize = fit(ctx, target, textWidth, result.name ? 66 : 50, 28);
    const targetLines = wrap(ctx, target, textWidth, targetSize);
    const product = `${result.d}  ×  ${result.q}`;
    const productSize = fit(ctx, product, textWidth, 62, 36);
    font(ctx, productSize);
    const single = ctx.measureText(product).width <= textWidth;
    const factorSize = single ? productSize : Math.min(40, result.digits > 300 ? 28 : 36);
    const a = single ? [product] : wrap(ctx, result.d, textWidth, factorSize);
    const b = single ? [] : wrap(ctx, result.q, textWidth, factorSize);
    const lineHeight = size => size * 1.38;
    const targetHeight = targetLines.length * lineHeight(targetSize);
    const factorHeight = (a.length + b.length) * lineHeight(factorSize) + (single ? 0 : 58);
    const boxHeight = Math.max(298, 76 + targetHeight + 55 + factorHeight);
    const boxTop = 266, statTop = boxTop + boxHeight + 46;
    const height = Math.ceil(Math.max(900, statTop + 227) / 4) * 4;
    return { width: W, height, target, targetSize, targetLines, targetHeight, product,
      factorSize, single, a, b, boxHeight, boxTop, statTop, textWidth };
  }
  function paint(result, palette = colors()) {
    const canvas = document.createElement('canvas');
    let ctx = canvas.getContext('2d');
    if (!ctx) throw Error('Image rendering is unavailable.');
    const plan = layout(ctx, result);
    canvas.width = plan.width; canvas.height = plan.height;
    ctx = canvas.getContext('2d'); ctx.textBaseline = 'top';
    const P = palette, H = plan.height;
    ctx.fillStyle = P.page; ctx.fillRect(0, 0, W, H);
    // Restrained registration grid and panel geometry; no fake measurements.
    ctx.strokeStyle = P.fine; ctx.lineWidth = 1; ctx.globalAlpha = .32;
    for (let x = 24; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, H - 24); ctx.stroke(); }
    for (let y = 24; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(W - 24, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    const line = (x1, y1, x2, y2, color = P.line, width = 1) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    const corners = (x, y, w, h, color, length = 19) => {
      for (const [dx, dy, sx, sy] of [[0,0,1,1],[w,0,-1,1],[0,h,1,-1],[w,h,-1,-1]]) {
        line(x+dx, y+dy, x+dx+sx*length, y+dy, color, 2);
        line(x+dx, y+dy, x+dx, y+dy+sy*length, color, 2);
      }
    };
    ctx.strokeStyle = P.line; ctx.strokeRect(24.5, 24.5, W - 49, H - 49);
    corners(24, 24, W - 48, H - 48, P.accent, 24);
    // Brand and result status, matching the terminal rather than a browser screenshot.
    font(ctx, 28, 600, SANS); ctx.fillStyle = P.ink; ctx.fillText('BOGO', M, 61);
    const brandA = ctx.measureText('BOGO').width;
    ctx.fillStyle = P.accent; ctx.fillText('/', M + brandA + 15, 61);
    ctx.fillStyle = P.ink; ctx.fillText('FACTOR', M + brandA + 41, 61);
    font(ctx, 14); ctx.textAlign = 'right'; ctx.fillStyle = P.muted; ctx.fillText('RESULT / EXACT INTEGER', W - M, 69);
    ctx.textAlign = 'left'; line(M, 114, W-M, 114);
    font(ctx, 60, 500, SANS); ctx.fillStyle = P.ink; ctx.fillText('FACTOR LOCKED', M - 2, 149);
    font(ctx, 14); ctx.fillStyle = P.muted;
    ctx.fillText(`${result.digits}-DIGIT TARGET` + (result.workers ? `  /  ${result.workers} WORKER${result.workers === 1 ? '' : 'S'}` : ''), M, 224);
    ctx.fillStyle = P.success; ctx.textAlign = 'right'; ctx.fillText('PRODUCT VERIFIED', W - M, 224); ctx.textAlign = 'left';
    const y0 = plan.boxTop;
    ctx.fillStyle = P.panel; ctx.fillRect(M, y0, INNER, plan.boxHeight);
    ctx.strokeStyle = P.line; ctx.strokeRect(M + .5, y0 + .5, INNER - 1, plan.boxHeight - 1);
    corners(M, y0, INNER, plan.boxHeight, P.accent, 16);
    // Numeral layout stays exact even for maximum-length input and asymmetric factors.
    const contentH = plan.targetHeight + 55 + (plan.a.length + plan.b.length) * plan.factorSize * 1.38 + (plan.single ? 0 : 58);
    let y = y0 + (plan.boxHeight - contentH) / 2;
    const drawn = [];
    const centerLines = (rows, size, color) => {
      font(ctx, size); ctx.fillStyle = color; ctx.textAlign = 'center';
      for (const value of rows) {
        const width = ctx.measureText(value).width;
        ctx.fillText(value, W / 2, y);
        drawn.push({ text: value, x: W / 2 - width / 2, y, width, height: size * 1.38 });
        y += size * 1.38;
      }
    };
    centerLines(plan.targetLines, plan.targetSize, P.ink);
    y += 1; font(ctx, 32); ctx.fillStyle = P.muted; ctx.fillText('=', W/2, y); y += 54;
    centerLines(plan.a, plan.factorSize, P.accent);
    if (!plan.single) { font(ctx, 30); ctx.fillStyle = P.muted; ctx.fillText('×', W/2, y+3); y += 58; centerLines(plan.b, plan.factorSize, P.accent); }
    ctx.textAlign = 'left';
    // The numerical statistics are intentionally as prominent as the expression.
    const stats = plan.statTop;
    line(M, stats, W-M, stats); line(W/2, stats+20, W/2, stats+128);
    font(ctx, 14); ctx.fillStyle = P.muted; ctx.fillText('TRIALS EXECUTED', M, stats+21); ctx.fillText('ELAPSED', W/2+44, stats+21);
    const countText = nf.format(BigInt(result.trials)).replaceAll(',', '\u2009');
    const timeText = elapsed(result.elapsedMs);
    const leftSize = fit(ctx, countText, W/2-M-45, 54, 25);
    font(ctx, leftSize); ctx.fillStyle = P.ink; ctx.fillText(countText, M, stats+58);
    const rightSize = fit(ctx, timeText, W/2-M-44, 50, 25);
    font(ctx, rightSize); ctx.fillStyle = P.ink; ctx.fillText(timeText, W/2+44, stats+58);
    line(M, H-91, W-M, H-91);
    font(ctx, 17); ctx.fillStyle = P.accent; ctx.fillText(DISPLAY_URL, M, H-65);
    ctx.textAlign = 'right'; font(ctx, 13); ctx.fillStyle = P.muted; ctx.fillText('ONE HIT. CASE CLOSED.', W-M, H-62); ctx.textAlign = 'left';
    return { canvas, layout: Object.freeze({ ...plan, drawn, statsBottom: stats + 128, footerTop: H - 91 }) };
  }
  async function png(result, palette) {
    const rendered = paint(result, palette);
    const blob = await new Promise((resolve, reject) => rendered.canvas.toBlob(b => b ? resolve(b) : reject(Error('Could not encode the image.')), 'image/png'));
    return { ...rendered, blob };
  }
  return { URL, DISPLAY_URL, model, text, resolveName, paint, png, elapsed, colors };
})();

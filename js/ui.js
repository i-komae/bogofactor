'use strict';
(() => {
  const $ = id => document.getElementById(id);
  // A visual failure must never affect mathematical state or computation.
  function fx(method, ...args) {
    try { if (typeof BogoVisual !== 'undefined') BogoVisual[method]?.(...args); }
    catch (error) { console.warn('Visual layer:', error.message); }
  }
  const nf = new Intl.NumberFormat('en-US');
  // Native grouped picker keeps the examples in one compact control.
  const presetById = new Map(PRESETS.map(p => [p.id, p]));
  const presetByValue = new Map(PRESETS.map(p => [p.n, p.id]));
  const groups = new Map();
  for (const preset of PRESETS) {
    let group = groups.get(preset.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = preset.group;
      groups.set(preset.group, group);
      $('preset').append(group);
    }
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.id.startsWith('rsa') ? preset.label.split(' · ')[0] : preset.label;
    option.title = preset.label;
    group.append(option);
  }
  const activeStates = ['screening', 'running', 'pausing', 'paused', 'resuming', 'stopping'];
  const pendingStates = ['screening', 'pausing', 'resuming', 'stopping'];
  const labels = {
    boot: 'INITIALIZING', idle: 'STANDBY', screening: 'SCREENING', running: 'SAMPLING',
    pausing: 'PAUSING', paused: 'PAUSED', resuming: 'RESUMING', stopping: 'STOPPING',
    found: 'FACTOR FOUND', capped: 'LIMIT REACHED', stopped: 'STOPPED',
    prime: 'PRIME', probable: 'PROBABLE PRIME', error: 'ENGINE ERROR',
    interrupted: 'INTERRUPTED', 'counter-limit': 'COUNTER LIMIT'
  };
  let status = 'boot', worker = null, workerURL = null, initialized = false;
  let engineKind = null, runId = 0, last = null, fatal = false, unavailable = false;
  let watchdog = null, copyTimer = null, statusTimer = 0;
  const logical = Math.max(1, navigator.hardwareConcurrency || 2), maxWorkers = Math.min(32, logical);
  const defaultWorkers = Math.max(1, Math.min(4, Math.floor(logical / 2)));
  $('workers').add(new Option('AUTO / ' + defaultWorkers, String(defaultWorkers)));
  for (let i = 1; i <= maxWorkers; i++) $('workers').add(new Option(String(i).padStart(2,'0') + (i === 1 ? ' WORKER' : ' WORKERS'), String(i)));
  $('workers-hint').textContent = '/ ' + logical + ' LOGICAL';
  $('workers').value = String(defaultWorkers);
  fx('workers', defaultWorkers);
  $('workers').addEventListener('change', () => { if (!busy()) fx('workers', Number($('workers').value)); });
  const counter = new ExactCounter($('counter-reels'), $('exact-count'), $('trial-count'));
  counter.set(0n, true);
  const speedDisplay = new RollingMetric($('rate'), 1600, $('rate-unit'));
  const coverage = new CoveragePlot($('coverage-curve'), $('coverage-value'));
  let hasRun = false, view = 'input', requestedView = 'input';
  let viewAnimation = null, viewSequence = 0;
  const viewport = document.querySelector('.workspace');
  const mobileQuery = matchMedia('(max-width:760px), (pointer:coarse) and (max-height:590px)');
  const viewScroll = { input: 0, live: 0 };
  function commitView(next) {
    viewScroll[view] = viewport.scrollTop;
    view = next; document.body.dataset.view = next;
    $('view-input').setAttribute('aria-pressed', String(next === 'input'));
    $('view-live').setAttribute('aria-pressed', String(next === 'live'));
    const targetHidden = mobileQuery.matches && next !== 'input';
    $('form').inert = targetHidden;
    document.querySelector('.core').inert = mobileQuery.matches && next !== 'live';
    // Move focus only if it would be left inside the now hidden pane.
    const focus = document.activeElement;
    if ((targetHidden && $('form').contains(focus)) || (next === 'input' && document.querySelector('.core').contains(focus))) {
      $(next === 'input' ? 'view-input' : 'view-live').focus({ preventScroll: true });
    }
    viewport.scrollTop = viewScroll[next];
    requestAnimationFrame(resize);
  }
  async function switchView(next, animate = true) {
    if (next !== 'input' && next !== 'live') return;
    if (next === requestedView && !viewAnimation) return;
    requestedView = next;
    const sequence = ++viewSequence, direction = next === 'live' ? 1 : -1;
    if (viewAnimation) { viewAnimation.cancel(); viewAnimation = null; }
    const quiet = !animate || !mobileQuery.matches || document.body.dataset.fx === 'quiet' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches || typeof viewport.animate !== 'function';
    if (quiet || next === view) {
      viewport.classList.remove('view-transitioning'); commitView(next); return;
    }
    // Only content below the title and tabs moves. No snapshot copies or duplicate IDs.
    viewport.classList.add('view-transitioning');
    try {
      viewAnimation = viewport.animate([
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: `translateX(${-direction * 10}px)` }
      ], { duration: 100, easing: 'ease-in', fill: 'forwards' });
      await viewAnimation.finished;
      if (sequence !== viewSequence) return;
      viewAnimation.cancel();
      commitView(next);
      viewAnimation = viewport.animate([
        { opacity: 0, transform: `translateX(${direction * 10}px)` },
        { opacity: 1, transform: 'translateX(0)' }
      ], { duration: 210, easing: 'cubic-bezier(.2,.6,.2,1)', fill: 'none' });
      await viewAnimation.finished;
    } catch (_) { /* A newer tab selection supersedes this transition. */ }
    finally {
      if (sequence === viewSequence) {
        viewAnimation?.cancel(); viewAnimation = null;
        viewport.classList.remove('view-transitioning');
      }
    }
  }
  $('view-input').onclick = () => switchView('input');
  $('view-live').onclick = () => { if (hasRun) switchView('live'); };
  // Phones show expected coverage in the LIVE tab's result slot, not in TARGET.
  const coverageSection = document.querySelector('.coverage');
  function placeCoverage() {
    const home = mobileQuery.matches ? $('output-panel') : document.querySelector('.target-data');
    if (coverageSection.parentElement !== home) home.append(coverageSection);
  }
  placeCoverage();
  mobileQuery.addEventListener('change', () => {
    ++viewSequence; viewAnimation?.cancel(); viewAnimation = null;
    viewport.classList.remove('view-transitioning');
    placeCoverage();
    commitView(view);
  });
  $('mobile-main').onclick = () => $('form').requestSubmit();
  $('mobile-stop').onclick = () => $('stop').click();
  $('mobile-new').onclick = () => { switchView('input'); };
  let pendingSnapshot = null, paintFrame = 0, counterWidth = 0, counterFitKey = '';
  function cancelPaint() {
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    pendingSnapshot = null;
  }
  function receiveSnapshot(m, source) {
    // Background samples are recorded on receipt, so a superseded progress
    // frame or a hidden tab never discards them.
    fx('samples', m);
    // At most one pending progress frame. Terminal/pause messages supersede it.
    if (m.status !== 'running') { cancelPaint(); render(m); return; }
    pendingSnapshot = m;
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      const next = pendingSnapshot;
      pendingSnapshot = null;
      if (!next || worker !== source || next.id !== runId) return;
      render(next);
      source.postMessage({ cmd: 'ack', id: next.id, seq: next.seq });
    });
  }
  const busy = () => activeStates.includes(status);

  function controls() {
    const paused = status === 'paused', running = status === 'running';
    $('start-label').textContent = fatal ? 'RETRY ENGINE' : running || status === 'pausing' ? 'PAUSE SEARCH' :
      paused || status === 'resuming' ? 'RESUME SEARCH' : status === 'boot' ? 'INITIALIZING' : 'INITIATE SEARCH';
    $('start').disabled = unavailable || (!initialized && !fatal) || pendingStates.includes(status);
    $('stop').hidden = false;
    $('stop').disabled = !busy() || status === 'stopping';
    $('n-input').readOnly = busy();
    $('cap').disabled = busy();
    $('preset').disabled = busy();
    $('workers').disabled = busy();
    $('view-live').disabled = !hasRun;
    $('mobile-main-label').textContent = $('start-label').textContent;
    const action = running || status === 'pausing' ? 'pause' : 'play';
    for (const button of [$('start'), $('mobile-main')]) {
      if (button.dataset.action !== action) {
        button.dataset.action = action;
        button.querySelector('.action-icon path').setAttribute('d', action === 'pause' ? 'M7 4V16M13 4V16' : 'M7 4L15 10L7 16Z');
      }
    }
    $('mobile-main').disabled = $('start').disabled;
    $('mobile-main').hidden = !busy();
    $('mobile-stop').hidden = false;
    $('mobile-stop').disabled = $('stop').disabled;
    $('mobile-new').hidden = busy();
  }
  function setStatus(next) {
    if (status === next) return;
    const previous = status;
    status = next;
    fx('state', next, previous, last);
    const label = () => { $('status').textContent = labels[next] || next; $('status').dataset.state = next; };
    // Like the core words: a screen that ends at once never flashes its label.
    clearTimeout(statusTimer);
    if (next === 'screening') statusTimer = setTimeout(() => { if (status === 'screening') label(); }, 300);
    else label();
    controls();
  }
  function message(text) {
    $('announcement').textContent = '';
    requestAnimationFrame(() => { $('announcement').textContent = text; });
  }
  function note(text = '') {
    $('result-note').textContent = text;
    $('result-note').hidden = !text;
  }
  function clearResult() {
    BogoNumbers.resetRateScale();
    coverage.reset();
    fx('reset');
    cancelPaint();
    last = null;
    clearTimeout(copyTimer);
    $('copy-label').textContent = 'SHARE';
    BogoShare.clear();
    speedDisplay.reset();
    counter.set(0n, true);
    $('elapsed').textContent = '—';
    speedDisplay?.set('—', true);
    $('rate-label').textContent = 'THROUGHPUT';
    $('elapsed-unit').textContent = '';
    $('rate-unit').textContent = '';
    $('rate').removeAttribute('title');
    $('factor-values').hidden = true;
    $('factor-d').textContent = '';
    $('factor-q').textContent = '';
    $('factor-empty').hidden = false;
    $('copy').hidden = true;
    $('result-coverage').hidden = true;
    $('error').hidden = true;
    $('n-input').removeAttribute('aria-invalid');
    note();
    fitCounter();
  }
  function fitCounter() { counter.resize(); }
  let countInput = null;
  function updateCandidateCount() {
    const input=$('n-input').value;
    if (input===countInput) return;
    countInput=input;
    const output=$('candidate-count');
    try {
      const n=BOGO.parse(input), count=BOGO.countAllowed(BOGO.sqrt(n)), text=String(count);
      $('input-bits').textContent = nf.format(n.toString(2).length) + ' BITS';
      fx('input', String(n));
      coverage.setCandidates(count);
      if (text.length<=10) output.textContent=nf.format(count).replaceAll(',', '\u2009');
      else {
        const superscript='⁰¹²³⁴⁵⁶⁷⁸⁹';
        const exp=String(text.length-1).replace(/\d/g,d=>superscript[Number(d)]);
        output.textContent='≈ '+text[0]+'.'+text.slice(1,3)+' × 10'+exp;
      }
      output.title=nf.format(count)+' eligible integers up to floor(sqrt(N)); wheel-17 multiples excluded, with the small primes themselves retained.';
      output.setAttribute('aria-label',nf.format(count)+' candidates');
    } catch (_) { coverage.setCandidates(0n); $('input-bits').textContent='—'; fx('input', ''); output.textContent='—'; output.title=''; output.removeAttribute('aria-label'); }
  }
  function sizeInput() {
    updateCandidateCount();
    const input = $('n-input');
    const digits = input.value.normalize('NFKC').replace(/[\s,_]/g, '').length;
    $('input-digits').textContent = /^\d+$/.test(input.value.normalize('NFKC').replace(/[\s,_]/g, '')) ? `${digits.toLocaleString('en-US')} DIGITS` : '';
    fitInput();
  }
  // INTEGER N shows every digit when it can. On the desktop layout it takes the
  // largest size from 15px to 11px (line height 1.5x, whole lines) whose full
  // text fits the height the coverage plot can lend; the plot keeps 64px and
  // the controls below never move. A longer number gets an explicit head /
  // count / tail preview at rest, and VIEW ALL. Phones and narrow windows let
  // the field grow with its content instead of scrolling inside it.
  const nInput = $('n-input'), inputFrame = nInput.parentElement, preview = $('n-preview');
  const wideQuery = matchMedia('(min-width:1101px)');
  const measure = document.createElement('canvas').getContext('2d');
  const inputFit = { key: '', abridged: null };
  const digitsOf = () => nInput.value.normalize('NFKC').replace(/[\s,_]/g, '');
  function fitInput() {
    const plot = document.querySelector('.payload .coverage-plot'), width = nInput.clientWidth;
    if (!width) return;
    const desktop = wideQuery.matches && !mobileQuery.matches && !!plot;
    const key = [nInput.value, width, desktop, desktop ? $('form').clientHeight : 0].join('|');
    if (key === inputFit.key) return;
    inputFit.key = key;
    const style = nInput.style;
    let abridged = null;
    style.height = '0px';
    if (!desktop) {
      style.removeProperty('font-size'); style.removeProperty('line-height');
      style.height = Math.max(80, nInput.scrollHeight) + 'px';
    } else {
      // With the field empty, the plot holds all of the flexible height.
      const room = plot.clientHeight - 64;
      let height = null;
      for (const font of [15, 14, 13, 12, 11]) {
        const line = font * 1.5;
        style.fontSize = font + 'px'; style.lineHeight = line + 'px';
        const rows = Math.max(3, Math.round(nInput.scrollHeight / line));
        if (rows * line <= room) { height = rows * line; break; }
      }
      if (height === null) {   // still 11px: as many whole lines as fit
        abridged = { rows: Math.max(3, Math.floor(room / 16.5)) };
        height = abridged.rows * 16.5;
      }
      style.height = height + 'px';
    }
    inputFit.abridged = abridged;
    $('view-all').hidden = !abridged;
    renderPreview();
  }
  function renderPreview() {
    const fit = inputFit.abridged, resting = !!fit && document.activeElement !== nInput;
    inputFrame.classList.toggle('abridged', resting);
    if (!resting) return;
    const digits = digitsOf();
    // Characters per line as the field wraps them: monospace with 0.02em spacing.
    measure.font = '11px ' + getComputedStyle(nInput).fontFamily;
    const perLine = Math.max(8, Math.floor((nInput.clientWidth + .01) / (measure.measureText('0').width + .22)));
    const total = Math.ceil(digits.length / perLine), line = i => digits.slice(i * perLine, (i + 1) * perLine);
    if (total <= fit.rows) { preview.textContent = Array.from({ length: total }, (_, i) => line(i)).join('\n'); return; }
    const head = fit.rows - 2, more = total - head - 1;
    const note = [`··· ${more} MORE LINES · ${digits.length.toLocaleString('en-US')} DIGITS ···`, `··· ${more} MORE LINES ···`, `··· +${more} ···`]
      .find(text => text.length <= perLine) || '···';
    const gap = document.createElement('span'); gap.className = 'gap';
    gap.textContent = ' '.repeat(Math.floor((perLine - note.length) / 2)) + note;
    preview.replaceChildren(Array.from({ length: head }, (_, i) => line(i)).join('\n') + '\n', gap, '\n' + line(total - 1));
  }
  // Every digit, in five-digit groups; each line starts with its first digit's position.
  function openDigits() {
    const digits = digitsOf();
    if (!/^\d+$/.test(digits)) return;
    const preset = PRESETS.find(p => p.n === digits.replace(/^0+(?=\d)/, ''));
    $('digits-meta').textContent = (preset?.id.startsWith('rsa') ? preset.label.split(' · ')[0] + ' · ' : '') +
      nf.format(digits.length) + ' DIGITS · ' + $('input-bits').textContent;
    $('digits-feedback').textContent = '';
    $('digits-dialog').showModal();
    const body = $('digits-body'), box = body.parentElement, css = getComputedStyle(box);
    const width = box.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    measure.font = '12px ' + getComputedStyle(body).fontFamily;
    const advance = measure.measureText('0').width, places = String(digits.length).length;
    const groups = [20, 10, 5, 4, 2, 1].find(g => (places + 2 + 6 * g - 1) * advance <= width) || 1;
    const perLine = groups * 5, rows = document.createDocumentFragment();
    for (let i = 0; i < digits.length; i += perLine) {
      const index = document.createElement('span'); index.className = 'digits-index';
      index.textContent = String(i + 1).padStart(places, ' ');
      rows.append(index, '  ' + digits.slice(i, i + perLine).replace(/(\d{5})(?=\d)/g, '$1 ') + '\n');
    }
    body.replaceChildren(rows);
  }
  async function copyDigits() {
    const digits = digitsOf();
    let copied = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try { await navigator.clipboard.writeText(digits); copied = true; } catch (_) { /* Manual fallback below. */ }
    }
    if (!copied) {
      // Inside the modal: outside nodes are inert while it is open.
      const field = document.createElement('textarea');
      field.value = digits; field.readOnly = true; field.className = 'sr-only';
      $('digits-dialog').append(field); field.select();
      try { copied = document.execCommand('copy'); } catch (_) { /* Reported below. */ }
      field.remove(); $('digits-copy').focus();
    }
    $('digits-feedback').textContent = copied ? nf.format(digits.length) + ' digits copied.' : 'Copy was blocked. Select the digits above instead.';
  }
  $('view-all').addEventListener('click', openDigits);
  $('digits-copy').addEventListener('click', copyDigits);
  $('digits-dialog').addEventListener('click', event => {
    const dialog = $('digits-dialog');
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  nInput.addEventListener('focus', renderPreview);
  nInput.addEventListener('blur', () => { nInput.scrollTop = 0; renderPreview(); });
  function editInput() {
    if (busy()) return;
    const failureText = fatal ? $('error').textContent : '';
    clearResult();
    if (fatal) {
      $('error').textContent = failureText;
      $('error').hidden = false;
      setStatus('error');
    } else setStatus(initialized ? 'idle' : 'boot');
    sizeInput();
    const normalized = $('n-input').value.normalize('NFKC').replace(/[\s,_]/g, '').replace(/^0+(?=\d)/, '');
    $('preset').value = presetByValue.get(normalized) || '';
  }
  function inputError(error) {
    $('error').textContent = error.message || String(error);
    $('error').hidden = false;
    $('n-input').setAttribute('aria-invalid', 'true');
    switchView('input', false); $('n-input').focus();
  }
  function destroyWorker() {
    cancelPaint();
    clearTimeout(watchdog);
    if (worker) { worker.terminate(); worker = null; }
    if (workerURL) { URL.revokeObjectURL(workerURL); workerURL = null; }
    initialized = false;
  }
  function engineError(text) {
    fx('error', text);
    destroyWorker();
    fatal = true;
    $('error').textContent = text;
    $('error').hidden = false;
    setStatus('error'); switchView('input', false);
  }
  function render(m) {
    last = m;
    BogoNumbers.selectRateScale(m.rate);
    fx('snapshot', m);
    const trials = BigInt(m.trials), ms = Math.max(0, m.elapsedMs || 0);
    counter.set(trials, m.status !== 'running');
    coverage.update(trials, m.status);
    // The final expected coverage stays beside the result (shown on phones).
    const settled = trials > 0n && ['found', 'stopped', 'capped', 'counter-limit', 'interrupted'].includes(m.status);
    $('result-coverage').hidden = !settled;
    if (settled) $('result-coverage').textContent = 'COVERAGE ' + $('coverage-value').textContent;
    const duration = trials ? BogoNumbers.duration(ms) : { text: '—', unit: '' };
    $('elapsed').textContent = duration.text;
    $('elapsed-unit').textContent = duration.unit;
    $('elapsed').title = trials ? BogoNumbers.seconds(ms, 6) + ' s' : '';
    BogoNumbers.fit($('elapsed'), duration.text);
    const rate = m.rate;
    $('rate-label').textContent = 'THROUGHPUT';
    $('rate-label').title = m.rateKind === 'average' ? 'Mean throughput for the whole search' : 'Measured throughput over approximately the last two seconds';
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
      speedDisplay.set(BogoNumbers.rate(rate), m.status !== 'running');
      $('rate').title = nf.format(Math.round(rate)) + ' trials/s';
    } else {
      speedDisplay?.set('—', true);
      $('rate-unit').textContent = '';
      $('rate').removeAttribute('title');
    }
    $('factor-values').hidden = !m.factor;
    $('factor-empty').hidden = !!m.factor;
    $('copy').hidden = !m.factor;
    if (m.factor) {
      $('factor-d').textContent = m.factor.d;
      BogoShare.setResult(m);
      $('factor-q').textContent = m.factor.q;
      $('factor-values').classList.toggle('long', m.factor.d.length + m.factor.q.length > 26);
    }
    note(m.status === 'probable' ? 'Passed the BPSW screen. This is not a proof of primality.' :
      m.status === 'interrupted' ? 'Last snapshot before this page was left.' : '');
    // Do not unlock controls on an in-flight snapshot that preceded a command.
    const pending = (status === 'stopping' && ['running', 'paused'].includes(m.status)) ||
      (status === 'pausing' && m.status === 'running') || (status === 'resuming' && m.status === 'paused');
    if (!pending) setStatus(m.status);
    fitCounter();
  }

  function createWorker() {
    if (worker) return;
    fatal = false;
    unavailable = !globalThis.WebAssembly || !globalThis.Worker || !globalThis.crypto?.getRandomValues;
    if (unavailable) {
      engineError('This browser requires WebAssembly, Web Workers and Web Crypto to run this app.');
      return;
    }
    if (!last) setStatus('boot');
    else controls();
    try {
      workerURL = BogoWorker.createURL();
      const current = new SearchPool(workerURL);
      worker = current;
      current.onmessage = event => {
        if (worker !== current) return;
        const m = event.data;
        if (m.type === 'ready') {
          engineKind = m.engineKind;
          fx('ready', engineKind);
          clearTimeout(watchdog);
          initialized = true;
          // Keep the Blob URL alive for workers created when a search begins.
          if (status === 'boot') setStatus('idle');
          else controls();
          return;
        }
        if (m.id !== undefined && m.id !== runId) return;
        if (m.type === 'error') { engineError(m.message); return; }
        if (m.type === 'screening') {
          if (status !== 'stopping') setStatus('screening');
        } else if (m.type === 'snapshot' || m.type === 'terminal') receiveSnapshot(m, current);
      };
      current.onerror = event => {
        if (worker !== current) return;
        event.preventDefault();
        engineError('Computation interrupted. ' + (event.message || 'The computation engine encountered an error.'));
      };
      current.onmessageerror = () => {
        if (worker === current) engineError('Could not receive the computation result.');
      };
      watchdog = setTimeout(() => {
        if (worker === current && !initialized) engineError('The computation engine did not finish initializing.');
      }, 15000);
    } catch (e) { engineError('Could not start the computation engine. ' + (e.message || '')); }
  }

  $('form').addEventListener('submit', event => {
    event.preventDefault();
    if (fatal) { clearResult(); createWorker(); return; }
    if (!initialized || pendingStates.includes(status)) return;
    if (status === 'running') {
      setStatus('pausing');
      worker.postMessage({ cmd: 'pause', id: runId });
      return;
    }
    if (status === 'paused') {
      setStatus('resuming');
      worker.postMessage({ cmd: 'resume', id: runId });
      return;
    }
    let n;
    try { n = BOGO.parse($('n-input').value); }
    catch (e) { inputError(e); return; }
    clearResult();
    $('n-input').value = String(n);
    sizeInput();
    runId++;
    hasRun = true; $('n-input').blur(); switchView('live');
    setStatus('screening');
    worker.postMessage({ cmd: 'run', id: runId, n: String(n), cap: $('cap').value, workers: $('workers').value });
  });
  $('stop').addEventListener('click', () => {
    if (!worker || !busy() || status === 'stopping') return;
    setStatus('stopping');
    worker.postMessage({ cmd: 'stop', id: runId });
  });
  $('n-input').addEventListener('input', editInput);
  $('n-input').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!$('start').disabled) $('form').requestSubmit();
    }
  });
  $('preset').addEventListener('change', () => {
    if (busy()) return;
    const preset = presetById.get($('preset').value);
    if (preset) {
      $('n-input').value = preset.n;
      editInput();
    } else {
      $('n-input').focus();
    }
  });

  $('copy').addEventListener('click', () => BogoShare.open(last));

  const resize = () => {
    counterWidth = $('trial-count').parentElement.clientWidth;
    fitCounter();
    speedDisplay.resize();
    BogoNumbers.fit($('elapsed'), $('elapsed').textContent);
    fitInput();
  };
  if (globalThis.ResizeObserver) new ResizeObserver(resize).observe(document.querySelector('.workspace'));
  addEventListener('resize', resize);
  const syncViewport = () => {
    const visual = globalThis.visualViewport;
    const height = visual && Math.abs(visual.scale - 1) < .01 ? Math.min(innerHeight, visual.height) : innerHeight;
    document.documentElement.style.setProperty('--app-height', height + 'px');
    document.body.dataset.keyboard = String(height < innerHeight * .72);
  };
  addEventListener('resize', syncViewport);
  globalThis.visualViewport?.addEventListener('resize', syncViewport);
  syncViewport();
  addEventListener('pagehide', () => {
    const interrupted = busy();
    destroyWorker();
    if (interrupted) {
      runId++;
      if (last) render({ ...last, status: 'interrupted', factor: null });
      else { setStatus('interrupted'); note('The search was interrupted when the page was left.'); }
    }
  });
  addEventListener('pageshow', () => { if (!worker) createWorker(); });
  Object.defineProperty(window, 'bogoDiagnostics', {
    get: () => ({ status, initialized, version: '17.0', engineKind, rng: 'ChaCha20', distribution: 'uniform-wheel-17',
      pool: worker?.diagnostics || null, counter: counter.diagnostics, speed: speedDisplay.diagnostics, view,
      visuals: typeof BogoVisual !== 'undefined' ? BogoVisual.diagnostics : null,
      coverage: coverage.diagnostics,
      lastSnapshot: last ? structuredClone(last) : null })
  });
  $('preset').value = presetByValue.get($('n-input').value) || '';
  sizeInput();
  resize();
  createWorker();
})();

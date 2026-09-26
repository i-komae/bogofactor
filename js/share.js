'use strict';
/** User-triggered exports. PNG is prepared before copy/share is enabled, so native
 * APIs are called directly from the click without losing transient activation. */
const BogoShare = (() => {
  const $ = id => document.getElementById(id);
  const dialog = $('share-dialog');
  let result = null, output = null, previewURL = null, generation = 0, operation = false, operationId = 0;
  const notice = (text = '', bad = false) => {
    $('share-feedback').textContent = text;
    $('share-feedback').dataset.error = String(bad);
  };
  function fileName() {
    const stem = result.name ? result.name.toLowerCase() : result.digits + 'digits';
    return 'bogo-factor-' + stem + '-' + result.trials + 'trials.png';
  }
  function capabilities() {
    const secure = window.isSecureContext;
    let imageCopy = !!(secure && navigator.clipboard?.write && window.ClipboardItem);
    try { if (imageCopy && ClipboardItem.supports) imageCopy = ClipboardItem.supports('image/png'); } catch (_) { imageCopy = false; }
    let shareFile = false, shareText = false;
    if (secure && navigator.share) {
      try { shareFile = !!(output && navigator.canShare?.({ files: [output.file] })); } catch (_) { /* Unsupported files. */ }
      try { shareText = navigator.canShare ? navigator.canShare({ text: 'BOGO / FACTOR', url: BogoCard.URL }) : true; } catch (_) { /* Unsupported data. */ }
    }
    return { imageCopy, shareFile, shareText };
  }
  function controls() {
    const cap = capabilities(), ready = !!output;
    $('share-copy-text').disabled = !result || operation;
    $('share-copy-image').disabled = !ready || operation || !cap.imageCopy;
    $('share-save').disabled = !ready || operation;
    $('share-native').disabled = !ready || operation || !(cap.shareFile || cap.shareText);
    $('share-native-label').textContent = cap.shareFile ? 'SHARE…' : cap.shareText ? 'SHARE TEXT…' : 'SHARE…';
    $('share-copy-image').title = cap.imageCopy ? 'Copy the preview as a PNG image' : 'Image copying is unavailable here. Use SAVE PNG.';
    $('share-native').title = cap.shareFile ? 'Open your device’s share menu with this image' : cap.shareText ? 'This device can share text, but not PNG files' : 'The device share menu is unavailable in this browser';
    const missing = [];
    if (ready && !cap.imageCopy) missing.push('Image copy unavailable');
    if (ready && !cap.shareFile && !cap.shareText) missing.push('Device sharing unavailable');
    $('share-availability').textContent = missing.length ? missing.join(' · ') + '. SAVE PNG is available.' : '';
    $('share-availability').hidden = !missing.length;
  }
  function disposePreview() {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = null; output = null;
  }
  function setResult(snapshot) {
    // Do not trust any unverified display label or the currently edited input.
    if (result && result.n === snapshot.n && result.trials === snapshot.trials && result.elapsedMs === snapshot.elapsedMs && result.d === snapshot.factor?.d && result.q === snapshot.factor?.q) return;
    result = BogoCard.model(snapshot);
  }
  async function prepare() {
    const id = ++generation, snapshot = result;
    disposePreview(); notice('Preparing image…'); controls();
    $('share-preview').removeAttribute('src'); $('share-preview').hidden = true;
    $('share-zoom').disabled = true; $('share-zoom').classList.remove('zoomed'); $('share-zoom').setAttribute('aria-pressed','false');
    $('share-text').value = BogoCard.text(snapshot);
    try {
      const rendered = await BogoCard.png(snapshot);
      if (id !== generation || !dialog.open) return;
      const file = new File([rendered.blob], fileName(), { type: 'image/png' });
      output = { ...rendered, file };
      previewURL = URL.createObjectURL(rendered.blob);
      const image = $('share-preview'); image.src = previewURL; image.hidden = false;
      image.alt = 'Verified factorization of ' + (snapshot.name || snapshot.digits + '-digit integer') +
        '. ' + snapshot.trials + ' trials in ' + BogoCard.elapsed(snapshot.elapsedMs) + '. Complete expression is available in Result text.';
      $('share-size').textContent = rendered.canvas.width + ' × ' + rendered.canvas.height + ' · PNG';
      $('share-zoom').disabled = false; notice(); controls();
    } catch (error) {
      if (id !== generation || !dialog.open) return;
      notice('Image creation failed. COPY TEXT is still available.', true); controls();
    }
  }
  function open(snapshot) {
    try {
      setResult(snapshot); if (!dialog.open) dialog.showModal();
      $('share-text-details').open = false;
      prepare();
    } catch (error) { if (typeof BogoVisual !== 'undefined') BogoVisual.toast(error.message); }
  }
  function clear() {
    ++generation; ++operationId; result = null; operation = false; disposePreview();
    if (dialog.open) dialog.close();
  }
  async function perform(kind) {
    if (!result || operation) return;
    const id = generation, snapshot = result, image = output, task = ++operationId;
    operation = true; controls(); notice();
    try {
      if (kind === 'text') {
        const value = BogoCard.text(snapshot);
        let copied = false;
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          try { await navigator.clipboard.writeText(value); copied = true; } catch (_) { /* Manual fallback below. */ }
        }
        if (!copied) {
          // Must be inside the modal: outside nodes are inert while showModal is open.
          const field = $('share-text'); $('share-text-details').open = true;
          field.value = value; field.focus(); field.select();
          try { copied = document.execCommand('copy'); } catch (_) { /* Selected text remains usable. */ }
          if (!copied) throw Error('Copy was blocked. The result text is selected below.');
        }
        if (id === generation && dialog.open) notice('Text copied.');
      } else if (kind === 'image') {
        if (!image) return;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]);
        if (id === generation && dialog.open) notice('Image copied.');
      } else if (kind === 'save') {
        if (!image) return;
        const a = document.createElement('a'); a.href = previewURL; a.download = fileName();
        dialog.append(a); a.click(); a.remove(); notice('PNG download started.');
      } else if (kind === 'native') {
        if (!image) return;
        const cap = capabilities();
        if (cap.shareFile) {
          // No hidden await before this call. The exact preview PNG is shared.
          await navigator.share({ files: [image.file], title: 'BOGO / FACTOR — ' + (snapshot.name || snapshot.digits + '-digit factorization'),
            text: snapshot.trials + ' trials · ' + BogoCard.elapsed(snapshot.elapsedMs) + '\n' + BogoCard.URL });
        } else if (cap.shareText) await navigator.share({ title: 'BOGO / FACTOR', text: BogoCard.text(snapshot) });
        else throw Error('Device sharing is unavailable. Use SAVE PNG.');
        if (id === generation && dialog.open) notice('Handed to your device’s share menu.');
      }
    } catch (error) {
      if (id !== generation || !dialog.open) return;
      if (error.name === 'AbortError') notice('Sharing canceled.');
      else if (kind === 'image') notice('Image copy was blocked. Use SAVE PNG instead.', true);
      else if (kind === 'native') notice('Sharing was blocked or unavailable. Use SAVE PNG instead.', true);
      else notice(error.message || 'Export could not be completed.', true);
    } finally {
      if (task === operationId) { operation = false; if (dialog.open) controls(); }
    }
  }
  $('share-copy-text').onclick = () => perform('text');
  $('share-copy-image').onclick = () => perform('image');
  $('share-save').onclick = () => perform('save');
  $('share-native').onclick = () => perform('native');
  $('share-zoom').onclick = () => {
    const zoom = $('share-zoom').classList.toggle('zoomed'); $('share-zoom').setAttribute('aria-pressed', String(zoom));
  };
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { ++generation; ++operationId; operation = false; disposePreview(); $('share-preview').removeAttribute('src'); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (dialog.open && result) prepare(); });
  addEventListener('pagehide', () => { if (dialog.open) dialog.close(); });
  return { setResult, open, clear, get diagnostics() { return { ready: !!output, open: dialog.open, pending: operation, name: result?.name, width: output?.canvas.width, height: output?.canvas.height, capabilities: capabilities() }; } };
})();

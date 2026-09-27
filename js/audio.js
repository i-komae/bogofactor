'use strict';
/** One opt-in, local looping soundtrack. Prefer a mixable audio session; when
 * that API is absent, use Web Audio on hosted pages instead of a media player.
 * Search state and layout never change the track, playback position or gain.
 * The file (2.2 MB) is fetched at low priority during the opening, unless the
 * connection asks to save data. Decoding it (about 38 MB of samples) waits for
 * a sign of intent: the BGM control is hovered or focused, or BGM was on last
 * time. A press then starts sound almost at once; a press before that shows
 * LOAD n% and DECODE, each stage with its own time limit.
 */
const BogoAudio = (() => {
  const button = document.getElementById('sound-toggle');
  const path = 'assets/audio/maoudamashii-cyber08-loop.mp3';
  const volume = .23, memory = 'bogofactor.bgm';
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const hosted = location.protocol !== 'file:';
  let audio = null, context = null, gain = null, buffer = null, source = null;
  let bytes = null, downloading = null, decoding = null, received = 0, total = 0;
  let startedAt = 0, backend = null, ambient = false, pageActive = true;
  let wanted = false, failed = false, pending = false, generation = 0;
  let preload = 'idle', decodedBy = null;
  const notify = text => { if (typeof BogoVisual !== 'undefined') BogoVisual.toast(text); };
  const visible = () => pageActive && !document.hidden;
  const remember = on => { try { localStorage.setItem(memory, on ? 'on' : 'off'); } catch (_) { /* Private mode. */ } };
  const recalled = () => { try { return localStorage.getItem(memory) === 'on'; } catch (_) { return false; } };
  // Native playback is chosen when a mixable session exists or bytes cannot be fetched.
  const nativeLikely = () => !!navigator.audioSession || !hosted || !Context;

  function label(state) {
    button.textContent = 'BGM / ' + state;
    button.setAttribute('aria-pressed', String(wanted));
    button.title = wanted ? 'Mute Cyber 08 — MaouDamashii' : 'Play Cyber 08 — MaouDamashii';
  }
  function progress() {
    if (!pending) return;
    if (!buffer && !bytes && (downloading || received)) label('LOAD ' + (total ? Math.min(99, Math.floor(received / total * 100)) : 0) + '%');
    else if (!buffer && (decoding || bytes)) label('DECODE');
  }
  function requestAmbient() {
    // Audio Session (not Media Session): ambient is mixable, playback is not.
    // Set this BEFORE constructing/starting a player, never after play().
    try {
      const session = navigator.audioSession;
      if (!session) return false;
      session.type = 'ambient';
      return session.type === 'ambient';
    } catch (_) {
      return false; // Feature detection, not a promise about OS audio policy.
    }
  }
  function pause() {
    generation++;
    pending = false;
    if (audio) audio.pause();
    if (context && context.state !== 'closed') {
      // Suspension freezes both the loop and its audio clock, preserving position.
      try { context.suspend().catch(() => {}); } catch (_) { /* Already closed. */ }
    }
  }
  function fail(text = 'Soundtrack could not start. Check the audio file or tap BGM to retry.') {
    if (!wanted) return;
    wanted = false; failed = true;
    pause(); label('OFF');
    notify(text);
  }
  function interrupted() {
    if (!wanted || pending || !visible()) return;
    // Never fight another app/OS interruption with automatic play/resume retries.
    wanted = false;
    pause(); label('OFF');
    notify('BGM was interrupted. Tap BGM to resume.');
  }
  function player() {
    if (audio) return audio;
    audio = new Audio(path);
    audio.loop = true;
    audio.preload = 'none';
    audio.volume = volume;
    audio.setAttribute('playsinline', '');
    audio.addEventListener('error', () => { if (wanted) fail(); });
    audio.addEventListener('pause', () => { if (audio.paused) interrupted(); });
    return audio;
  }
  function audioContext() {
    if (context) return context;
    context = new Context();
    gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(context.destination);
    context.addEventListener('statechange', () => {
      if (source && context.state !== 'running') interrupted();
    });
    return context;
  }
  /** The compressed file, kept in memory once fetched. Aborts after 10 s without progress. */
  function download(priority = 'auto') {
    if (bytes) return Promise.resolve(bytes);
    if (downloading) return downloading;
    const controller = new AbortController();
    let stall = 0;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), 10000); };
    arm(); received = 0; total = 0;
    downloading = fetch(path, { signal: controller.signal, credentials: 'same-origin', priority }).then(async response => {
      if (!response.ok) throw Error('Could not load the soundtrack.');
      total = Number(response.headers.get('content-length')) || 0;
      if (!response.body || !response.body.getReader) return response.arrayBuffer();
      const reader = response.body.getReader(), chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); chunks.push(value); received += value.length; progress();
      }
      const whole = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
      return whole.buffer;
    }).then(result => { bytes = result; received = total = result.byteLength; progress(); return bytes; })
      .finally(() => { clearTimeout(stall); downloading = null; });
    return downloading;
  }
  /** Decoded samples for the gapless Web Audio loop; a copy of the bytes is decoded. */
  function decode() {
    if (buffer) return Promise.resolve(buffer);
    if (decoding) return decoding;
    decoding = download().then(compressed => {
      progress();
      // Before any press, decode offline: no audio device is opened for it.
      const ctx = context || (Offline ? new Offline(2, 1, 48000) : audioContext());
      decodedBy = ctx === context ? 'playback context' : 'offline context';
      let timer = 0;
      const work = new Promise((resolve, reject) => {
        const promise = ctx.decodeAudioData(compressed.slice(0), resolve, reject);
        if (promise && promise.then) promise.then(resolve, reject);
      });
      const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Soundtrack decoding timed out.')), 15000); });
      return Promise.race([work, limit]).finally(() => clearTimeout(timer));
    }).then(decoded => {
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw Error('The soundtrack is empty.');
      buffer = decoded; return buffer;
    }).finally(() => { decoding = null; });
    return decoding;
  }
  /** Intent without a press: decode bytes already fetched or being fetched. */
  function warm() {
    if (buffer || decoding || nativeLikely() || !(bytes || downloading)) return;
    decode().catch(() => { /* A press retries and reports failures. */ });
  }
  function complete(id) {
    if (id !== generation || !wanted || !visible()) return;
    pending = false; failed = false; label('ON');
  }
  function play() {
    if (!wanted || !visible() || pending) return;
    ambient = requestAmbient();
    if (!backend) {
      // An explicit ambient session lets native playback remain lightweight.
      // file:// cannot reliably fetch/decode local bytes; retain local playback
      // there. Without Audio Session support, mixing on that path is OS-defined.
      backend = ambient || !hosted || !Context ? 'native-media' : 'web-audio';
    }
    const id = ++generation;
    pending = true; label('LOAD');
    try {
      if (backend === 'native-media') {
        const media = player();
        // Stay inside the user gesture; do not await network work before play.
        const limit = setTimeout(() => { if (id === generation && pending) fail(); }, 15000);
        Promise.resolve(media.play()).then(() => complete(id))
          .catch(() => { if (id === generation) fail(); }).finally(() => clearTimeout(limit));
      } else {
        const ctx = audioContext();
        progress();
        // Resume inside the gesture as well. Only one buffer/source is retained.
        let timer = 0;
        const resumed = Promise.race([ctx.resume(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Audio output did not start.')), 10000);
        })]).finally(() => clearTimeout(timer));
        Promise.all([resumed, decode()]).then(([, decoded]) => {
          if (id !== generation || !wanted || !visible()) return;
          if (ctx.state !== 'running') throw Error('Audio playback was interrupted.');
          if (!source) {
            const loop = ctx.createBufferSource();
            loop.buffer = decoded; loop.loop = true; loop.connect(gain);
            try { loop.start(); } catch (error) { loop.disconnect(); throw error; }
            startedAt = ctx.currentTime; source = loop;
          }
          complete(id);
        }).catch(error => { if (id === generation) fail(/timed out/.test(error?.message) ? error.message + ' Tap BGM to retry.' : undefined); });
      }
    } catch (_) { if (id === generation) fail(); }
    // No media-element fallback on HTTP/decode failure: that would silently
    // reintroduce the exclusive player this path is intended to avoid.
  }
  button.addEventListener('click', () => {
    wanted = !wanted; remember(wanted);
    if (!wanted) { pause(); label('OFF'); return; }
    failed = false; play();
  });
  for (const type of ['pointerenter', 'focus', 'pointerdown']) button.addEventListener(type, warm);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else play();
  });
  addEventListener('pagehide', () => { pageActive = false; pause(); });
  addEventListener('pageshow', () => { pageActive = true; play(); });
  // Fetch during the opening, never on a connection that asks to save data.
  const connection = navigator.connection;
  if (!hosted) preload = 'skipped: file';
  else if (connection?.saveData) preload = 'skipped: save-data';
  else if (/^(slow-)?2g$/.test(connection?.effectiveType || '')) preload = 'skipped: ' + connection.effectiveType;
  else {
    preload = 'loading';
    download('low').then(() => { preload = 'loaded'; }, () => { preload = 'failed'; });
  }
  // BGM was on last time: have it decoded once the opening has finished.
  if (recalled()) setTimeout(warm, 1500);
  return { get diagnostics() {
    const track = audio ? { key: 'cyber08', paused: audio.paused, readyState: audio.readyState,
      volume: audio.volume, currentTime: audio.currentTime, duration: audio.duration } :
      context ? { key: 'cyber08', paused: !source || context.state !== 'running',
        readyState: buffer ? 4 : 0, volume,
        currentTime: source ? Math.max(0, context.currentTime - startedAt) % buffer.duration : 0,
        duration: buffer?.duration || 0 } : null;
    return { wanted, pending, failed, local: true, scene: track && wanted ? 'cyber08' : null,
      player: backend, ambientRequested: ambient, contextState: context?.state || null,
      preload, bytes: bytes ? bytes.byteLength : received, decoded: !!buffer, decoding: !!decoding, decodedBy,
      remembered: recalled(), tracks: track ? [track] : [] };
  } };
})();

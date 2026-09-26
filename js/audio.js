'use strict';
/** One opt-in, local looping soundtrack. Prefer a mixable audio session; when
 * that API is absent, use Web Audio on hosted pages instead of a media player.
 * Search state and layout never change the track, playback position or gain.
 */
const BogoAudio = (() => {
  const button = document.getElementById('sound-toggle');
  const path = 'assets/audio/maoudamashii-cyber08-loop.mp3';
  const volume = .23;
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  let audio = null, context = null, gain = null, buffer = null, source = null;
  let loading = null, startedAt = 0;
  let backend = null, ambient = false, pageActive = true;
  let wanted = false, failed = false, pending = false;
  let generation = 0, timeout = 0;
  const notify = text => { if (typeof BogoVisual !== 'undefined') BogoVisual.toast(text); };
  const visible = () => pageActive && !document.hidden;

  function label(state) {
    button.textContent = 'BGM / ' + state;
    button.setAttribute('aria-pressed', String(wanted));
    button.title = wanted ? 'Mute Cyber 08 — MaouDamashii' : 'Play Cyber 08 — MaouDamashii';
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
    clearTimeout(timeout);
    if (audio) audio.pause();
    if (context && context.state !== 'closed') {
      // Suspension freezes both the loop and its audio clock, preserving position.
      try { context.suspend().catch(() => {}); } catch (_) { /* Already closed. */ }
    }
  }
  function fail() {
    if (!wanted) return;
    wanted = false; failed = true;
    pause(); label('OFF');
    notify('Soundtrack could not start. Check the audio file or tap BGM to retry.');
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
  function loadBuffer(ctx) {
    if (buffer) return Promise.resolve(buffer);
    if (loading) return loading;
    const controller = new AbortController();
    let timer;
    const work = fetch(path, { signal: controller.signal, credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw Error('Could not load the soundtrack.');
        return response.arrayBuffer();
      })
      .then(bytes => ctx.decodeAudioData(bytes));
    // Bound fetch AND decoding. Cancellation of playback does not refetch the
    // same track; a completed load remains cached, without starting any sound.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(); reject(Error('Soundtrack loading timed out.'));
      }, 15000);
    });
    loading = Promise.race([work, deadline]).then(decoded => {
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw Error('The soundtrack is empty.');
      }
      buffer = decoded;
      return buffer;
    }).finally(() => { clearTimeout(timer); loading = null; });
    return loading;
  }
  function complete(id) {
    if (id !== generation || !wanted || !visible()) return;
    clearTimeout(timeout); pending = false; failed = false; label('ON');
  }
  function play() {
    if (!wanted || !visible() || pending) return;
    ambient = requestAmbient();
    if (!backend) {
      // An explicit ambient session lets native playback remain lightweight.
      // file:// cannot reliably fetch/decode local bytes; retain local playback
      // there. Without Audio Session support, mixing on that path is OS-defined.
      backend = ambient || location.protocol === 'file:' || !Context ? 'native-media' : 'web-audio';
    }
    const id = ++generation;
    pending = true; label('LOAD');
    clearTimeout(timeout);
    timeout = setTimeout(() => { if (id === generation) fail(); }, 15000);
    try {
      if (backend === 'native-media') {
        const media = player();
        // Stay inside the user gesture; do not await network work before play.
        Promise.resolve(media.play()).then(() => complete(id))
          .catch(() => { if (id === generation) fail(); });
      } else {
        const ctx = audioContext();
        // Resume inside the gesture as well. Only one buffer/source is retained.
        const resumed = ctx.resume();
        Promise.all([resumed, loadBuffer(ctx)]).then(([, decoded]) => {
          if (id !== generation || !wanted || !visible()) return;
          if (ctx.state !== 'running') throw Error('Audio playback was interrupted.');
          if (!source) {
            const loop = ctx.createBufferSource();
            loop.buffer = decoded; loop.loop = true; loop.connect(gain);
            try { loop.start(); } catch (error) { loop.disconnect(); throw error; }
            startedAt = ctx.currentTime; source = loop;
          }
          complete(id);
        }).catch(() => { if (id === generation) fail(); });
      }
    } catch (_) { if (id === generation) fail(); }
    // No media-element fallback on HTTP/decode failure: that would silently
    // reintroduce the exclusive player this path is intended to avoid.
  }
  button.addEventListener('click', () => {
    wanted = !wanted;
    if (!wanted) { pause(); label('OFF'); return; }
    failed = false; play();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else play();
  });
  addEventListener('pagehide', () => { pageActive = false; pause(); });
  addEventListener('pageshow', () => { pageActive = true; play(); });
  return { get diagnostics() {
    const track = audio ? { key: 'cyber08', paused: audio.paused, readyState: audio.readyState,
      volume: audio.volume, currentTime: audio.currentTime, duration: audio.duration } :
      context ? { key: 'cyber08', paused: !source || context.state !== 'running',
        readyState: buffer ? 4 : 0, volume,
        currentTime: source ? Math.max(0, context.currentTime - startedAt) % buffer.duration : 0,
        duration: buffer?.duration || 0 } : null;
    return { wanted, pending, failed, local: true, scene: track && wanted ? 'cyber08' : null,
      player: backend, ambientRequested: ambient, contextState: context?.state || null,
      tracks: track ? [track] : [] };
  } };
})();

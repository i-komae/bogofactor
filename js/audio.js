'use strict';
/** One opt-in, local looping soundtrack. Search state and layout never change
 * the source, playback position, or gain. Pausing audio preserves its position. */
const BogoAudio = (() => {
  const button = document.getElementById('sound-toggle');
  const path = 'assets/audio/maoudamashii-cyber08-loop.mp3';
  const volume = .23;
  let audio = null, wanted = false, failed = false, pending = false;
  let generation = 0, timeout = 0;
  const notify = text => { if (typeof BogoVisual !== 'undefined') BogoVisual.toast(text); };

  function label(state) {
    button.textContent = 'BGM / ' + state;
    button.setAttribute('aria-pressed', String(wanted));
    button.title = wanted ? 'Mute Cyber 08 — MaouDamashii' : 'Play Cyber 08 — MaouDamashii';
  }
  function player() {
    if (audio) return audio;
    audio = new Audio(path);
    audio.loop = true;
    audio.preload = 'none';
    audio.volume = volume;
    audio.setAttribute('playsinline', '');
    audio.addEventListener('error', () => { if (wanted) fail(); });
    return audio;
  }
  function pause() {
    generation++;
    pending = false;
    clearTimeout(timeout);
    if (audio) audio.pause();
    // Keep src and currentTime intact: returning never restarts the track.
  }
  function fail() {
    if (!wanted) return;
    wanted = false; failed = true;
    pause(); label('OFF');
    notify('Soundtrack could not start. Check the audio file or tap BGM to retry.');
  }
  function play() {
    if (!wanted || document.hidden || pending) return;
    const media = player();
    if (!media.paused) { label('ON'); return; }
    const id = ++generation;
    pending = true; label('LOAD');
    clearTimeout(timeout);
    timeout = setTimeout(() => { if (id === generation) fail(); }, 15000);
    // Call play directly in the user's gesture; no fetch or await before it.
    let playing;
    try { playing = media.play(); } catch (_) { fail(); return; }
    Promise.resolve(playing).then(() => {
      if (id !== generation || !wanted || document.hidden) return;
      clearTimeout(timeout); pending = false; failed = false; label('ON');
    }).catch(() => { if (id === generation) fail(); });
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
  addEventListener('pagehide', pause);
  addEventListener('pageshow', play);
  return { get diagnostics() { return { wanted, pending, failed, local: true,
    scene: audio && wanted ? 'cyber08' : null, player: 'native-media',
    tracks: audio ? [{ key: 'cyber08', paused: audio.paused, readyState: audio.readyState,
      volume: audio.volume, currentTime: audio.currentTime, duration: audio.duration }] : [] }; } };
})();

// Tells the app whether this page is playing sound (for the tab's speaker),
// and lets it mute the page. Injected into every page in an isolated world.
(() => {
  if (window.__dittoMediaWatch) { return; }
  window.__dittoMediaWatch = true;
  let muted = false;
  let last = null;
  const report = () => {
    const playing = Array.from(document.querySelectorAll('video, audio'))
        .some(m => !m.paused && !m.ended && !m.muted && m.volume > 0);
    if (playing !== last) {
      last = playing;
      window.webkit?.messageHandlers?.dittoMedia?.postMessage({playing});
    }
  };
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied']) {
    document.addEventListener(type, () => setTimeout(report, 0), true);
  }
  // A muted page stays muted, including media that starts later.
  document.addEventListener('play', event => {
    if (muted && event.target instanceof HTMLMediaElement) { event.target.muted = true; }
  }, true);
  window.__dittoSetMuted = value => {
    muted = value;
    for (const media of document.querySelectorAll('video, audio')) { media.muted = value; }
    report();
  };
})();

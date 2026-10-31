// YouTube ads, in an isolated world on YouTube pages:
// - Skip: reports the "Skip" button's centre (CSS pixels) to the app as soon
//   as YouTube offers it; the app presses it with real input (Shield.swift).
// - Until then: the ad is muted and covered by a quiet note (the note takes
//   no clicks, so Skip and YouTube's own controls still work). Sound and
//   picture come back as the video resumes.
(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname) || window.__dittoSkip) { return; }
  window.__dittoSkip = true;
  let lastClick = 0;
  // The skip button's centre, or null while there is none to press. Covers
  // YouTube's current and earlier skip buttons.
  const findSkipButton = () => {
    const button = document.querySelector(
        '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
        '.ytp-ad-skip-button-slot button');
    if (!button || button.disabled) { return null; }
    const r = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    if (r.width < 4 || r.height < 4 || style.display === 'none' ||
        style.visibility === 'hidden' || Number(style.opacity) < 0.5) {
      return null;
    }
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  };
  window.__dittoFindSkipButton = findSkipButton;

  // The player marks itself while an ad plays: the steadiest signal there is.
  const player = () => document.querySelector('#movie_player, .html5-video-player');
  const adPlaying = () => !!player()?.matches('.ad-showing, .ad-interrupting');
  let muted = null;  // The video's own muted state while Ditto mutes an ad.

  const cover = () => {
    const box = player()?.querySelector('.html5-video-container');
    if (!box || box.querySelector('.ditto-ad-cover')) { return; }
    const note = document.createElement('div');
    note.className = 'ditto-ad-cover';
    note.textContent = 'Ad muted · skipped as soon as YouTube allows';
    note.style.cssText = 'position:absolute;inset:0;z-index:1;display:grid;' +
        'place-items:center;background:rgba(9,9,11,.92);color:#a1a1aa;' +
        'font:500 13px -apple-system,system-ui,sans-serif;pointer-events:none;';
    box.append(note);
  };

  const update = () => {
    const video = player()?.querySelector('video');
    if (adPlaying()) {
      if (video && muted === null) {
        muted = video.muted;
      }
      if (video && !video.muted) {
        video.muted = true;
      }
      cover();
    } else if (muted !== null) {
      if (video) { video.muted = muted; }
      muted = null;
      document.querySelectorAll('.ditto-ad-cover').forEach(note => note.remove());
    }
  };
  window.__dittoAdState = () => ({ad: adPlaying(), muted: muted !== null,
                                  covered: !!document.querySelector('.ditto-ad-cover')});

  setInterval(() => {
    update();
    if (document.hidden || Date.now() - lastClick < 2000) { return; }
    const button = findSkipButton();
    if (button) {
      lastClick = Date.now();
      window.webkit?.messageHandlers?.dittoSkip?.postMessage(button);
    }
  }, 400);
})();

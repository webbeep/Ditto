// Presses YouTube's "Skip" button as soon as an ad offers it. Injected into
// YouTube pages in an isolated world; reports the button's centre (CSS
// pixels) to the app, which clicks it with real mouse input (Shield.swift).
// Ads that cannot be skipped play as usual.
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
  setInterval(() => {
    if (document.hidden || Date.now() - lastClick < 2000) { return; }
    const button = findSkipButton();
    if (button) {
      lastClick = Date.now();
      window.webkit?.messageHandlers?.dittoSkip?.postMessage(button);
    }
  }, 700);
})();

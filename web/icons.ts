// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Line icons (24px grid, 1.75 stroke, round caps), drawn for Ditto in the
// style of Lucide. Constant markup only: nothing user-provided goes in here.

const PATHS = {
  // The Ditto mark: the typographic ditto mark (〃), "the same again".
  logo: '<rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" stroke="none"/>' +
        '<path d="M10 7.5 8.5 16.5M15.5 7.5 14 16.5" stroke="var(--logo-ink, #fff)" stroke-width="2.4"/>',
  newChat: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>' +
           '<path d="M18.4 3.6a1.9 1.9 0 0 1 2.7 2.7L12.5 15l-3.5 1 1-3.5z"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  models: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/>' +
          '<path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  hybrid: '<path d="M12 3 4 7.5l8 4.5 8-4.5z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.5 8 4.5 8-4.5"/>',
  decider: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/>' +
           '<path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/>',
  llm: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  off: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  link: '<path d="M9 15 15 9"/><path d="M11 6.5 12.6 5a4.2 4.2 0 0 1 6 6L17.1 12.5"/>' +
        '<path d="M13 17.5 11.4 19a4.2 4.2 0 0 1-6-6L6.9 11.5"/>',
  type: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  scroll: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  retry: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  eject: '<path d="M5 17h14"/><path d="M12 5 5 13h14z"/>',
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
        '<path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  shield: '<path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  memory: '<path d="M4 7h16v10H4z"/><path d="M8 7v10M12 7v10M16 7v10"/>',
  // Ditto at work: a four-point spark and a small one.
  sparkle: '<path d="M10 3.5c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6z"/>' +
           '<path d="M18 14.5c.3 1.6 1.2 2.5 2.8 2.8-1.6.3-2.5 1.2-2.8 2.8-.3-1.6-1.2-2.5-2.8-2.8 1.6-.3 2.5-1.2 2.8-2.8z"/>',
  trending: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>' +
       '<circle cx="12" cy="12" r="3"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function iconSvg(name: IconName, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

export function icon(name: IconName, size = 16): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = iconSvg(name, size);
  return template.content.firstElementChild as SVGElement;
}

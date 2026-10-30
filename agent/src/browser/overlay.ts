// What the user sees while the agent is in control of a tab: a thin
// accent frame around the page, a cursor that travels to each target before
// it is clicked, a ring on the target, and a one-line status pill.
//
// Runs inside the page (serialized like collectSnapshot), lives in a shadow
// root on <html>, never takes pointer events, and puts its text in CSS
// generated content so page snapshots never read it. Respects
// prefers-reduced-motion.

export type OverlayCommand =
    {op: 'status', text: string}|
    {op: 'point', id: number}|
    {op: 'clear'};

// The overlay's nodes, kept on the page's window between calls.
interface OverlayState {
  host: HTMLElement;
  pill: HTMLElement;
  ring: HTMLElement;
  cursor: SVGSVGElement;
}

export function runOverlay(command: OverlayCommand): {x: number, y: number}|null {
  const KEY = '__dittoOverlay';
  const w = window as unknown as Record<string, OverlayState|undefined>;
  if (command.op === 'clear') {
    w[KEY]?.host.remove();
    delete w[KEY];
    return null;
  }
  let state = w[KEY];
  if (!state) {
    const host = document.createElement('div');
    host.setAttribute('data-ditto-overlay', '');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; ' +
        'pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host { --accent: #6366f1; }
      .frame { position: fixed; inset: 0; border-radius: 10px;
               box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 24px rgba(99,102,241,.25); }
      .cursor { position: fixed; left: 0; top: 0; width: 18px; height: 18px;
                transform: translate(-40px, -40px);
                transition: transform 160ms cubic-bezier(.2,.8,.2,1); }
      .ring { position: fixed; border-radius: 6px; opacity: 0;
              box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px rgba(99,102,241,.18);
              transition: all 160ms cubic-bezier(.2,.8,.2,1); }
      .pill { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
              display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 10px;
              border-radius: 999px; background: rgba(9,9,11,.88); color: #fafafa;
              font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, sans-serif;
              box-shadow: 0 4px 16px rgba(0,0,0,.18); max-width: 70vw; }
      .pill::after { content: attr(data-status); white-space: nowrap;
                     overflow: hidden; text-overflow: ellipsis; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
             animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) {
        .cursor, .ring { transition: none; } .dot { animation: none; }
      }
`;
    const part = (cls: string) => {
      const el = document.createElement('div');
      el.className = cls;
      return el;
    };
    const pill = part('pill');
    pill.setAttribute('data-status', '');
    pill.append(part('dot'));
    const ring = part('ring');
    const svg = 'http://www.w3.org/2000/svg';
    const cursor = document.createElementNS(svg, 'svg');
    cursor.setAttribute('class', 'cursor');
    cursor.setAttribute('viewBox', '0 0 24 24');
    cursor.setAttribute('aria-hidden', 'true');
    const arrow = document.createElementNS(svg, 'path');
    for (const [name, value] of Object.entries({
           d: 'M4 3l15 8-6.5 1.6L10 19z', fill: '#09090b', stroke: '#fafafa',
           'stroke-width': '1.5', 'stroke-linejoin': 'round',
         })) {
      arrow.setAttribute(name, value);
    }
    cursor.append(arrow);
    root.append(style, part('frame'), ring, cursor, pill);
    document.documentElement.append(host);
    state = {host, pill, ring, cursor};
    w[KEY] = state;
  }
  if (command.op === 'status') {
    state.pill.setAttribute('data-status', command.text);
    return null;
  }
  const el = document.querySelector(`[data-ditto-id="${command.id}"]`);
  if (!el) {
    return null;
  }
  el.scrollIntoView({block: 'center', inline: 'center'});
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  state.cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  Object.assign(state.ring.style, {
    left: `${r.left - 3}px`, top: `${r.top - 3}px`,
    width: `${r.width + 6}px`, height: `${r.height + 6}px`, opacity: '1',
  });
  return {x, y};
}

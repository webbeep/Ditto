// Ditto agent extension, service worker (preview build).
//
// Owns the connection to the native host that runs the model runtime. The
// runtime starts when the agent panel asks for it and stops when nothing has
// used it for IDLE_MS, when the panel asks (mode Off / "Disable all
// models"), or when the browser quits (the host sees its input close).
// An open native port also keeps this service worker alive.

const HOST = 'app.ditto.runtime';
const IDLE_MS = 10 * 60 * 1000;

let native: chrome.runtime.Port|null = null;
let pending: Array<(reply: any) => void> = [];
let panels = 0;
let idleTimer: ReturnType<typeof setTimeout>|undefined;

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});

function connect(): chrome.runtime.Port {
  if (native) {
    return native;
  }
  const port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(reply => pending.shift()?.(reply));
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? 'model runtime stopped';
    for (const resolve of pending) {
      resolve({ok: false, error});
    }
    pending = [];
    native = null;
  });
  native = port;
  return port;
}

function call(message: object): Promise<any> {
  return new Promise(resolve => {
    pending.push(resolve);
    connect().postMessage(message);
  });
}

function stop() {
  clearTimeout(idleTimer);
  // Closing the port ends the host, which stops the runtime.
  native?.disconnect();
  native = null;
  pending = [];
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  if (panels === 0 && native) {
    idleTimer = setTimeout(stop, IDLE_MS);
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') {
    return;
  }
  ++panels;
  clearTimeout(idleTimer);
  port.onDisconnect.addListener(() => {
    --panels;
    scheduleIdleStop();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'runtime-start') {
    call({cmd: 'start', marginMb: message.marginMb}).then(sendResponse);
    return true;
  }
  if (message?.type === 'runtime-stop') {
    stop();
    sendResponse({ok: true});
  }
  return false;
});

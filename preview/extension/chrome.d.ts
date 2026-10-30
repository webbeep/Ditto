// The subset of the extension APIs the Ditto agent extension uses.

declare namespace chrome {
  export namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {addListener(listener: (message: any) => void): void};
      onDisconnect: {addListener(listener: () => void): void};
    }
    const lastError: {message?: string}|undefined;
    function connect(info: {name: string}): Port;
    function connectNative(application: string): Port;
    function sendMessage(message: unknown): Promise<any>;
    const onConnect: {addListener(listener: (port: Port) => void): void};
    const onMessage: {
      addListener(listener: (message: any, sender: unknown,
                             sendResponse: (response: unknown) => void) => boolean|void): void,
    };
  }
  export namespace sidePanel {
    function setPanelBehavior(behavior: {openPanelOnActionClick: boolean}): Promise<void>;
  }
  export namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      active: boolean;
      lastAccessed?: number;
    }
    function query(query: {active?: boolean, lastFocusedWindow?: boolean}): Promise<Tab[]>;
    function create(properties: {url: string, active: boolean}): Promise<Tab>;
    function update(tabId: number, properties: {url: string}): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
  }
  // `debugger` is a reserved word; @types/chrome uses the same alias.
  export namespace _debugger {
    interface Debuggee {
      tabId?: number;
    }
    function attach(target: Debuggee, version: string): Promise<void>;
    function detach(target: Debuggee): Promise<void>;
    function sendCommand(target: Debuggee, method: string, params?: object): Promise<any>;
    const onDetach: {addListener(listener: (source: Debuggee, reason: string) => void): void};
  }
  export {_debugger as debugger};
  export namespace search {
    function query(options: {text: string, tabId?: number}): Promise<void>;
  }
  export namespace system.memory {
    function getInfo(): Promise<{capacity: number, availableCapacity: number}>;
  }
}

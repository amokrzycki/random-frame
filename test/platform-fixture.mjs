import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

export const flush = () => new Promise((resolve) => setImmediate(resolve));
const unpairedStatus = {
  supported: true,
  paired: false,
  state: "unpaired",
  lastSuccessAt: null,
  lastSuccessRevision: null,
  dirty: false,
  lastErrorCategory: null,
  snapshotSchemaVersion: 1,
  thisDeviceId: null,
  devices: [],
};
export const android = {
  platform: "android",
  sync: true,
  desktopWindowControls: false,
  updater: false,
  imageClipboard: false,
};
export const desktop = {
  platform: "linux",
  sync: true,
  desktopWindowControls: true,
  updater: true,
  imageClipboard: true,
};

// Starts the client app against a fake native side. `capabilities` is what the native side reports, or a
// function that may throw to simulate a failed IPC call.
export async function startApp(t, capabilities) {
  const document = new FakeDocument([
    ...ids,
    "window-controls",
    "window-minimize",
    "window-maximize",
    "window-close",
    "window-maximize-icon",
    "window-restore-icon",
    "titlebar-drag-region",
  ]);
  const removed = [];
  for (const id of ["window-controls"]) document.querySelector(`#${id}`).remove = () => removed.push(id);
  document.querySelector("#titlebar-drag-region").setAttribute("data-tauri-drag-region", "");
  const localStorage = new FakeStorage();
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  const window = new EventTarget();
  window.setTimeout = () => 0;
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, {
    document,
    localStorage,
    performance: { getEntriesByType: () => [{ type: "back_forward" }] },
    sessionStorage: new FakeStorage(),
    window,
  });
  const originalError = console.error;
  console.error = () => {
    // Failure paths log; keep test output quiet.
  };
  t.after(() => {
    console.error = originalError;
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const invocations = [];
  let nextCallback = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback: () => nextCallback++,
    async invoke(command) {
      invocations.push(command);
      if (command === "get_platform_capabilities")
        return typeof capabilities === "function" ? capabilities() : capabilities;
      if (command === "get_user_preferences" || command === "set_user_preferences")
        return { theme: null, historyPageSize: null };
      if (command === "get_history" || command === "import_session_history") return { history: [], index: -1 };
      if (command === "get_favorites") return [];
      if (command === "startup_sync" || command === "get_sync_status") return unpairedStatus;
      if (command === "load_thumbnail_cache") return [];
      return null;
    },
  };
  await import(`../dist/test-client/app.js?test=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 4; i++) await flush();
  return { invocations, removed, get: (id) => document.querySelector(`#${id}`) };
}

export const desktopOnly = /^plugin:(updater|process|window)\|/;

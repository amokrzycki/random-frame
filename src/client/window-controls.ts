import { getCurrentWindow } from "@tauri-apps/api/window";

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing required element: ${selector}`);
  return result;
}

const appWindow = getCurrentWindow();
const minimize = element<HTMLButtonElement>("#window-minimize");
const maximize = element<HTMLButtonElement>("#window-maximize");
const close = element<HTMLButtonElement>("#window-close");
const maximizeIcon = element<SVGElement>("#window-maximize-icon");
const restoreIcon = element<SVGElement>("#window-restore-icon");
const announcer = element<HTMLElement>("#announcer");
let syncRevision = 0;

function reportFailure(): void {
  announcer.textContent = "Window action failed";
}

function clearFailure(): void {
  announcer.textContent = "";
}

async function syncMaximizedState(): Promise<void> {
  const revision = ++syncRevision;
  try {
    const maximized = await appWindow.isMaximized();
    if (revision !== syncRevision) return;
    maximizeIcon.toggleAttribute("hidden", maximized);
    restoreIcon.toggleAttribute("hidden", !maximized);
    const action = maximized ? "Restore" : "Maximize";
    maximize.setAttribute("aria-label", `${action} window`);
    maximize.title = action;
    clearFailure();
  } catch {
    reportFailure();
  }
}

minimize.addEventListener("click", () => appWindow.minimize().then(clearFailure).catch(reportFailure));
maximize.addEventListener("click", () => {
  appWindow.toggleMaximize().then(syncMaximizedState).catch(reportFailure);
});
close.addEventListener("click", () => appWindow.close().then(clearFailure).catch(reportFailure));

appWindow
  .onResized(() => void syncMaximizedState())
  .then((unlisten) => {
    window.addEventListener("pagehide", () => void unlisten(), { once: true });
    return syncMaximizedState();
  })
  .catch(reportFailure);

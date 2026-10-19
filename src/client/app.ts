import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bindAndroidNavigation, exitApp } from "./android-navigation.js";
import { bindCollectionEvents } from "./collections-dialog.js";
import { bindDialogChromeEvents, closeDialog, onDialogClosed, openDialog, refreshDialogBoundary } from "./dialogs.js";
import { elements } from "./elements.js";
import { getSavedLibrary } from "./favorites.js";
import { bindFrameActionEvents } from "./frame-actions.js";
import { initializeThumbnailCache, persistThumbnails, releaseAllBlobs } from "./frame-cache.js";
import { bindNavigationEvents, goTo } from "./frame-loader.js";
import { bindHistoryDialogEvents, pendingHistoryClearKey } from "./history-dialog.js";
import { bindMenu } from "./menu.js";
import { historyFromStorage, shouldShowEntryDialog } from "./navigation.js";
import { bindNearbyEvents } from "./nearby-dialog.js";
import {
  commitHistoryClear,
  completeStateImports,
  getHistory,
  importSessionHistory,
  prepareHistoryClear,
} from "./persistence.js";
import { getPlatformCapabilities, initializePlatform } from "./platform.js";
import { bindShortcutsEvents } from "./shortcuts.js";
import { bindStageEvents, setState, showError, syncControls } from "./stage.js";
import { bindStatsDialogEvents, migrateLegacyStats } from "./stats-dialog.js";
import { getSyncStatus } from "./sync-api.js";
import { bindSyncDialogEvents, runStartupSync } from "./sync-dialog.js";
import { toast } from "./toast.js";
import { bindTooltipEvents } from "./tooltip.js";
import { bindChangelogEvents, checkForUpdate, showPendingChangelog } from "./update.js";
import { initializeUserPreferences, updateUserPreferences } from "./user-preferences.js";
import { applyHistory, applySavedLibrary, setViewerLoading, state } from "./viewer-state.js";
import { initializeWindowControls } from "./window-controls.js";

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
try {
  if (shouldShowEntryDialog(localStorage.getItem(entryStorageKey))) openDialog(elements.entryDialog);
} catch {
  openDialog(elements.entryDialog);
}

let startupSyncStarted = false;
let lastStartupSync = 0;
// An Android app is resumed far more often than it is started, so returning to it syncs too.
const FOREGROUND_SYNC_INTERVAL_MS = 15 * 60_000;

let checkingReturn = false;
async function syncOnReturn(): Promise<void> {
  if (document.hidden || !startupSyncStarted || checkingReturn) return;
  checkingReturn = true;
  try {
    const status = await getSyncStatus();
    if (!status.dirty && Date.now() - lastStartupSync < FOREGROUND_SYNC_INTERVAL_MS) return;
    lastStartupSync = Date.now();
    await runStartupSync();
  } catch {
    // A later focus or explicit sync can retry; native persistence remains durable.
  } finally {
    checkingReturn = false;
  }
}
let initializing = false;

async function initialize(): Promise<void> {
  // Try again re-enters here; a double click must not run two loads, and Sync starts once.
  if (initializing) return;
  initializing = true;
  setViewerLoading(true);
  syncControls();
  try {
    let pendingHistoryClear = false;
    try {
      pendingHistoryClear = localStorage.getItem(pendingHistoryClearKey) === "true";
    } catch {
      // History still loads when browser storage is unavailable.
    }
    if (pendingHistoryClear) {
      const requestId = await prepareHistoryClear(true);
      await commitHistoryClear(requestId);
      try {
        localStorage.removeItem(pendingHistoryClearKey);
      } catch {
        // The already completed clear is safe to repeat on the next launch.
      }
    }
    let [snapshot, favorites] = await Promise.all([getHistory(), getSavedLibrary()]);
    state.historyLoadFailed = false;
    applySavedLibrary(favorites);
    await initializeThumbnailCache();
    await persistThumbnails();
    const legacy = historyFromStorage(sessionStorage.getItem(storageKey));
    snapshot = await importSessionHistory(
      legacy.history.map((item) => ({
        source: "prntsc",
        id: item.id,
        sourcePageUrl: `https://prnt.sc/${item.id}`,
        viewedAt: Date.now(),
      })),
      legacy.index,
    );
    sessionStorage.removeItem(storageKey);
    await migrateLegacyStats();
    await initializeUserPreferences();
    await completeStateImports();

    applyHistory({ ...snapshot, index: -1 });
    setViewerLoading(false);
    syncControls();
    // The stage starts blank, so a restored frame never flashes the first-draw prompt on launch.
    if (snapshot.index >= 0) await goTo(snapshot.index);
    else {
      setState("empty");
      if (!elements.entryDialog.open) elements.draw.focus();
    }
    await setViewerLoading(false);
    syncControls();
    if (!startupSyncStarted && getPlatformCapabilities().sync) {
      startupSyncStarted = true;
      lastStartupSync = Date.now();
      void runStartupSync();
    }
  } catch (error) {
    console.error(error);
    state.historyLoadFailed = true;
    setViewerLoading(false);
    showError(error, initialize, -1, {
      title: "Your history couldn’t be loaded.",
      message: "Random Frame could not read its saved data. Try again, and restart the app if it keeps failing.",
    });
    syncControls();
  } finally {
    initializing = false;
  }
}

elements.leave.addEventListener("click", async () => {
  try {
    // Leave works even before the platform answers; only Android, once known, needs another way out.
    let android = false;
    try {
      android = getPlatformCapabilities().platform === "android";
    } catch {
      // Not answered yet: closing the window is the desktop behavior.
    }
    if (android) await exitApp();
    else await getCurrentWindow().close();
  } catch {
    elements.announcer.textContent = "Random Frame could not close the window.";
  }
});

elements.entryConsent.addEventListener("change", () => {
  elements.entryButton.disabled = !elements.entryConsent.checked;
});
elements.entryDialog.addEventListener("close", () => {
  onDialogClosed();
  elements.draw.focus();
});
elements.entryButton.addEventListener("click", () => {
  if (!elements.entryConsent.checked) return;
  try {
    localStorage.setItem(entryStorageKey, "accepted");
  } catch {
    // Ignore errors, the dialog will just show again next time
  }
  closeDialog(elements.entryDialog);
});

window.addEventListener("pagehide", releaseAllBlobs);

bindMenu(elements.toolsMenu, elements.toolsMenuButton, "below");
bindMenu(elements.frameMenu, elements.frameMenuButton, "above");

document.querySelectorAll<HTMLAnchorElement>(".external-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (link.getAttribute("aria-disabled") !== "true" && link.href) void openUrl(link.href);
  });
});

// Arrow keys move along a toolbar's own buttons (not the menu items its popovers hold). They stop here,
// so ← and → do not also step through frames while a toolbar button has focus.
function bindToolbar(toolbar: HTMLElement): void {
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>(":scope > button")];
  let active = buttons[0];
  const sync = (): void => {
    const available = buttons.filter((button) => !button.disabled && !button.hidden);
    if (!active || !available.includes(active)) active = available[0];
    for (const button of buttons) button.tabIndex = button === active ? 0 : -1;
  };
  toolbar.addEventListener("focusin", (event) => {
    if (buttons.includes(event.target as HTMLButtonElement)) {
      active = event.target as HTMLButtonElement;
      sync();
    }
  });
  if (typeof MutationObserver !== "undefined")
    new MutationObserver(sync).observe(toolbar, {
      attributes: true,
      subtree: true,
      attributeFilter: ["disabled", "hidden"],
    });
  sync();
  toolbar.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.shiftKey) return;
    const available = buttons.filter((button) => !button.disabled && !button.hidden);
    const current = available.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? available.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    active = available[next];
    sync();
    active?.focus();
  });
}

bindToolbar(elements.mastheadTools);
bindToolbar(elements.infoActions);
bindTooltipEvents();
bindDialogChromeEvents();
bindChangelogEvents();
bindStageEvents();
bindNavigationEvents();
bindNearbyEvents();
bindFrameActionEvents();
bindCollectionEvents();
bindHistoryDialogEvents();
bindStatsDialogEvents();
bindSyncDialogEvents();
bindShortcutsEvents();
// A successful jump has done its job; a rejected number keeps the menu and its message open.
elements.jumpForm.addEventListener("submit", () => {
  if (elements.jumpForm.hidden) elements.frameMenu.hidePopover?.();
});

let platformReady = false;

// Nothing platform-specific starts until the native side says what this build supports.
async function start(): Promise<void> {
  if (!platformReady) {
    state.historyLoadFailed = true;
    let platform: Awaited<ReturnType<typeof initializePlatform>>;
    try {
      platform = await initializePlatform();
    } catch (error) {
      console.error(error);
      showError(error, start, -1, {
        title: "Random Frame couldn’t start.",
        message: "Try again, and restart the app if it keeps failing.",
      });
      syncControls();
      return;
    }
    platformReady = true;
    initializeWindowControls(platform.desktopWindowControls);
    refreshDialogBoundary();
    if (platform.platform === "android") {
      void bindAndroidNavigation();
    }
    if (platform.sync) {
      document.addEventListener("visibilitychange", syncOnReturn);
      window.addEventListener("focus", syncOnReturn);
    }
    elements.syncButton.hidden = !platform.sync;
    elements.copyImage.hidden = !platform.imageClipboard;
    void showPendingChangelog();
    if (platform.updater) void checkForUpdate();
  }
  await initialize();
}

syncControls();
void start();

document.addEventListener("theme-choice", (event) => {
  const theme = (event as CustomEvent).detail as "system" | "light" | "dark";
  void updateUserPreferences({ theme }).catch(() => toast.error("Theme could not be saved. Try again."));
});

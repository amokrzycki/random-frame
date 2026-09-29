import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bindDialogChromeEvents, closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { getFavorites } from "./favorites.js";
import { bindFrameActionEvents } from "./frame-actions.js";
import { releaseAllBlobs } from "./frame-cache.js";
import { bindNavigationEvents, goTo } from "./frame-loader.js";
import { bindHistoryDialogEvents, pendingHistoryClearKey } from "./history-dialog.js";
import { historyFromStorage, shouldShowEntryDialog } from "./navigation.js";
import { clearHistory, getHistory, recordHistoryItem, selectHistoryItem } from "./persistence.js";
import { bindShortcutsEvents } from "./shortcuts.js";
import { bindStageEvents, setState, showError, syncControls } from "./stage.js";
import { bindStatsDialogEvents, migrateLegacyStats } from "./stats-dialog.js";
import { bindSyncDialogEvents, refreshAfterStartup, runStartupSync } from "./sync-dialog.js";
import { checkForUpdate } from "./update.js";
import { applyFavorites, applyHistory, state } from "./viewer-state.js";

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
try {
  if (shouldShowEntryDialog(localStorage.getItem(entryStorageKey))) openDialog(elements.entryDialog);
} catch {
  openDialog(elements.entryDialog);
}

let startupSyncStarted = false;
let initializing = false;

async function initialize(): Promise<void> {
  // Try again re-enters here; a double click must not run two loads, and Sync starts once.
  if (initializing) return;
  initializing = true;
  state.loading = true;
  syncControls();
  try {
    let pendingHistoryClear = false;
    try {
      pendingHistoryClear = localStorage.getItem(pendingHistoryClearKey) === "true";
    } catch {
      // History still loads when browser storage is unavailable.
    }
    if (pendingHistoryClear) {
      await clearHistory();
      try {
        localStorage.removeItem(pendingHistoryClearKey);
      } catch {
        // The already completed clear is safe to repeat on the next launch.
      }
    }
    if (!startupSyncStarted) {
      startupSyncStarted = true;
      void runStartupSync();
    }
    let [snapshot, favorites] = await Promise.all([getHistory(), getFavorites()]);
    applyFavorites(favorites);
    const legacy = historyFromStorage(sessionStorage.getItem(storageKey));
    if (!snapshot.history.length && legacy.history.length) {
      for (const item of legacy.history) {
        snapshot = await recordHistoryItem(
          {
            source: "prntsc",
            id: item.id,
            sourcePageUrl: `https://prnt.sc/${item.id}`,
            viewedAt: Date.now(),
          },
          true,
        );
      }
      if (legacy.index >= 0) snapshot = await selectHistoryItem(legacy.index);
    }
    sessionStorage.removeItem(storageKey);
    applyHistory({ ...snapshot, index: -1 });
    state.loading = false;
    syncControls();
    // The stage starts blank, so a restored frame never flashes the first-draw prompt on launch.
    if (snapshot.index >= 0) await goTo(snapshot.index);
    else {
      setState("empty");
      if (!elements.entryDialog.open) elements.draw.focus();
    }
    await refreshAfterStartup();
    syncControls();
  } catch (error) {
    console.error(error);
    state.loading = false;
    showError(error, initialize, -1, {
      title: "Your history couldn't be loaded",
      message: "Random Frame could not read its saved data. Try again, and restart the app if it keeps failing.",
    });
    syncControls();
  } finally {
    initializing = false;
  }
}

elements.leave.addEventListener("click", async () => {
  try {
    await getCurrentWindow().close();
  } catch {
    elements.announcer.textContent = "Random Frame could not close the window";
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

// Pinned under its button when it opens. Closing on pick, before the item's own handler runs, returns focus
// to the button so a dialog opened from the menu hands it back there.
elements.toolsMenu.addEventListener("beforetoggle", (event) => {
  if ((event as ToggleEvent).newState !== "open") return;
  const rect = elements.toolsMenuButton.getBoundingClientRect();
  elements.toolsMenu.style.top = `${rect.bottom + 6}px`;
  elements.toolsMenu.style.right = `${window.innerWidth - rect.right}px`;
});
elements.toolsMenu.addEventListener("click", () => elements.toolsMenu.hidePopover?.(), true);
elements.toolsMenuButton.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  elements.toolsMenu.showPopover();
  const items = elements.toolsMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
  (event.key === "ArrowDown" ? items[0] : items[items.length - 1])?.focus();
});
elements.toolsMenu.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...elements.toolsMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
});

document.querySelectorAll<HTMLAnchorElement>(".external-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (link.getAttribute("aria-disabled") !== "true" && link.href) void openUrl(link.href);
  });
});

bindDialogChromeEvents();
bindStageEvents();
bindNavigationEvents();
bindFrameActionEvents();
bindHistoryDialogEvents();
bindStatsDialogEvents();
bindSyncDialogEvents();
bindShortcutsEvents();

syncControls();
void initialize();
void checkForUpdate();
void migrateLegacyStats();

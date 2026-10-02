import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bindDialogChromeEvents, closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { getFavorites } from "./favorites.js";
import { bindFrameActionEvents } from "./frame-actions.js";
import { initializeThumbnailCache, persistThumbnails, releaseAllBlobs } from "./frame-cache.js";
import { bindNavigationEvents, goTo } from "./frame-loader.js";
import { bindHistoryDialogEvents, pendingHistoryClearKey } from "./history-dialog.js";
import { historyFromStorage, shouldShowEntryDialog } from "./navigation.js";
import { clearHistory, getHistory, recordHistoryItem, selectHistoryItem } from "./persistence.js";
import { bindShortcutsEvents } from "./shortcuts.js";
import { bindStageEvents, setState, showError, syncControls } from "./stage.js";
import { bindStatsDialogEvents, migrateLegacyStats } from "./stats-dialog.js";
import { bindSyncDialogEvents, refreshAfterStartup, runStartupSync } from "./sync-dialog.js";
import { bindTooltipEvents } from "./tooltip.js";
import { bindChangelogEvents, checkForUpdate, showPendingChangelog } from "./update.js";
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
    state.historyLoadFailed = false;
    applyFavorites(favorites);
    await initializeThumbnailCache();
    await persistThumbnails();
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
    state.historyLoadFailed = true;
    state.loading = false;
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
    await getCurrentWindow().close();
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

// Pinned to its button when it opens: the tools menu drops from the titlebar, the frame menu rises from the
// info line. Closing on pick, before the item's own handler runs, returns focus to the button so a dialog
// opened from the menu hands it back there. Items marked data-keep hold the menu open.
const menuItems = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>("button:not(:disabled):not([hidden]), a[href]")].filter(
    (item) => !item.closest("[hidden]"),
  );

function bindMenu(menu: HTMLElement, button: HTMLElement, placement: "below" | "above"): void {
  menu.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    const rect = button.getBoundingClientRect();
    if (placement === "below") {
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    } else {
      menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      menu.style.left = window.innerWidth <= 480 ? "auto" : `${rect.left}px`;
      menu.style.right = window.innerWidth <= 480 ? "12px" : "auto";
    }
  });
  menu.addEventListener(
    "click",
    (event) => {
      const item = (event.target as Element).closest?.("button, a");
      if (item && !item.hasAttribute("data-keep")) menu.hidePopover?.();
    },
    true,
  );
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    menu.showPopover();
    const items = menuItems(menu);
    (event.key === "ArrowDown" ? items[0] : items[items.length - 1])?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (event.target as Element).tagName === "INPUT")
      return;
    const items = menuItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  });
}

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
bindFrameActionEvents();
bindHistoryDialogEvents();
bindStatsDialogEvents();
bindSyncDialogEvents();
bindShortcutsEvents();
// A successful jump has done its job; a rejected number keeps the menu and its message open.
elements.jumpForm.addEventListener("submit", () => {
  if (elements.jumpForm.hidden) elements.frameMenu.hidePopover?.();
});

syncControls();
void initialize();
void showPendingChangelog();
void checkForUpdate();
void migrateLegacyStats();

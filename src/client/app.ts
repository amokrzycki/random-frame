import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bindDialogChromeEvents, closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { getFavorites } from "./favorites.js";
import { bindFrameActionEvents } from "./frame-actions.js";
import { releaseAllBlobs } from "./frame-cache.js";
import { bindNavigationEvents, goTo } from "./frame-loader.js";
import { bindHistoryDialogEvents } from "./history-dialog.js";
import { historyFromStorage, shouldShowEntryDialog } from "./navigation.js";
import { getHistory, recordHistoryItem, selectHistoryItem } from "./persistence.js";
import { bindShortcutsEvents } from "./shortcuts.js";
import { bindStageEvents, setState, showError, syncControls } from "./stage.js";
import { bindStatsDialogEvents, migrateLegacyStats } from "./stats-dialog.js";
import { checkForUpdate } from "./update.js";
import { applyFavorites, applyHistory, state } from "./viewer-state.js";

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";

try {
  if (shouldShowEntryDialog(localStorage.getItem(entryStorageKey))) openDialog(elements.entryDialog);
} catch {
  openDialog(elements.entryDialog);
}

async function initialize(): Promise<void> {
  try {
    let [snapshot, favorites] = await Promise.all([getHistory(), getFavorites()]);
    applyFavorites(favorites);
    const legacy = historyFromStorage(sessionStorage.getItem(storageKey));
    if (!snapshot.history.length && legacy.history.length) {
      for (const item of legacy.history) {
        snapshot = await recordHistoryItem({
          source: "prntsc",
          id: item.id,
          sourcePageUrl: `https://prnt.sc/${item.id}`,
          viewedAt: Date.now(),
        });
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
  } catch (error) {
    state.loading = false;
    showError(error, initialize);
    syncControls();
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
bindShortcutsEvents();

syncControls();
void initialize();
void checkForUpdate();
void migrateLegacyStats();

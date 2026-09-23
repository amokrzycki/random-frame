import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { clearFavorites } from "./favorites.js";
import { blobKey, blobs, clearThumbnails, releaseAllBlobs, thumbnails } from "./frame-cache.js";
import { goTo, loadById } from "./frame-loader.js";
import { historyPage, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import { clearHistory } from "./persistence.js";
import { setState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applyFavorites, isFavorite, state } from "./viewer-state.js";

type HistoryFilter = "all" | "favorites";
// In memory only: every open starts on All, like the page index.
let filter: HistoryFilter = "all";

// index is the frame's place in history, or -1 for a favorite whose history was cleared.
interface GridEntry {
  source: string;
  id: string;
  index: number;
}

// Favorites view the same grid through a filter; order follows when each was starred.
function gridEntries(): GridEntry[] {
  if (filter === "all") return state.history.map(({ source, id }, index) => ({ source, id, index }));
  const indexes = new Map(state.history.map((item, index) => [blobKey(item.source, item.id), index]));
  return state.favorites.map(({ source, id }) => ({ source, id, index: indexes.get(blobKey(source, id)) ?? -1 }));
}

// Only the current page is laid out, so the dialog never builds thousands of DOM nodes.
function renderHistoryPage(): void {
  const entries = gridEntries();
  const favoritesView = filter === "favorites";
  const view = historyPage(entries.length, state.pageIndex, state.pageSize);
  state.pageIndex = view.page;
  elements.historyFilterAll.setAttribute("aria-pressed", String(!favoritesView));
  elements.historyFilterFavorites.setAttribute("aria-pressed", String(favoritesView));
  elements.historyClear.hidden = favoritesView;
  elements.historyClearFavorites.hidden = !favoritesView || !state.favorites.length;
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !entries.length;
  elements.historyEmpty.hidden = Boolean(entries.length);
  elements.historyEmptyTitle.textContent = favoritesView ? "No favorites yet." : "No saved frames yet.";
  elements.historyEmptyDetail.textContent = favoritesView
    ? "Press F on a frame to keep it here."
    : "Draw a frame to begin your history.";
  elements.historyBody.scrollTop = 0;

  // Below the smallest page size neither paging nor the size choice changes anything.
  elements.historyPager.hidden = entries.length <= PAGE_SIZES[0];
  elements.historyPagerNav.hidden = view.pages === 1;
  elements.historyRange.textContent = entries.length
    ? `${favoritesView ? "Favorites" : "Frames"} ${(view.start + 1).toLocaleString("en-US")}–${view.end.toLocaleString("en-US")} of ${entries.length.toLocaleString("en-US")}`
    : "";
  elements.historyPage.textContent = `Page ${view.page + 1} of ${view.pages}`;
  elements.historyPageSize.value = String(state.pageSize);
  const focused = document.activeElement;
  elements.historyPagePrevious.disabled = view.page === 0;
  elements.historyPageNext.disabled = view.page === view.pages - 1;
  // A focused step button that becomes disabled would drop keyboard focus to the document.
  if (focused === elements.historyPagePrevious && view.page === 0) elements.historyPageNext.focus();
  if (focused === elements.historyPageNext && view.page === view.pages - 1) elements.historyPagePrevious.focus();

  for (const { source, id, index: itemIndex } of entries.slice(view.start, view.end)) {
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    const favorite = favoritesView || isFavorite({ source, id });
    button.className = "history-item";
    button.type = "button";
    const name = itemIndex >= 0 ? `Show frame ${itemIndex + 1}, ${id}` : `Show frame ${id}`;
    button.setAttribute("aria-label", favorite ? `${name}, favorite` : name);
    if (itemIndex >= 0 && itemIndex === state.index) button.setAttribute("aria-current", "true");
    if (favorite) button.dataset.favorite = "";
    const key = blobKey(source, id);
    const thumbnailSrc = blobs.get(key)?.url ?? thumbnails.get(key) ?? "";
    if (!thumbnailSrc) button.setAttribute("data-empty", "true");
    image.src = thumbnailSrc;
    image.alt = "";
    image.loading = "lazy";
    label.textContent = itemIndex >= 0 ? `${itemIndex + 1} · ${id}` : id;
    button.append(image, label);
    button.addEventListener("click", () => {
      closeDialog(elements.historyDialog);
      void (itemIndex >= 0 ? goTo(itemIndex) : loadById(id, source));
    });
    elements.historyGrid.append(button);
  }
}

// Open where the visitor is: the page holding the shown frame, else the newest page.
function showCurrentPage(): void {
  const entries = gridEntries();
  const position = state.index >= 0 ? entries.findIndex((entry) => entry.index === state.index) : -1;
  state.pageIndex = pageOf(position >= 0 ? position : entries.length - 1, state.pageSize);
  renderHistoryPage();
}

function showFilter(next: HistoryFilter): void {
  filter = next;
  showCurrentPage();
}

export function openHistory(): void {
  if (state.loading) return;
  elements.historyClear.disabled = !state.history.length;
  filter = "all";
  showCurrentPage();
  openDialog(elements.historyDialog);
}

function showHistoryPage(page: number): void {
  state.pageIndex = page;
  renderHistoryPage();
}

function changePageSize(): void {
  // Keep the first frame of the current page in view across the size change.
  const firstShown = historyPage(gridEntries().length, state.pageIndex, state.pageSize).start;
  state.pageSize = parsePageSize(elements.historyPageSize.value);
  savePageSize(localStorage, state.pageSize);
  showHistoryPage(pageOf(firstShown, state.pageSize));
}

async function clearSavedHistory(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  syncControls();
  try {
    await clearHistory();
    state.history.length = 0;
    state.index = -1;
    releaseAllBlobs();
    clearThumbnails();
    elements.image.src = "";
    elements.image.alt = "";
    setState("empty");
    // The History button no longer leads anywhere useful; the next step is a draw.
    state.historyReturnFocus = elements.draw;
    closeDialog(elements.historyDialog);
    toast.success("History cleared");
  } catch (error) {
    toast.error(describeError(error, "History could not be cleared. Try again.").message);
  } finally {
    state.loading = false;
    syncControls();
  }
}

async function clearSavedFavorites(): Promise<void> {
  if (state.loading) return;
  try {
    await clearFavorites();
    applyFavorites([]);
    syncControls();
    renderHistoryPage();
    // The clear button just hid itself; keep focus inside the dialog.
    elements.historyClose.focus();
    toast.success("Favorites cleared");
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be cleared. Try again.").message);
  }
}

// Hold-to-confirm: the fill's transitionend (dialogs.css) is the confirmation; releasing early cancels.
function bindHoldToClear(button: HTMLButtonElement, what: string, clear: () => Promise<void>): () => void {
  let pressed = false;
  let armedUntil = 0;
  const startHold = (): void => {
    pressed = true;
    if (state.loading || button.disabled) return;
    button.dataset.holding = "";
  };
  const stopHold = (): boolean => {
    if (!("holding" in button.dataset)) return false;
    delete button.dataset.holding;
    return true;
  };
  const reset = (): void => {
    stopHold();
    pressed = false;
    armedUntil = 0;
  };
  button.addEventListener("pointerdown", (event) => {
    if (event.button === 0) startHold();
  });
  button.addEventListener("keydown", (event) => {
    if (!event.repeat && (event.key === " " || event.key === "Enter")) startHold();
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) {
    button.addEventListener(type, () => {
      if (stopHold()) toast.info(`Hold to clear ${what}`);
    });
  }
  button.addEventListener("transitionend", (event) => {
    if (event.pseudoElement !== "::before" || !stopHold()) return;
    void clear();
  });
  // Assistive tech activates with a bare click (no pointer or key press first) and can't hold,
  // so a second activation within 5s confirms instead.
  button.addEventListener("click", () => {
    if (pressed) {
      pressed = false;
      return;
    }
    if (Date.now() < armedUntil) {
      armedUntil = 0;
      void clear();
      return;
    }
    armedUntil = Date.now() + 5000;
    elements.announcer.textContent = `Activate again to clear ${what}`;
  });
  // Hiding mid-hold cancels the fill without a transitionend; drop the hold silently.
  elements.historyDialog.addEventListener("close", reset);
  return reset;
}

export function bindHistoryDialogEvents(): void {
  elements.historyButton.addEventListener("click", openHistory);
  elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
  const resetHistoryHold = bindHoldToClear(elements.historyClear, "history", clearSavedHistory);
  const resetFavoritesHold = bindHoldToClear(elements.historyClearFavorites, "favorites", clearSavedFavorites);
  elements.historyFilterAll.addEventListener("click", () => {
    resetHistoryHold();
    resetFavoritesHold();
    showFilter("all");
  });
  elements.historyFilterFavorites.addEventListener("click", () => {
    resetHistoryHold();
    resetFavoritesHold();
    showFilter("favorites");
  });
  elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(state.pageIndex - 1));
  elements.historyPageNext.addEventListener("click", () => showHistoryPage(state.pageIndex + 1));
  elements.historyPageSize.addEventListener("change", changePageSize);
  elements.historyDialog.addEventListener("close", () => {
    // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
    onDialogClosed();
    state.historyReturnFocus.focus();
    state.historyReturnFocus = elements.historyButton;
  });
}

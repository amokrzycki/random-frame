import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { clearFavorites } from "./favorites.js";
import { blobKey, blobs, clearThumbnails, ensureThumbnail, releaseAllBlobs, thumbnails } from "./frame-cache.js";
import { goTo, loadById } from "./frame-loader.js";
import { historyPage, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import { clearHistory } from "./persistence.js";
import { setState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applyFavorites, isFavorite, state } from "./viewer-state.js";

type HistoryDialogTab = "history" | "favourites";
const tabStorageKey = "random-frame-history-dialog-tab";
let filter: HistoryDialogTab = "history";
let batchRunning = false;
let viewVersion = 0;

function loadTab(): HistoryDialogTab {
  try {
    return localStorage.getItem(tabStorageKey) === "favourites" ? "favourites" : "history";
  } catch {
    return "history";
  }
}

function saveTab(tab: HistoryDialogTab): void {
  try {
    localStorage.setItem(tabStorageKey, tab);
  } catch {
    // Storage may be unavailable; the current dialog still uses the selected tab.
  }
}

// index is the frame's place in history, or -1 for a favorite whose history was cleared.
interface GridEntry {
  source: string;
  id: string;
  index: number;
}

// Favorites view the same grid through a filter; order follows when each was starred.
function gridEntries(): GridEntry[] {
  if (filter === "history") return state.history.map(({ source, id }, index) => ({ source, id, index }));
  const indexes = new Map(state.history.map((item, index) => [blobKey(item.source, item.id), index]));
  return state.favorites.map(({ source, id }) => ({ source, id, index: indexes.get(blobKey(source, id)) ?? -1 }));
}

function updateThumbnailAction(entries: GridEntry[], start: number, end: number): void {
  const missing = entries.slice(start, end).some(({ source, id }) => !thumbnails.get(blobKey(source, id)));
  elements.historyThumbnailAction.hidden = !missing;
  elements.historyThumbnails.disabled = batchRunning || !missing;
  if (!missing && document.activeElement === elements.historyThumbnails) elements.historyClose.focus();
  elements.historyThumbnails.textContent = batchRunning ? "Downloading thumbnails…" : "Download missing thumbnails";
}

// Only the current page is laid out, so the dialog never builds thousands of DOM nodes.
function renderHistoryPage(): void {
  const entries = gridEntries();
  const favoritesView = filter === "favourites";
  const view = historyPage(entries.length, state.pageIndex, state.pageSize);
  state.pageIndex = view.page;
  elements.historyFilterAll.setAttribute("aria-pressed", String(!favoritesView));
  elements.historyFilterFavorites.setAttribute("aria-pressed", String(favoritesView));
  elements.historyClear.hidden = favoritesView;
  elements.historyClearFavorites.hidden = !favoritesView || !state.favorites.length;
  elements.historyClearGroup.hidden = favoritesView;
  elements.historyClearFavoritesGroup.hidden = !favoritesView || !state.favorites.length;
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
  const visible = entries.slice(view.start, view.end);
  updateThumbnailAction(entries, view.start, view.end);
  const focused = document.activeElement;
  elements.historyPagePrevious.disabled = view.page === 0;
  elements.historyPageNext.disabled = view.page === view.pages - 1;
  // A focused step button that becomes disabled would drop keyboard focus to the document.
  if (focused === elements.historyPagePrevious && view.page === 0) elements.historyPageNext.focus();
  if (focused === elements.historyPageNext && view.page === view.pages - 1) elements.historyPagePrevious.focus();

  for (const { source, id, index: itemIndex } of visible) {
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

function showFilter(next: HistoryDialogTab): void {
  viewVersion++;
  filter = next;
  saveTab(next);
  showCurrentPage();
}

export function openHistory(): void {
  if (state.loading) return;
  elements.historyClear.disabled = !state.history.length;
  viewVersion++;
  filter = loadTab();
  showCurrentPage();
  openDialog(elements.historyDialog);
}

function showHistoryPage(page: number): void {
  viewVersion++;
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

async function downloadMissingThumbnails(): Promise<void> {
  if (batchRunning) return;
  const entries = gridEntries();
  const { start, end } = historyPage(entries.length, state.pageIndex, state.pageSize);
  const pending = [
    ...new Map(
      entries
        .slice(start, end)
        .filter(({ source, id }) => !thumbnails.get(blobKey(source, id)))
        .map((entry) => [blobKey(entry.source, entry.id), entry] as const),
    ).values(),
  ];
  if (!pending.length) return;
  batchRunning = true;
  const version = viewVersion;
  let completed = 0;
  let failed = 0;
  elements.historyThumbnails.disabled = true;
  elements.historyThumbnails.textContent = `0 / ${pending.length}`;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, pending.length) }, async () => {
      while (next < pending.length) {
        const entry = pending[next++];
        if (!entry) break;
        try {
          if (!(await ensureThumbnail(entry))) failed++;
        } catch {
          failed++;
        }
        completed++;
        if (viewVersion === version && elements.historyDialog.open)
          elements.historyThumbnails.textContent = `${completed} / ${pending.length}`;
      }
    }),
  );
  batchRunning = false;
  if (viewVersion === version && elements.historyDialog.open) renderHistoryPage();
  else if (elements.historyDialog.open) {
    const current = gridEntries();
    const page = historyPage(current.length, state.pageIndex, state.pageSize);
    updateThumbnailAction(current, page.start, page.end);
  }
  if (failed) toast.error(`${failed} thumbnail${failed === 1 ? "" : "s"} could not be downloaded.`);
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
    clearThumbnails(state.favorites);
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
    // The favorites filter now hides its clear action; keep focus inside the dialog.
    elements.historyClose.focus();
    toast.success("Favorites cleared");
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be cleared. Try again.").message);
  }
}

// Confirmation stays explicit for pointer, keyboard, and assistive-technology activation.
function bindClearConfirmation(button: HTMLButtonElement, clear: () => Promise<void>): () => void {
  let armedUntil = 0;
  let confirmationTimeout: ReturnType<typeof setTimeout>;
  const initialLabel = button.textContent.trim();
  const reset = (): void => {
    clearTimeout(confirmationTimeout);
    armedUntil = 0;
    button.textContent = initialLabel;
  };
  button.addEventListener("click", () => {
    if (state.loading || button.disabled) return;
    if (Date.now() < armedUntil) {
      reset();
      void clear();
      return;
    }
    armedUntil = Date.now() + 5000;
    button.textContent = `Confirm ${initialLabel.toLowerCase()}`;
    elements.announcer.textContent = `Activate again to ${initialLabel.toLowerCase()}`;
    confirmationTimeout = setTimeout(() => {
      if (Date.now() >= armedUntil) reset();
    }, 5000);
  });
  elements.historyDialog.addEventListener("close", reset);
  return reset;
}

export function bindHistoryDialogEvents(): void {
  elements.historyButton.addEventListener("click", openHistory);
  elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
  const resetHistoryConfirmation = bindClearConfirmation(elements.historyClear, clearSavedHistory);
  const resetFavoritesConfirmation = bindClearConfirmation(elements.historyClearFavorites, clearSavedFavorites);
  elements.historyFilterAll.addEventListener("click", () => {
    resetHistoryConfirmation();
    resetFavoritesConfirmation();
    showFilter("history");
  });
  elements.historyFilterFavorites.addEventListener("click", () => {
    resetHistoryConfirmation();
    resetFavoritesConfirmation();
    showFilter("favourites");
  });
  elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(state.pageIndex - 1));
  elements.historyPageNext.addEventListener("click", () => showHistoryPage(state.pageIndex + 1));
  elements.historyPageSize.addEventListener("change", changePageSize);
  elements.historyThumbnails.addEventListener("click", () => void downloadMissingThumbnails());
  elements.historyDialog.addEventListener("close", () => {
    viewVersion++;
    // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
    onDialogClosed();
    state.historyReturnFocus.focus();
    state.historyReturnFocus = elements.historyButton;
  });
}

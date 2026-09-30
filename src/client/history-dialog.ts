import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { clearFavorites, type FavoriteItem, toggleFavorite } from "./favorites.js";
import {
  blobKey,
  blobs,
  clearThumbnails,
  ensureThumbnail,
  persistThumbnails,
  releaseAllBlobs,
  thumbnails,
} from "./frame-cache.js";
import { goTo, loadById } from "./frame-loader.js";
import { historyPage, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import { clearHistory, type HistoryItem, removeHistoryItem, restoreHistoryItem } from "./persistence.js";
import { getViewState, setState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applyFavorites, applyHistory, isFavorite, state } from "./viewer-state.js";

type HistoryDialogTab = "history" | "favourites";
export const pendingHistoryClearKey = "random-frame-history-clear-pending";
let filter: HistoryDialogTab = "history";
const THUMBNAIL_CONCURRENCY = 3;
const SAVE_DELAY_MS = 600;

// index is the frame's place in history, or -1 for a favorite whose history was cleared.
interface GridEntry {
  source: string;
  id: string;
  index: number;
}

// Newest first, so page 1 is always full and the short page falls at the oldest end. Favorites view the same
// grid through a filter, ordered by when each was starred.
function gridEntries(): GridEntry[] {
  if (filter === "history") return state.history.map(({ source, id }, index) => ({ source, id, index })).reverse();
  const indexes = new Map(state.history.map((item, index) => [blobKey(item.source, item.id), index]));
  return state.favorites
    .map(({ source, id }) => ({ source, id, index: indexes.get(blobKey(source, id)) ?? -1 }))
    .reverse();
}

interface PendingTile {
  button: HTMLElement;
  image: HTMLImageElement;
  source: string;
  id: string;
  started: boolean;
}

// Thumbnails load only for tiles scrolled into view, a few at a time, and are saved in one debounced write.
const failedThumbnails = new Set<string>();
const thumbnailQueue: PendingTile[] = [];
const watched = new Map<Element, PendingTile>();
let thumbnailObserver: IntersectionObserver | undefined;
let activeFetches = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveFailureShown = false;

function stopThumbnailWork(): void {
  thumbnailObserver?.disconnect();
  watched.clear();
  thumbnailQueue.length = 0;
}

function saveThumbnails(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (persistThumbnails() || saveFailureShown) return;
  saveFailureShown = true;
  toast.error("Thumbnails could not be saved locally.");
}

async function loadTile(tile: PendingTile): Promise<void> {
  const key = blobKey(tile.source, tile.id);
  let ok = false;
  try {
    ok = await ensureThumbnail(tile, false);
  } catch {
    // The tile falls back to the striped placeholder.
  }
  const src = thumbnails.get(key);
  tile.button.removeAttribute("data-loading");
  thumbnailObserver?.unobserve(tile.button);
  watched.delete(tile.button);
  if (ok && src) {
    tile.image.src = src;
    saveTimer ??= setTimeout(saveThumbnails, SAVE_DELAY_MS);
  } else {
    failedThumbnails.add(key);
    tile.button.setAttribute("data-empty", "true");
  }
}

function pumpThumbnails(): void {
  while (activeFetches < THUMBNAIL_CONCURRENCY) {
    const tile = thumbnailQueue.shift();
    if (!tile) return;
    tile.started = true;
    activeFetches++;
    void loadTile(tile).finally(() => {
      activeFetches--;
      pumpThumbnails();
    });
  }
}

function watchTiles(tiles: PendingTile[]): void {
  stopThumbnailWork();
  if (!tiles.length) return;
  // Without IntersectionObserver every tile counts as visible; the queue still throttles.
  if (typeof IntersectionObserver === "undefined") {
    thumbnailQueue.push(...tiles);
    pumpThumbnails();
    return;
  }
  thumbnailObserver ??= new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        const tile = watched.get(target);
        if (!tile || tile.started) continue;
        const queued = thumbnailQueue.indexOf(tile);
        if (isIntersecting && queued < 0) thumbnailQueue.push(tile);
        // Scrolled past before its turn: drop it so the queue serves what is on screen.
        else if (!isIntersecting && queued >= 0) thumbnailQueue.splice(queued, 1);
      }
      pumpThumbnails();
    },
    { root: elements.historyBody, rootMargin: "120px 0px" },
  );
  for (const tile of tiles) {
    watched.set(tile.button, tile);
    thumbnailObserver.observe(tile.button);
  }
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
  elements.historyEmptyTitle.textContent = favoritesView ? "No favorites yet." : "No frames drawn yet.";
  elements.historyEmptyDetail.textContent = favoritesView
    ? "Press F on a frame to keep it here."
    : "Draw a frame to begin your history.";
  elements.historyBody.scrollTop = 0;

  // Below the smallest page size neither paging nor the size choice changes anything.
  if (entries.length <= PAGE_SIZES[0]) elements.historyPager.setAttribute("data-compact", "");
  else elements.historyPager.removeAttribute("data-compact");
  elements.historyPagerNav.hidden = view.pages === 1;
  // Frame numbers count down the page, matching the tile captions; favorites carry no numbers, so they count ranks.
  const first = favoritesView ? view.start + 1 : entries.length - view.start;
  const last = favoritesView ? view.end : entries.length - view.end + 1;
  elements.historyRange.textContent = entries.length
    ? `${favoritesView ? "Favorites" : "Frames"} ${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${entries.length.toLocaleString("en-US")}`
    : "";
  elements.historyPage.textContent = `Page ${view.page + 1} of ${view.pages}`;
  elements.historyPageSize.value = String(state.pageSize);
  elements.historyPager.hidden = entries.length <= PAGE_SIZES[0];
  const visible = entries.slice(view.start, view.end);
  const loading: PendingTile[] = [];
  const focused = document.activeElement;
  elements.historyPagePrevious.disabled = view.page === 0;
  elements.historyPageNext.disabled = view.page === view.pages - 1;
  // A focused step button that becomes disabled would drop keyboard focus to the document.
  if (focused === elements.historyPagePrevious && view.page === 0) elements.historyPageNext.focus();
  if (focused === elements.historyPageNext && view.page === view.pages - 1) elements.historyPagePrevious.focus();

  for (const { source, id, index: itemIndex } of visible) {
    const tile = document.createElement("div");
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
    if (!thumbnailSrc && failedThumbnails.has(key)) button.setAttribute("data-empty", "true");
    else if (!thumbnailSrc) {
      button.setAttribute("data-loading", "true");
      loading.push({ button, image, source, id, started: false });
    }
    image.src = thumbnailSrc;
    image.alt = "";
    image.loading = "lazy";
    label.textContent = itemIndex >= 0 ? `${itemIndex + 1} · ${id}` : id;
    button.append(image, label);
    button.addEventListener("click", () => {
      closeDialog(elements.historyDialog);
      void (itemIndex >= 0 ? goTo(itemIndex) : loadById(id, source));
    });
    tile.className = "history-tile";
    tile.append(button);
    // Favorites lists stars, not history, so its tiles have nothing to remove.
    if (!favoritesView && itemIndex >= 0) {
      const remove = document.createElement("button");
      tile.dataset.index = String(itemIndex);
      button.setAttribute("aria-keyshortcuts", "Delete");
      remove.className = "history-tile__remove";
      remove.type = "button";
      remove.tabIndex = 0;
      remove.setAttribute("aria-label", `Remove frame ${itemIndex + 1}, ${id}, from history`);
      remove.dataset.tip = "Remove from history (Delete)";
      remove.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" /></svg>';
      remove.addEventListener("click", () => void removeFromHistory(itemIndex));
      tile.append(remove);
    }
    elements.historyGrid.append(tile);
  }
  watchTiles(loading);
}

// Open where the visitor is: the page holding the shown frame, else the newest page (the first).
function showCurrentPage(): void {
  const entries = gridEntries();
  const position = state.index >= 0 ? entries.findIndex((entry) => entry.index === state.index) : -1;
  state.pageIndex = pageOf(Math.max(position, 0), state.pageSize);
  renderHistoryPage();
}

function showFilter(next: HistoryDialogTab): void {
  filter = next;
  showCurrentPage();
}

export function openHistory(returnFocus?: HTMLElement): void {
  if (state.loading) return;
  if (returnFocus) state.historyReturnFocus = returnFocus;
  elements.historyClear.disabled = !state.history.length;
  failedThumbnails.clear();
  saveFailureShown = false;
  filter = "history";
  showCurrentPage();
  openDialog(elements.historyDialog);
  const position = gridEntries().findIndex((entry) => entry.index === state.index) - state.pageIndex * state.pageSize;
  (elements.historyGrid.children[position]?.children[0] as HTMLElement | undefined)?.focus();
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

const sameFrame = (a: HistoryItem, b: HistoryItem | undefined): boolean => a.source === b?.source && a.id === b.id;

// Keeps the shown frame selected by identity, since removing or restoring another shifts every index.
function applyHistoryKeepingShown(snapshot: { history: HistoryItem[]; index: number }, shown?: HistoryItem): void {
  applyHistory({ ...snapshot, index: shown ? snapshot.history.findIndex((item) => sameFrame(item, shown)) : -1 });
}

function focusTile(position: number): void {
  const tiles = elements.historyGrid.children;
  const tile = tiles[Math.min(position, tiles.length - 1)]?.children[0] as HTMLElement | undefined;
  (tile ?? elements.historyClose).focus();
}

let removing = false;

// Removing the shown frame lands on the one that takes its place, else the newest. Favorites, Seen IDs and
// Stats are untouched, as with Clear. The removal is written at once; Undo restores the frame where it was.
export async function removeFromHistory(index: number): Promise<void> {
  const frame = state.history[index];
  if (!frame || state.loading || removing) return;
  removing = true;
  const wasShown = index === state.index;
  const position = gridEntries().findIndex((entry) => entry.index === index) - state.pageIndex * state.pageSize;
  try {
    const { snapshot, orderAt } = await removeHistoryItem(frame.source, frame.id);
    applyHistoryKeepingShown(snapshot, wasShown ? undefined : state.history[state.index]);
    if (wasShown && !state.history.length) {
      elements.image.src = "";
      elements.image.alt = "";
      setState("empty");
    } else if (wasShown) await goTo(Math.min(index, state.history.length - 1));
    const landed = state.history[state.index];
    syncControls();
    if (elements.historyDialog.open) {
      renderHistoryPage();
      focusTile(position);
    } else if (!state.history.length) elements.draw.focus();
    toast.info("Removed from history", {
      label: "Undo",
      run: () => void undoRemoval(frame, orderAt, wasShown ? { landed } : undefined),
    });
  } catch (error) {
    toast.error(describeError(error, "That frame could not be removed. Try again.").message);
  } finally {
    removing = false;
  }
}

// The shown frame returns to the stage only while the visitor is still on the frame that replaced it.
async function undoRemoval(
  frame: HistoryItem,
  orderAt: number,
  shownBefore?: { landed: HistoryItem | undefined },
): Promise<void> {
  // goTo ignores calls while a frame loads, so restoring now would leave the frame off the stage.
  if (shownBefore && state.loading) {
    toast.error("A frame is loading. Try Undo again in a moment.");
    return;
  }
  try {
    const shown = state.history[state.index];
    const snapshot = await restoreHistoryItem(frame, orderAt);
    applyHistoryKeepingShown(snapshot, shown);
    syncControls();
    if (elements.historyDialog.open) renderHistoryPage();
    if (shownBefore && (shown ? sameFrame(shown, shownBefore.landed) : !shownBefore.landed))
      await goTo(snapshot.history.findIndex((item) => sameFrame(item, frame)));
  } catch (error) {
    toast.error(describeError(error, "That frame could not be restored. Try again.").message);
  }
}

async function clearSavedHistory(): Promise<void> {
  if (state.loading) return;
  const previousHistory = [...state.history];
  const previousIndex = state.index;
  const previousView = getViewState();
  state.loading = true;
  let durable = false;
  try {
    localStorage.setItem(pendingHistoryClearKey, "true");
    durable = true;
  } catch {
    // Without a restart marker, finish the clear before showing success.
  }
  if (!durable) {
    try {
      await clearHistory();
    } catch (error) {
      state.loading = false;
      syncControls();
      toast.error(describeError(error, "History could not be cleared. Try again.").message);
      return;
    }
  }
  state.history.length = 0;
  state.index = -1;
  setState("empty");
  syncControls();
  state.historyReturnFocus = elements.draw;
  closeDialog(elements.historyDialog);
  const finishClear = (): void => {
    releaseAllBlobs();
    clearThumbnails(state.favorites);
    elements.image.src = "";
    elements.image.alt = "";
    state.loading = false;
    syncControls();
  };
  if (!durable) {
    finishClear();
    toast.success("History cleared");
    return;
  }
  const restore = (): void => {
    try {
      localStorage.removeItem(pendingHistoryClearKey);
    } catch {
      // Storage was unavailable when the clear began.
    }
    state.history.splice(0, state.history.length, ...previousHistory);
    state.index = previousIndex;
    setState(previousView);
    state.loading = false;
    syncControls();
  };
  toast.info("History cleared. Drawing paused while Undo is available.", { label: "Undo", run: restore }, () => {
    void clearHistory().then(
      () => {
        try {
          localStorage.removeItem(pendingHistoryClearKey);
        } catch {
          // The next launch may repeat the already completed clear.
        }
        finishClear();
      },
      (error: unknown) => {
        restore();
        toast.error(describeError(error, "History could not be cleared. Try again.").message);
      },
    );
  });
}

async function clearSavedFavorites(): Promise<void> {
  if (state.loading) return;
  const previous = [...state.favorites];
  try {
    await clearFavorites();
    applyFavorites([]);
    syncControls();
    renderHistoryPage();
    // The favorites filter now hides its clear action; keep focus inside the dialog.
    elements.historyClose.focus();
    if (!previous.length) return toast.success("Favorites cleared");
    toast.info("Favorites cleared", { label: "Undo", run: () => void restoreFavorites(previous) });
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be cleared. Try again.").message);
  }
}

// Re-stars each frame with its original date, so the list keeps its order. Stops at the first failure.
async function restoreFavorites(items: FavoriteItem[]): Promise<void> {
  try {
    for (const item of items) if (!isFavorite(item)) applyFavorites(await toggleFavorite(item));
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be restored. Try again.").message);
  }
  syncControls();
  if (elements.historyDialog.open) renderHistoryPage();
  for (const item of state.favorites) void ensureThumbnail(item).catch(() => false);
}

// Confirmation stays explicit for pointer, keyboard, and assistive-technology activation.
// The group shows its hint only while armed; the button keeps aria-describedby either way.
// Arming ignores clicks for ARM_DELAY_MS, so a double-click cannot confirm what it just armed.
const ARM_DELAY_MS = 500;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function bindClearConfirmation(
  button: HTMLButtonElement,
  group: HTMLElement,
  clear: () => Promise<void>,
  count: () => string,
): () => void {
  let armedAt = 0;
  let armedUntil = 0;
  let confirmationTimeout: ReturnType<typeof setTimeout>;
  let armTimeout: ReturnType<typeof setTimeout>;
  const initialLabel = button.textContent.trim();
  const reset = (): void => {
    clearTimeout(confirmationTimeout);
    clearTimeout(armTimeout);
    armedAt = armedUntil = 0;
    group.removeAttribute("data-armed");
    group.removeAttribute("data-arming");
    button.removeAttribute("aria-disabled");
    button.textContent = initialLabel;
  };
  button.addEventListener("click", () => {
    if (state.loading || button.disabled) return;
    const now = Date.now();
    if (now < armedUntil) {
      if (now - armedAt < ARM_DELAY_MS) return;
      reset();
      void clear();
      return;
    }
    armedAt = now;
    armedUntil = now + 5000;
    group.setAttribute("data-armed", "");
    group.setAttribute("data-arming", "");
    button.setAttribute("aria-disabled", "true");
    armTimeout = setTimeout(() => {
      group.removeAttribute("data-arming");
      button.removeAttribute("aria-disabled");
    }, ARM_DELAY_MS);
    button.textContent = `Clear · ${count()}`;
    elements.announcer.textContent = `Activate again to ${initialLabel.toLowerCase()}: ${count()}`;
    confirmationTimeout = setTimeout(() => {
      if (Date.now() >= armedUntil) reset();
    }, 5000);
  });
  elements.historyDialog.addEventListener("close", reset);
  return reset;
}

export function bindHistoryDialogEvents(): void {
  elements.historyTool.addEventListener("click", () => openHistory(elements.historyTool));
  elements.removeFrame.addEventListener("click", () => void removeFromHistory(state.index));
  elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
  const resetHistoryConfirmation = bindClearConfirmation(
    elements.historyClear,
    elements.historyClearGroup,
    clearSavedHistory,
    () => `${plural(state.history.length, "frame")} and streak`,
  );
  const resetFavoritesConfirmation = bindClearConfirmation(
    elements.historyClearFavorites,
    elements.historyClearFavoritesGroup,
    clearSavedFavorites,
    () => plural(state.favorites.length, "favorite"),
  );
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
  elements.historyGrid.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const tiles = elements.historyGrid.children;
    const tile = (event.target as Element).closest<HTMLElement>(".history-tile");
    const current = Array.prototype.indexOf.call(tiles, tile) as number;
    if (current < 0) return;
    if (event.key === "Delete") {
      event.preventDefault();
      if (tile?.dataset.index && !event.repeat) void removeFromHistory(Number(tile.dataset.index));
      return;
    }
    const columns = getComputedStyle(elements.historyGrid).gridTemplateColumns.split(" ").length;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[
      event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
    ];
    if (delta === undefined) return;
    event.preventDefault();
    (tiles[current + delta]?.children[0] as HTMLElement | undefined)?.focus();
  });
  elements.historyDialog.addEventListener("close", () => {
    stopThumbnailWork();
    if (saveTimer) saveThumbnails();
    // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
    onDialogClosed();
    state.historyReturnFocus.focus();
    state.historyReturnFocus = elements.toolsMenuButton;
  });
}

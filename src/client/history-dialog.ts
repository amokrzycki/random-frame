import { bindCollectionActions, closeCollectionActions } from "./collection-actions.js";
import { openCollectionManagement, openCollections, restoreSavedUndo } from "./collections-dialog.js";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import {
  clearSavedFrames,
  collectionLabels,
  newOperationId,
  operationKey,
  type RemoveSavedRequest,
  savedFrameRef,
} from "./favorites.js";
import {
  blobKey,
  blobs,
  clearThumbnails,
  ensureThumbnail,
  persistThumbnails,
  releaseAllBlobs,
  thumbnailFor,
} from "./frame-cache.js";
import { goTo, loadById } from "./frame-loader.js";
import { historyPage, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import {
  commitHistoryClear,
  type HistoryItem,
  prepareHistoryClear,
  removeHistoryItem,
  restoreHistoryItem,
  type ViewStamp,
} from "./persistence.js";
import { bindSavedSwitcher, closeSavedSwitcher, renderSavedSwitcher } from "./saved-switcher.js";
import { setState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { updateUserPreferences } from "./user-preferences.js";
import {
  applyHistory,
  applySavedLibrary,
  filteredSavedItems,
  isFavorite,
  mutateSavedLibrary,
  refreshPersistedView,
  setViewerLoading,
  state,
  uncollectedItems,
} from "./viewer-state.js";

type HistoryDialogTab = "history" | "favourites";
export const pendingHistoryClearKey = "random-frame-history-clear-pending";
let filter: HistoryDialogTab = "history";
const views: Record<HistoryDialogTab, { page: number; scroll: number; initialized: boolean }> = {
  history: { page: 0, scroll: 0, initialized: false },
  favourites: { page: 0, scroll: 0, initialized: false },
};

function rememberView(): void {
  views[filter].page = state.pageIndex;
  views[filter].scroll = elements.historyBody.scrollTop;
}

const THUMBNAIL_CONCURRENCY = 3;
const SAVE_DELAY_MS = 600;

// index is the frame's place in history, or -1 for a favorite whose history was cleared.
interface GridEntry {
  source: string;
  id: string;
  index: number;
  timestamp: number;
}

// Newest first, so page 1 is always full and the short page falls at the oldest end. Favorites view the same
// grid through a filter, ordered by when each was starred.
function gridEntries(): GridEntry[] {
  if (filter === "history")
    return state.history
      .map(({ source, id, viewedAt }, index) => ({ source, id, index, timestamp: viewedAt }))
      .reverse();
  const indexes = new Map(state.history.map((item, index) => [blobKey(item.source, item.id), index]));
  return filteredSavedItems()
    .map(({ source, id, addedAt }) => ({
      source,
      id,
      index: indexes.get(blobKey(source, id)) ?? -1,
      timestamp: addedAt,
    }))
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

async function saveThumbnails(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if ((await persistThumbnails()) || saveFailureShown) return;
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
  const src = thumbnailFor(key);
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
function renderHistoryPage(scroll = elements.historyBody.scrollTop): void {
  const entries = gridEntries();
  const favoritesView = filter === "favourites";
  const view = historyPage(entries.length, state.pageIndex, state.pageSize);
  if (view.page !== state.pageIndex) scroll = 0;
  state.pageIndex = view.page;
  elements.historyFilterAll.setAttribute("aria-selected", String(!favoritesView));
  elements.historyFilterAll.tabIndex = favoritesView ? -1 : 0;
  elements.historyFilterFavorites.setAttribute("aria-selected", String(favoritesView));
  elements.historyFilterFavorites.tabIndex = favoritesView ? 0 : -1;
  elements.historyBody.setAttribute(
    "aria-labelledby",
    favoritesView ? "history-filter-favorites" : "history-filter-all",
  );
  if (!favoritesView) {
    closeSavedSwitcher(false);
    closeCollectionActions(false);
  }
  elements.savedToolbar.hidden = !favoritesView;
  renderSavedFilter();
  elements.historyClear.hidden = favoritesView;
  elements.historyClearFavorites.hidden = !favoritesView || state.savedFilter !== "all" || !state.favorites.length;
  elements.historyClearGroup.hidden = favoritesView;
  elements.historyClearFavoritesGroup.hidden = !favoritesView || state.savedFilter !== "all" || !state.favorites.length;
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !entries.length;
  elements.historyEmpty.hidden = Boolean(entries.length);
  let emptyTitle = "Draw a frame to begin your history.";
  let emptyDetail = "Draw a frame to begin your history.";
  if (favoritesView) {
    if (state.savedFilter === "all") {
      emptyTitle = "No saved frames yet.";
      emptyDetail = "Save a frame to keep it here.";
    } else {
      emptyTitle = "This collection is empty.";
      emptyDetail = "In All saved, use a frame’s collection button to add it here.";
    }
  }
  elements.historyEmptyTitle.textContent = emptyTitle;
  elements.historyEmptyDetail.textContent = emptyDetail;

  // Below the smallest page size neither paging nor the size choice changes anything.
  if (entries.length <= PAGE_SIZES[0]) elements.historyPager.setAttribute("data-compact", "");
  else elements.historyPager.removeAttribute("data-compact");
  elements.historyPagerNav.hidden = view.pages === 1;
  // Favorites count ranks; All keeps the original history frame numbers.
  const first = favoritesView ? view.start + 1 : entries.length - view.start;
  const last = favoritesView ? view.end : entries.length - view.end + 1;
  let rangeText = "";
  if (entries.length) {
    const label = favoritesView ? "Saved frames" : "Frames";
    rangeText = `${label} ${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${entries.length.toLocaleString("en-US")}`;
  }
  elements.historyRange.textContent = rangeText;
  elements.historyPage.textContent = `of ${view.pages}`;
  elements.historyPageInput.value = String(view.page + 1);
  elements.historyPageInput.max = String(view.pages);
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

  for (const [position, { source, id, index: itemIndex, timestamp }] of visible.entries()) {
    const tile = document.createElement("div");
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    const favorite = favoritesView || isFavorite({ source, id });
    button.className = "history-item";
    button.type = "button";
    const number = favoritesView ? view.start + position + 1 : itemIndex + 1;
    const name = `Show ${favoritesView ? "saved frame" : "frame"} ${number}, ${id}`;
    button.setAttribute("aria-label", favorite ? `${name}, saved` : name);
    if (itemIndex >= 0 && itemIndex === state.index) button.setAttribute("aria-current", "true");
    if (favorite) button.dataset.favorite = "";
    const key = blobKey(source, id);
    const thumbnailSrc = blobs.get(key)?.url ?? thumbnailFor(key) ?? "";
    if (!thumbnailSrc && failedThumbnails.has(key)) button.setAttribute("data-empty", "true");
    else if (!thumbnailSrc) {
      button.setAttribute("data-loading", "true");
      loading.push({ button, image, source, id, started: false });
    }
    image.src = thumbnailSrc;
    image.alt = "";
    image.loading = "lazy";
    label.textContent = `${number} · ${id}`;
    const date = new Date(timestamp);
    const time = document.createElement("time");
    const day = document.createElement("span");
    const clock = document.createElement("span");
    time.className = "history-item__time";
    time.id = `history-time-${position}`;
    time.dateTime = date.toISOString();
    day.textContent = date.toLocaleDateString();
    clock.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    time.append(day, clock);
    button.setAttribute("aria-describedby", time.id);
    button.append(image, label, time);
    button.addEventListener("click", () => {
      if (state.loading) return;
      state.navigationMode = favorite ? "favourites" : "history";
      state.navigationSavedFilter = favoritesView ? state.savedFilter : "all";
      state.historyTab = state.navigationMode;
      syncControls();
      rememberView();
      closeDialog(elements.historyDialog);
      void (itemIndex >= 0 ? goTo(itemIndex) : loadById(id, source));
    });
    tile.className = "history-tile";
    tile.append(button);
    if (favoritesView) {
      const organize = document.createElement("button");
      organize.type = "button";
      organize.dataset.frameId = id;
      organize.dataset.frameSource = source;
      organize.className = "history-tile__collections";
      organize.dataset.tip = "Assign to collections";
      organize.innerHTML =
        '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 5.5h5l1.5-2h6.5v11h-13z" /><path d="M6 9h6M9 6v6" /></svg>';
      organize.setAttribute("aria-label", `Collections for ${id}`);
      organize.setAttribute("aria-haspopup", "dialog");
      organize.addEventListener("click", () => {
        const item = state.favorites.find((x) => x.source === source && x.id === id);
        if (item)
          openCollections(
            item,
            state.savedFilter !== "all" && state.savedFilter !== "none" ? state.savedFilter : undefined,
          );
      });
      tile.append(organize);
    }
    // History removal remains separate from removing a global save.
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
  elements.historyBody.scrollTop = scroll;
  views[filter].page = view.page;
  views[filter].scroll = scroll;
  watchTiles(loading);
}

// Open where the visitor is: the page holding the shown frame, else the newest page (the first).
function showCurrentPage(): void {
  const entries = gridEntries();
  const position = state.index >= 0 ? entries.findIndex((entry) => entry.index === state.index) : -1;
  state.pageIndex = pageOf(Math.max(position, 0), state.pageSize);
  renderHistoryPage(0);
}

function showFilter(next: HistoryDialogTab): void {
  if (state.loading) return;
  if (filter === next) {
    renderHistoryPage();
    return;
  }
  rememberView();
  filter = next;
  state.historyTab = next;
  restoreView();
  elements.historyBody.dataset.tabTransition = next;
}

function restoreView(): void {
  const view = views[filter];
  if (view.initialized) {
    state.pageIndex = view.page;
    renderHistoryPage(view.scroll);
  } else {
    showCurrentPage();
    view.initialized = true;
  }
}

export function openHistory(returnFocus?: HTMLElement): void {
  if (state.loading) return;
  delete elements.historyBody.dataset.tabTransition;
  if (returnFocus) state.historyReturnFocus = returnFocus;
  elements.historyClear.disabled = !state.history.length;
  failedThumbnails.clear();
  saveFailureShown = false;
  filter = state.historyTab;
  if (state.historyReset) {
    views.history.initialized = false;
    state.historyReset = false;
  }
  const returning = views[filter].initialized;
  restoreView();
  const scroll = views[filter].scroll;
  openDialog(elements.historyDialog);
  // A closed dialog has no layout. Restore synchronously after show(), before the first paint.
  elements.historyBody.scrollTop = scroll;
  const position = gridEntries().findIndex((entry) => entry.index === state.index) - state.pageIndex * state.pageSize;
  const selectedTab = filter === "history" ? elements.historyFilterAll : elements.historyFilterFavorites;
  const current = elements.historyGrid.children[position]?.children[0] as HTMLElement | undefined;
  (returning ? selectedTab : (current ?? selectedTab)).focus({ preventScroll: true });
}

function showHistoryPage(page: number): void {
  state.pageIndex = page;
  renderHistoryPage(0);
}

function changePageSize(): void {
  // Keep the first frame of the current page in view across the size change.
  const firstShown = historyPage(gridEntries().length, state.pageIndex, state.pageSize).start;
  const oldSize = state.pageSize;
  state.pageSize = parsePageSize(elements.historyPageSize.value);
  for (const view of Object.values(views)) {
    view.page = pageOf(view.page * oldSize, state.pageSize);
    view.scroll = 0;
  }
  savePageSize(state.pageSize);
  void updateUserPreferences({ historyPageSize: state.pageSize }).catch(() =>
    toast.error("Page size could not be saved. Try again."),
  );
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
  setViewerLoading(true);
  syncControls();
  const wasShown = index === state.index;
  const position = gridEntries().findIndex((entry) => entry.index === index) - state.pageIndex * state.pageSize;
  try {
    const { snapshot, orderAt, lastView } = await removeHistoryItem(frame.source, frame.id);
    applyHistoryKeepingShown(snapshot, wasShown ? undefined : state.history[state.index]);
    setViewerLoading(false);
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
      run: () => undoRemoval(frame, orderAt, lastView, wasShown ? { landed } : undefined),
    });
  } catch (error) {
    toast.error(describeError(error, "That frame could not be removed. Try again.").message);
  } finally {
    removing = false;
    setViewerLoading(false);
    syncControls();
  }
}

// The shown frame returns to the stage only while the visitor is still on the frame that replaced it.
async function undoRemoval(
  frame: HistoryItem,
  orderAt: number,
  lastView: ViewStamp,
  shownBefore?: { landed: HistoryItem | undefined },
): Promise<boolean> {
  if (state.loading || removing) {
    toast.error("A frame is loading. Undo is still available when it finishes.");
    return false;
  }
  setViewerLoading(true);
  syncControls();
  try {
    const shown = state.history[state.index];
    const snapshot = await restoreHistoryItem(frame, orderAt, lastView);
    applyHistoryKeepingShown(snapshot, shown);
    setViewerLoading(false);
    syncControls();
    if (elements.historyDialog.open) {
      renderHistoryPage();
      const position = gridEntries().findIndex((item) => item.source === frame.source && item.id === frame.id);
      focusTile(position - state.pageIndex * state.pageSize);
    }
    if (shownBefore && (shown ? sameFrame(shown, shownBefore.landed) : !shownBefore.landed))
      await goTo(snapshot.history.findIndex((item) => sameFrame(item, frame)));
    return true;
  } catch (error) {
    toast.error(describeError(error, "That frame could not be restored. Undo is still available; try again.").message);
    return false;
  } finally {
    setViewerLoading(false);
    syncControls();
  }
}

// Review never touches durable data. Only the explicit completion prepares the existing crash-safe clear.
let cancelClearReview: (() => void) | undefined;
let clearRequestId: string | undefined;

async function finishClearing(reviewedAt: number, review: ReturnType<typeof toast.review>): Promise<boolean> {
  if (Date.now() - reviewedAt < ARM_DELAY_MS) return false;
  // Once completion starts, closing cannot abandon a durable transaction.
  cancelClearReview = undefined;
  elements.historyDialog.dataset.busy = "true";
  review.confirm("Clear confirmed. Finish clearing will complete it; if it fails, retry here or restart.");
  try {
    clearRequestId ??= await prepareHistoryClear();
    await commitHistoryClear(clearRequestId);
    applyHistory({ history: [], index: -1 });
    releaseAllBlobs();
    await clearThumbnails(state.favorites);
    elements.image.src = "";
    elements.image.alt = "";
    setState("empty");
    setViewerLoading(false);
    syncControls();
    elements.historyClearGroup.removeAttribute("data-armed");
    delete elements.historyDialog.dataset.busy;
    state.historyReturnFocus = elements.draw;
    closeDialog(elements.historyDialog);
    elements.announcer.textContent =
      "History and Stats cleared. Saved frames, collections, Seen IDs and IDs checked are kept.";
    return true;
  } catch (error) {
    // Retry the frozen request; restart finishes an already confirmed durable clear.
    toast.error(
      `${describeError(error, "Clearing could not finish.").message} Choose Finish clearing to retry, or restart.`,
    );
    return false;
  }
}

async function clearSavedHistory(): Promise<void> {
  if (state.loading) return;
  const reviewedAt = Date.now();
  setViewerLoading(true);
  syncControls();
  elements.historyClearGroup.setAttribute("data-armed", "");
  clearRequestId = undefined;
  const cancel = (): void => {
    review.dismiss();
    cancelClearReview = undefined;
    setViewerLoading(false);
    elements.historyClearGroup.removeAttribute("data-armed");
    syncControls();
    elements.historyClear.focus();
    elements.announcer.textContent = "Clear canceled. History and Stats are unchanged.";
  };
  const review = toast.review(
    "Clear pending. History and Stats stay until you finish.",
    {
      label: "Undo",
      run: () => {
        if (!cancelClearReview) return false;
        cancel();
        return true;
      },
    },
    { label: "Finish clearing", run: () => finishClearing(reviewedAt, review) },
  );
  cancelClearReview = cancel;
  elements.announcer.textContent =
    "Clear pending. Choose Undo to keep History and Stats, or Finish clearing to remove them.";
}

let savedClearRequest: RemoveSavedRequest | undefined;
let savedClearAttempted = false;
async function clearSavedFavorites(): Promise<void> {
  if (state.loading || state.savedFilter !== "all") return;
  savedClearRequest ??= { requestId: newOperationId(), frames: state.favorites.map(savedFrameRef) };
  savedClearAttempted = true;
  try {
    const result = await mutateSavedLibrary(async () => {
      const result = await clearSavedFrames(savedClearRequest as RemoveSavedRequest);
      applySavedLibrary(result.library);
      return result;
    });
    savedClearRequest = undefined;
    savedClearAttempted = false;
    syncControls();
    renderHistoryPage();
    elements.historyClose.focus();
    toast.info("Saved frames cleared", { label: "Undo", run: () => restoreSavedUndo(result.undo) });
  } catch (error) {
    if ((error as { kind?: string })?.kind === "stale_saved_frame") {
      savedClearRequest = undefined;
      savedClearAttempted = false;
      try {
        await refreshPersistedView();
      } catch {
        /* Keep the stale-review error. */
      }
      toast.error("A save changed after your review. Review the current saved frames before clearing again.");
    } else toast.error(describeError(error, "Saved frames could not be cleared. Try again.").message);
  }
}

function renderSavedFilter(): void {
  const focused = document.activeElement;
  const labels = collectionLabels(state.library.collections);
  const choices = [
    { value: "all", label: "All saved" },
    ...(uncollectedItems().length ? [{ value: "none", label: "Without a collection" }] : []),
    ...state.library.collections.map((c) => ({
      value: operationKey(c.collectionId),
      label: labels.get(operationKey(c.collectionId)) ?? c.name,
    })),
  ];
  if (!choices.some((c) => c.value === state.savedFilter)) state.savedFilter = "all";
  renderSavedSwitcher(choices, state.savedFilter);
  const collection = state.library.collections.find((c) => operationKey(c.collectionId) === state.savedFilter);
  elements.collectionActionsButton.hidden = elements.collectionActionsButton.disabled = !collection;
  elements.collectionRename.disabled = elements.collectionDelete.disabled = !collection;
  const label = collection
    ? `Collection actions for ${labels.get(state.savedFilter) ?? collection.name}`
    : "Collection actions";
  elements.collectionActionsButton.setAttribute("aria-label", label);
  elements.collectionActionsButton.dataset.tip = label;
  if (!collection) {
    closeCollectionActions(false);
    if (focused === elements.collectionActionsButton || elements.collectionActionsMenu.contains(focused))
      elements.savedFilter.focus();
  }
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
  prepare: () => void,
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
    if (!savedClearAttempted) savedClearRequest = undefined;
    button.removeAttribute("aria-disabled");
    button.textContent = initialLabel;
  };
  button.addEventListener("click", () => {
    if (state.loading || button.disabled) return;
    const now = Date.now();
    if (now < armedUntil) {
      if (now - armedAt < ARM_DELAY_MS) return;
      savedClearAttempted = true;
      reset();
      void clear();
      return;
    }
    prepare();
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
  bindSavedSwitcher();
  bindCollectionActions();
  elements.savedFilter.addEventListener("change", () => {
    closeCollectionActions(false);
    state.savedFilter = elements.savedFilter.value;
    state.pageIndex = 0;
    renderHistoryPage(0);
  });
  elements.collectionCreate.addEventListener("click", () => openCollectionManagement("create"));
  for (const [button, mode] of [
    [elements.collectionRename, "rename"],
    [elements.collectionDelete, "delete"],
  ] as const)
    button.addEventListener("click", () =>
      openCollectionManagement(
        mode,
        state.library.collections.find((c) => operationKey(c.collectionId) === state.savedFilter),
      ),
    );

  // A sync that lands while History is open redraws the page; focus never falls out of the dialog.
  document.addEventListener("persisted-view-refreshed", () => {
    if (!elements.historyDialog.open) return;
    elements.historyClear.disabled = !state.history.length;
    const focused = document.activeElement as HTMLElement | null;
    const label = focused?.getAttribute("aria-label");
    renderHistoryPage();
    if (label)
      elements.historyGrid.querySelectorAll<HTMLElement>("button").forEach((button) => {
        if (button.getAttribute("aria-label") === label) button.focus({ preventScroll: true });
      });
    if (!elements.historyDialog.contains(document.activeElement))
      (filter === "history" ? elements.historyFilterAll : elements.historyFilterFavorites).focus({
        preventScroll: true,
      });
  });
  elements.historyTool.addEventListener("click", () => openHistory(elements.historyTool));
  elements.removeFrame.addEventListener("click", () => void removeFromHistory(state.index));
  elements.historyClose.addEventListener("click", () => {
    rememberView();
    closeDialog(elements.historyDialog);
  });
  elements.historyDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") rememberView();
  });
  elements.dialogBackdrop.addEventListener(
    "click",
    () => {
      if (elements.historyDialog.open) rememberView();
    },
    { capture: true },
  );
  elements.historyClear.addEventListener("click", () => void clearSavedHistory());
  const resetFavoritesConfirmation = bindClearConfirmation(
    elements.historyClearFavorites,
    elements.historyClearFavoritesGroup,
    clearSavedFavorites,
    () => plural(state.favorites.length, "saved frame"),
    () => {
      savedClearRequest ??= { requestId: newOperationId(), frames: state.favorites.map(savedFrameRef) };
    },
  );
  elements.historyFilterAll.addEventListener("click", () => {
    resetFavoritesConfirmation();
    showFilter("history");
  });
  elements.historyFilterFavorites.addEventListener("click", () => {
    resetFavoritesConfirmation();
    showFilter("favourites");
  });
  elements.historyBody.addEventListener("scroll", () => {
    if (elements.historyDialog.open) rememberView();
  });
  const tabs = [elements.historyFilterAll, elements.historyFilterFavorites];
  for (const tab of tabs)
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === "Home"
          ? elements.historyFilterAll
          : event.key === "End"
            ? elements.historyFilterFavorites
            : tab === elements.historyFilterAll
              ? elements.historyFilterFavorites
              : elements.historyFilterAll;
      next.click();
      next.focus({ preventScroll: true });
    });
  elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(state.pageIndex - 1));
  elements.historyPageNext.addEventListener("click", () => showHistoryPage(state.pageIndex + 1));
  elements.historyPageSize.addEventListener("change", changePageSize);
  elements.historyPageJump.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!elements.historyPageInput.reportValidity()) return;
    showHistoryPage(Number(elements.historyPageInput.value) - 1);
  });
  elements.historyGrid.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
    const tiles = elements.historyGrid.children;
    const tile = target.closest<HTMLElement>(".history-tile");
    const current = Array.prototype.indexOf.call(tiles, tile) as number;
    if (current < 0) return;
    if (event.key === "Delete") {
      event.preventDefault();
      if (tile?.dataset.index && !event.repeat) void removeFromHistory(Number(tile.dataset.index));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusTile(event.key === "Home" ? 0 : tiles.length - 1);
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
    cancelClearReview?.();
    stopThumbnailWork();
    if (saveTimer) saveThumbnails();
    // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
    onDialogClosed();
    state.historyReturnFocus.focus();
    state.historyReturnFocus = elements.toolsMenuButton;
  });
}

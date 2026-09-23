import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { blobKey, blobs, clearThumbnails, releaseAllBlobs, thumbnails } from "./frame-cache.js";
import { goTo } from "./frame-loader.js";
import { historyPage, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import { clearHistory } from "./persistence.js";
import { setState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { state } from "./viewer-state.js";

// Only the current page is laid out, so the dialog never builds thousands of DOM nodes.
function renderHistoryPage(): void {
  const view = historyPage(state.history.length, state.pageIndex, state.pageSize);
  state.pageIndex = view.page;
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !state.history.length;
  elements.historyEmpty.hidden = Boolean(state.history.length);
  elements.historyBody.scrollTop = 0;

  // Below the smallest page size neither paging nor the size choice changes anything.
  elements.historyPager.hidden = state.history.length <= PAGE_SIZES[0];
  elements.historyPagerNav.hidden = view.pages === 1;
  elements.historyRange.textContent = state.history.length
    ? `Frames ${(view.start + 1).toLocaleString("en-US")}–${view.end.toLocaleString("en-US")} of ${state.history.length.toLocaleString("en-US")}`
    : "";
  elements.historyPage.textContent = `Page ${view.page + 1} of ${view.pages}`;
  elements.historyPageSize.value = String(state.pageSize);
  const focused = document.activeElement;
  elements.historyPagePrevious.disabled = view.page === 0;
  elements.historyPageNext.disabled = view.page === view.pages - 1;
  // A focused step button that becomes disabled would drop keyboard focus to the document.
  if (focused === elements.historyPagePrevious && view.page === 0) elements.historyPageNext.focus();
  if (focused === elements.historyPageNext && view.page === view.pages - 1) elements.historyPagePrevious.focus();

  for (const [offset, item] of state.history.slice(view.start, view.end).entries()) {
    const itemIndex = view.start + offset;
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    button.className = "history-item";
    button.type = "button";
    button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
    if (itemIndex === state.index) button.setAttribute("aria-current", "true");
    const key = blobKey(item.source, item.id);
    const thumbnailSrc = blobs.get(key)?.url ?? thumbnails.get(key) ?? "";
    if (!thumbnailSrc) button.setAttribute("data-empty", "true");
    image.src = thumbnailSrc;
    image.alt = "";
    image.loading = "lazy";
    label.textContent = `${itemIndex + 1} · ${item.id}`;
    button.append(image, label);
    button.addEventListener("click", () => {
      closeDialog(elements.historyDialog);
      void goTo(itemIndex);
    });
    elements.historyGrid.append(button);
  }
}

export function openHistory(): void {
  if (state.loading) return;
  elements.historyClear.disabled = !state.history.length;
  // Open where the visitor is: the page holding the shown frame, else the newest page.
  state.pageIndex = pageOf(state.index >= 0 ? state.index : state.history.length - 1, state.pageSize);
  renderHistoryPage();
  openDialog(elements.historyDialog);
}

function showHistoryPage(page: number): void {
  state.pageIndex = page;
  renderHistoryPage();
}

function changePageSize(): void {
  // Keep the first frame of the current page in view across the size change.
  const firstShown = historyPage(state.history.length, state.pageIndex, state.pageSize).start;
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

// Hold-to-confirm: the fill's transitionend (dialogs.css) is the confirmation; releasing early cancels.
let clearPressed = false;
let clearArmedUntil = 0;
function startClearHold(): void {
  clearPressed = true;
  if (state.loading || elements.historyClear.disabled) return;
  elements.historyClear.dataset.holding = "";
}
function stopClearHold(): boolean {
  if (!("holding" in elements.historyClear.dataset)) return false;
  delete elements.historyClear.dataset.holding;
  return true;
}

export function bindHistoryDialogEvents(): void {
  elements.historyButton.addEventListener("click", openHistory);
  elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
  elements.historyClear.addEventListener("pointerdown", (event) => {
    if (event.button === 0) startClearHold();
  });
  elements.historyClear.addEventListener("keydown", (event) => {
    if (!event.repeat && (event.key === " " || event.key === "Enter")) startClearHold();
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) {
    elements.historyClear.addEventListener(type, () => {
      if (stopClearHold()) toast.info("Hold to clear history");
    });
  }
  elements.historyClear.addEventListener("transitionend", (event) => {
    if (event.pseudoElement !== "::before" || !stopClearHold()) return;
    void clearSavedHistory();
  });
  // Assistive tech activates with a bare click (no pointer or key press first) and can't hold,
  // so a second activation within 5s confirms instead.
  elements.historyClear.addEventListener("click", () => {
    if (clearPressed) {
      clearPressed = false;
      return;
    }
    if (Date.now() < clearArmedUntil) {
      clearArmedUntil = 0;
      void clearSavedHistory();
      return;
    }
    clearArmedUntil = Date.now() + 5000;
    elements.announcer.textContent = "Activate again to clear history";
  });
  elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(state.pageIndex - 1));
  elements.historyPageNext.addEventListener("click", () => showHistoryPage(state.pageIndex + 1));
  elements.historyPageSize.addEventListener("change", changePageSize);
  elements.historyDialog.addEventListener("close", () => {
    // Hiding mid-hold cancels the fill without a transitionend; drop the hold silently.
    stopClearHold();
    // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
    onDialogClosed();
    state.historyReturnFocus.focus();
    state.historyReturnFocus = elements.historyButton;
  });
}

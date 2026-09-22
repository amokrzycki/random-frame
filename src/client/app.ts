import { openUrl } from "@tauri-apps/plugin-opener";
import type { Frame } from "./api.js";
import { getFrameById, getRandomFrame } from "./api.js";
import { elements } from "./elements.js";
import { historyPage, loadPageSize, PAGE_SIZES, pageOf, parsePageSize, savePageSize } from "./history-pagination.js";
import { copyImage, saveImage } from "./image-actions.js";
import {
  adjacentPrntscId,
  frameNumberToIndex,
  historyFromStorage,
  historyIndexForId,
  nextHistoryIndex,
  shouldShowEntryDialog,
} from "./navigation.js";
import type { DailyActivity, HistoryItem, HistorySnapshot } from "./persistence.js";
import {
  clearHistory,
  getExplorationStats,
  getHistory,
  getViewingActivity,
  migrateViewingStats,
  recordHistoryItem,
  selectHistoryItem,
} from "./persistence.js";
import {
  describeDay,
  formatExploredBreakdown,
  formatExploredPercent,
  heatmapPlaceholderCount,
  heatmapRangeLabel,
  intensityLevel,
  LEGACY_STATS_STORAGE_KEY,
  leadingBlankCount,
  parseLegacyStats,
} from "./statistics.js";
import { toast } from "./toast.js";
import { checkForUpdate } from "./update.js";

interface CachedBlob {
  blob: Blob;
  url: string;
}

type ViewState = "empty" | "loading" | "error" | "image";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The image could not be loaded";
}

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 160;
const history: HistoryItem[] = [];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = true;
let pageSize = loadPageSize(localStorage);
let pageIndex = 0;
const HEATMAP_DEFAULT_DETAIL = "Hover or focus a day for details.";

function blobKey(source: string, id: string): string {
  return `${source}:${id}`;
}

function loadThumbnails(): Map<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(thumbnailStorageKey) ?? "{}");
    if (typeof stored !== "object" || stored === null) return new Map();
    return new Map(Object.entries(stored as Record<string, string>));
  } catch {
    return new Map();
  }
}

const thumbnails = loadThumbnails();

function persistThumbnails(): void {
  // ponytail: prunes to keys still in history, no LRU beyond that; add one if history grows unbounded
  const keep = new Set(history.map((item) => blobKey(item.source, item.id)));
  for (const key of thumbnails.keys()) if (!keep.has(key)) thumbnails.delete(key);
  try {
    localStorage.setItem(thumbnailStorageKey, JSON.stringify(Object.fromEntries(thumbnails)));
  } catch {
    // Storage quota exceeded; thumbnails simply stay in-memory for this session
  }
}

async function cacheThumbnail(key: string, blob: Blob): Promise<void> {
  if (thumbnails.has(key)) return;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    thumbnails.set(key, canvas.toDataURL("image/jpeg", 0.6));
    persistThumbnails();
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
  }
}

function applyHistory(snapshot: HistorySnapshot): void {
  history.splice(0, history.length, ...snapshot.history);
  index = snapshot.index;
}

try {
  if (shouldShowEntryDialog(localStorage.getItem(entryStorageKey))) openDialog(elements.entryDialog);
} catch {
  openDialog(elements.entryDialog);
}

function setState(state: ViewState, message = ""): void {
  for (const [name, target] of Object.entries({
    empty: elements.empty,
    loading: elements.loading,
    error: elements.error,
    image: elements.imageZoom,
  })) {
    target.hidden = name !== state;
  }
  if (message) elements.errorMessage.textContent = message;
  if (state === "loading") elements.announcer.textContent = "Finding an available frame";
}

function syncControls(): void {
  const current = history[index];
  elements.previous.disabled = loading || index <= 0;
  elements.next.disabled = loading || index < 0;
  const currentBlob = current && blobs.has(blobKey(current.source, current.id));
  elements.save.disabled = loading || !currentBlob;
  elements.copyImage.disabled = loading || !currentBlob;
  elements.copyLink.disabled = loading || !current;
  elements.previousId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, 1) === null;
  elements.jumpInput.disabled = loading || !history.length;
  elements.jumpButton.disabled = loading || !history.length;
  elements.jumpInput.max = String(history.length);
  if (document.activeElement !== elements.jumpInput) elements.jumpInput.value = String(history.length ? index + 1 : 0);
  elements.historyTotal.textContent = String(history.length);
  elements.historyButton.disabled = loading;
  elements.historyClear.disabled = loading;
  elements.next.setAttribute(
    "aria-label",
    index < history.length - 1 ? "Show the next saved frame" : "Draw a new frame",
  );
  elements.imageId.textContent = current ? `${current.source}/${current.id}` : "prnt.sc/———";
  elements.source.href = current?.sourcePageUrl ?? "https://prnt.sc/";
  elements.source.setAttribute("aria-disabled", String(!current));
  elements.meta.textContent = current
    ? `Source: Prnt.sc · frame ${current.id}`
    : "One public image. No feed, no profile.";
}

function showFrame(source: string, id: string, blob: Blob): void {
  const oldUrl = elements.image.src;
  const url = URL.createObjectURL(blob);
  const key = blobKey(source, id);
  blobs.set(key, { blob, url });
  void cacheThumbnail(key, blob);
  elements.image.src = url;
  elements.image.alt = `Public image from Prnt.sc with identifier ${id}`;
  elements.image.style.animation = "none";
  void elements.image.offsetWidth;
  elements.image.style.animation = "";
  setState("image");
  syncControls();
  elements.announcer.textContent = `Showing frame ${id}`;
  if (oldUrl.startsWith("blob:") && ![...blobs.values()].some((item) => item.url === oldUrl))
    URL.revokeObjectURL(oldUrl);
}

async function recordFrame(frame: Frame): Promise<void> {
  applyHistory(
    await recordHistoryItem({
      source: frame.source,
      id: frame.id,
      sourcePageUrl: frame.sourcePageUrl,
      viewedAt: Date.now(),
    }),
  );
  showFrame(frame.source, frame.id, frame.blob);
}

async function loadRandom(): Promise<void> {
  if (loading) return;
  loading = true;
  setState("loading");
  syncControls();
  try {
    const frame = await getRandomFrame();
    await recordFrame(frame);
  } catch (error) {
    const message = errorMessage(error);
    setState("error", message);
    elements.announcer.textContent = `Error: ${message}`;
  } finally {
    loading = false;
    syncControls();
  }
}

async function goTo(targetIndex: number): Promise<void> {
  if (loading || targetIndex === index || targetIndex < 0 || targetIndex >= history.length) return;
  const current = history[targetIndex];
  if (!current) return;
  loading = true;
  const previousIndex = index;
  const cached = blobs.get(blobKey(current.source, current.id));
  try {
    if (!cached) {
      setState("loading");
      syncControls();
      const frame = await getFrameById(current.id, current.source);
      showFrame(frame.source, frame.id, frame.blob);
    } else {
      elements.image.src = cached.url;
      elements.image.alt = `Public image from Prnt.sc with identifier ${current.id}`;
      setState("image");
      elements.announcer.textContent = `Showing frame ${current.id}`;
    }
    applyHistory(await selectHistoryItem(targetIndex));
  } catch (error) {
    index = previousIndex;
    setState("error", errorMessage(error));
  }
  loading = false;
  syncControls();
}

// Only the current page is laid out, so the dialog never builds thousands of DOM nodes.
function renderHistoryPage(): void {
  const view = historyPage(history.length, pageIndex, pageSize);
  pageIndex = view.page;
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !history.length;
  elements.historyEmpty.hidden = Boolean(history.length);
  elements.historyBody.scrollTop = 0;

  // Below the smallest page size neither paging nor the size choice changes anything.
  elements.historyPager.hidden = history.length <= PAGE_SIZES[0];
  elements.historyPagerNav.hidden = view.pages === 1;
  elements.historyRange.textContent = history.length
    ? `Frames ${(view.start + 1).toLocaleString("en-US")}–${view.end.toLocaleString("en-US")} of ${history.length.toLocaleString("en-US")}`
    : "";
  elements.historyPage.textContent = `Page ${view.page + 1} of ${view.pages}`;
  elements.historyPageSize.value = String(pageSize);
  const focused = document.activeElement;
  elements.historyPagePrevious.disabled = view.page === 0;
  elements.historyPageNext.disabled = view.page === view.pages - 1;
  // A focused step button that becomes disabled would drop keyboard focus to the document.
  if (focused === elements.historyPagePrevious && view.page === 0) elements.historyPageNext.focus();
  if (focused === elements.historyPageNext && view.page === view.pages - 1) elements.historyPagePrevious.focus();

  for (const [offset, item] of history.slice(view.start, view.end).entries()) {
    const itemIndex = view.start + offset;
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    button.className = "history-item";
    button.type = "button";
    button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
    if (itemIndex === index) button.setAttribute("aria-current", "true");
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

function openHistory(): void {
  elements.historyClear.disabled = false;
  // Open where the visitor is: the page holding the shown frame, else the newest page.
  pageIndex = pageOf(index >= 0 ? index : history.length - 1, pageSize);
  renderHistoryPage();
  openDialog(elements.historyDialog);
}

function showHistoryPage(page: number): void {
  pageIndex = page;
  renderHistoryPage();
}

function changePageSize(): void {
  // Keep the first frame of the current page in view across the size change.
  const firstShown = historyPage(history.length, pageIndex, pageSize).start;
  pageSize = parsePageSize(elements.historyPageSize.value);
  savePageSize(localStorage, pageSize);
  showHistoryPage(pageOf(firstShown, pageSize));
}

// showModal() makes the rest of the document inert, including the titlebar,
// which blocks window drag/controls; show() plus manual inert on main/footer
// keeps the titlebar usable while a dialog is open.
const dialogs = [elements.entryDialog, elements.historyDialog, elements.statsDialog, elements.lightboxDialog];

function openDialog(dialog: HTMLDialogElement, variant?: "dark"): void {
  elements.main.inert = true;
  elements.footer.inert = true;
  if (variant) elements.dialogBackdrop.dataset.variant = variant;
  else delete elements.dialogBackdrop.dataset.variant;
  elements.dialogBackdrop.hidden = false;
  void elements.dialogBackdrop.offsetWidth;
  elements.dialogBackdrop.dataset.open = "";
  dialog.show();
}

function onDialogClosed(): void {
  if (dialogs.some((dialog) => dialog.open)) return;
  elements.main.inert = false;
  elements.footer.inert = false;
  const backdrop = elements.dialogBackdrop;
  delete backdrop.dataset.open;
  const fallback = setTimeout(() => (backdrop.hidden = true), 250);
  backdrop.addEventListener(
    "transitionend",
    (event) => {
      if (event.target !== backdrop || event.propertyName !== "opacity") return;
      clearTimeout(fallback);
      backdrop.hidden = true;
    },
    { once: true },
  );
}

// The entry dialog can only be dismissed by accepting; it never closes on backdrop click or Escape.
function dismissibleOpenDialog(): HTMLDialogElement | undefined {
  return dialogs.find((dialog) => dialog.open && dialog !== elements.entryDialog);
}

elements.dialogBackdrop.addEventListener("click", () => {
  const dialog = dismissibleOpenDialog();
  if (dialog) closeDialog(dialog);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const dialog = dismissibleOpenDialog();
  if (dialog) closeDialog(dialog);
});

function closeDialog(dialog: HTMLDialogElement): void {
  const classList = (dialog as unknown as { classList?: DOMTokenList }).classList;
  if (!classList) {
    dialog.close();
    return;
  }
  if (classList.contains("is-closing")) return;
  classList.add("is-closing");
  const finish = (): void => {
    dialog.close();
    classList.remove("is-closing");
  };
  const fallback = setTimeout(finish, 250);
  dialog.addEventListener(
    "transitionend",
    (event) => {
      if (event.target !== dialog || event.propertyName !== "opacity") return;
      clearTimeout(fallback);
      finish();
    },
    { once: true },
  );
}

function goBack(): void {
  void goTo(index - 1);
}

function goNext(): void {
  const targetIndex = nextHistoryIndex(index, history.length);
  if (targetIndex === null) void loadRandom();
  else void goTo(targetIndex);
}

async function loadAdjacent(offset: -1 | 1): Promise<void> {
  const current = history[index];
  const id = current && adjacentPrntscId(current.id, offset);
  if (loading || !id) return;
  const savedIndex = historyIndexForId(history, id);
  if (savedIndex !== -1) return void goTo(savedIndex);
  loading = true;
  setState("loading");
  syncControls();
  try {
    const frame = await getFrameById(id);
    await recordFrame(frame);
  } catch (error) {
    const message = errorMessage(error);
    setState("error", message);
    elements.announcer.textContent = `Error: ${message}`;
  } finally {
    loading = false;
    syncControls();
  }
}

async function saveCurrent(): Promise<void> {
  const current = history[index];
  const cached = current && blobs.get(blobKey(current.source, current.id));
  if (!current || !cached) return;
  await saveImage(current.id, cached.blob, elements.announcer);
}

async function copyCurrentImage(): Promise<void> {
  const current = history[index];
  const cached = current && blobs.get(blobKey(current.source, current.id));
  if (!current || !cached) return;
  await copyImage(cached.blob, elements.announcer);
}

async function copySourceLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(elements.source.href);
    toast.success("Copied to clipboard");
  } catch {
    elements.announcer.textContent = "Could not copy the source link";
  }
}

async function clearSavedHistory(): Promise<void> {
  if (loading) return;
  loading = true;
  syncControls();
  try {
    await clearHistory();
    history.length = 0;
    index = -1;
    for (const { url } of blobs.values()) URL.revokeObjectURL(url);
    blobs.clear();
    thumbnails.clear();
    localStorage.removeItem(thumbnailStorageKey);
    elements.image.src = "";
    elements.image.alt = "";
    setState("empty");
    closeDialog(elements.historyDialog);
    elements.announcer.textContent = "History cleared";
  } catch (error) {
    elements.announcer.textContent = `Error: ${errorMessage(error)}`;
  } finally {
    loading = false;
    syncControls();
  }
}

function openLightbox(): void {
  if (elements.imageZoom.hidden || !elements.image.src) return;
  elements.lightboxImage.src = elements.image.src;
  elements.lightboxImage.alt = elements.image.alt;
  openDialog(elements.lightboxDialog, "dark");
}

async function migrateLegacyStats(): Promise<void> {
  const legacy = parseLegacyStats(localStorage.getItem(LEGACY_STATS_STORAGE_KEY));
  if (!legacy) return;
  try {
    await migrateViewingStats(legacy.day, legacy.today, legacy.total);
    localStorage.removeItem(LEGACY_STATS_STORAGE_KEY);
  } catch {
    // Best-effort; retried on the next launch if it failed this time
  }
}

function renderHeatmap(days: DailyActivity[]): void {
  const grid = elements.statsHeatmapGrid;
  grid.replaceChildren();
  elements.statsHeatmapDetail.textContent = days.length ? HEATMAP_DEFAULT_DETAIL : "No activity data yet.";
  const rangeLabel = heatmapRangeLabel(days);
  elements.statsHeatmapRange.textContent = rangeLabel;
  grid.setAttribute("aria-label", `Daily viewed images, ${rangeLabel.toLowerCase()}`);
  if (!days.length) return;

  const maxViewed = Math.max(1, ...days.map((day) => day.viewed));
  const firstDay = days[0];
  if (firstDay) {
    for (let blank = 0; blank < leadingBlankCount(firstDay.date); blank += 1) {
      const filler = document.createElement("span");
      filler.className = "heatmap-cell heatmap-cell--empty";
      filler.setAttribute("aria-hidden", "true");
      grid.append(filler);
    }
  }
  for (const day of days) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "heatmap-cell";
    cell.setAttribute("data-level", String(intensityLevel(day.viewed, maxViewed)));
    const description = describeDay(day);
    cell.setAttribute("aria-label", description);
    cell.title = description;
    grid.append(cell);
  }
  for (let i = 0; i < heatmapPlaceholderCount(days.length); i += 1) {
    const placeholder = document.createElement("span");
    placeholder.className = "heatmap-cell heatmap-cell--placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    grid.append(placeholder);
  }
}

async function initialize(): Promise<void> {
  try {
    let snapshot = await getHistory();
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
    loading = false;
    syncControls();
    if (snapshot.index >= 0) await goTo(snapshot.index);
  } catch (error) {
    loading = false;
    const message = errorMessage(error);
    setState("error", message);
    elements.announcer.textContent = `Error: ${message}`;
    syncControls();
  }
}

elements.start.addEventListener("click", () => void loadRandom());
elements.retry.addEventListener("click", () => void loadRandom());
elements.next.addEventListener("click", goNext);
elements.previous.addEventListener("click", goBack);
elements.previousId.addEventListener("click", () => void loadAdjacent(-1));
elements.nextId.addEventListener("click", () => void loadAdjacent(1));
elements.save.addEventListener("click", () => void saveCurrent());
elements.copyImage.addEventListener("click", () => void copyCurrentImage());
elements.copyLink.addEventListener("click", () => void copySourceLink());
elements.historyButton.addEventListener("click", openHistory);
elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
// Hold-to-confirm: the fill's transitionend (dialogs.css) is the confirmation; releasing early cancels.
function startClearHold(): void {
  if (loading || elements.historyClear.disabled) return;
  elements.historyClear.dataset.holding = "";
}
function cancelClearHold(): void {
  if (!("holding" in elements.historyClear.dataset)) return;
  delete elements.historyClear.dataset.holding;
  toast.success("Hold to clear history");
}
elements.historyClear.addEventListener("pointerdown", (event) => {
  if (event.button === 0) startClearHold();
});
elements.historyClear.addEventListener("keydown", (event) => {
  if (!event.repeat && (event.key === " " || event.key === "Enter")) startClearHold();
});
for (const type of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) {
  elements.historyClear.addEventListener(type, cancelClearHold);
}
elements.historyClear.addEventListener("transitionend", (event) => {
  if (!("holding" in elements.historyClear.dataset) || event.pseudoElement !== "::before") return;
  delete elements.historyClear.dataset.holding;
  void clearSavedHistory();
});
elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(pageIndex - 1));
elements.historyPageNext.addEventListener("click", () => showHistoryPage(pageIndex + 1));
elements.historyPageSize.addEventListener("change", changePageSize);
elements.historyDialog.addEventListener("close", () => {
  elements.historyButton.focus();
  onDialogClosed();
});
elements.statsButton.addEventListener("click", async () => {
  try {
    const [exploration, activity] = await Promise.all([getExplorationStats(), getViewingActivity()]);
    elements.statsToday.textContent = String(activity.days.at(-1)?.viewed ?? 0);
    elements.statsTotal.textContent = activity.viewedTotal.toLocaleString("en-US");
    elements.statsExplored.textContent = `${exploration.explored.toLocaleString("en-US")} / ${exploration.total.toLocaleString("en-US")}`;
    elements.statsExploredPercent.textContent = `${formatExploredPercent(exploration.explored, exploration.total)} of known legacy ID space`;
    elements.statsExploredBreakdown.textContent = formatExploredBreakdown(
      exploration.explored,
      exploration.viewable,
      exploration.unavailable,
    );
    renderHeatmap(activity.days);
  } catch {
    elements.statsToday.textContent = "0";
    elements.statsTotal.textContent = "0";
    elements.statsExplored.textContent = "Unavailable";
    elements.statsExploredPercent.textContent = "Could not read local exploration data";
    elements.statsExploredBreakdown.textContent = "";
    renderHeatmap([]);
  }
  openDialog(elements.statsDialog);
});
function showHeatmapDetail(event: Event): void {
  const label = (event.target as HTMLElement).getAttribute?.("aria-label");
  if (label) elements.statsHeatmapDetail.textContent = label;
}
elements.statsHeatmapGrid.addEventListener("mouseover", showHeatmapDetail);
elements.statsHeatmapGrid.addEventListener("focusin", showHeatmapDetail);
elements.statsHeatmapGrid.addEventListener("mouseleave", () => {
  elements.statsHeatmapDetail.textContent = HEATMAP_DEFAULT_DETAIL;
});
elements.statsHeatmapGrid.addEventListener("focusout", () => {
  elements.statsHeatmapDetail.textContent = HEATMAP_DEFAULT_DETAIL;
});
elements.statsClose.addEventListener("click", () => closeDialog(elements.statsDialog));
elements.statsDialog.addEventListener("close", () => {
  elements.statsButton.focus();
  onDialogClosed();
});
elements.imageZoom.addEventListener("click", openLightbox);
elements.lightboxDialog.addEventListener("click", () => closeDialog(elements.lightboxDialog));
elements.lightboxClose.addEventListener("click", (event) => {
  event.stopPropagation();
  closeDialog(elements.lightboxDialog);
});
elements.lightboxDialog.addEventListener("close", () => {
  elements.imageZoom.focus();
  onDialogClosed();
});
elements.entryConsent.addEventListener("change", () => {
  elements.entryButton.disabled = !elements.entryConsent.checked;
});
elements.entryDialog.addEventListener("close", () => {
  onDialogClosed();
  elements.start.focus();
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
elements.jumpInput.addEventListener("input", () => elements.jumpInput.setCustomValidity(""));
elements.jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const targetIndex = frameNumberToIndex(elements.jumpInput.value, history.length);
  if (targetIndex === null) {
    elements.jumpInput.setCustomValidity(`Enter a number between 1 and ${history.length}.`);
    elements.jumpInput.reportValidity();
    return;
  }
  elements.jumpInput.setCustomValidity("");
  void goTo(targetIndex);
});

document.addEventListener("keydown", (event) => {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    elements.historyDialog.open ||
    elements.statsDialog.open ||
    elements.lightboxDialog.open ||
    elements.entryDialog.open
  )
    return;
  if (event.key === "ArrowLeft") goBack();
  if (event.key === "ArrowRight" && index >= 0) goNext();
});

window.addEventListener("pagehide", () => {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
});

document.querySelectorAll<HTMLAnchorElement>(".external-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (link.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    void openUrl(link.href);
  });
});

syncControls();
void initialize();
void checkForUpdate();
void migrateLegacyStats();

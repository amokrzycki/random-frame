import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Frame } from "./api.js";
import { getFrameById, getRandomFrame } from "./api.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
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
  heatmapFocusTarget,
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

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 160;
// ~5-8 KB each as base64 JPEG; 300 stays well inside the webview's ~5 MB localStorage quota.
const THUMBNAIL_LIMIT = 300;
const history: HistoryItem[] = [];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = true;
let viewState: ViewState = "empty";
let cooldownUntil = 0;
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
let cooldownNoticeShown = false;
let pageSize = loadPageSize(localStorage);
let pageIndex = 0;
let focusBeforeLoading: Element | null = null;
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
  // ponytail: keeps the newest THUMBNAIL_LIMIT history entries; older tiles fall back to the stripe placeholder
  const keep = new Set(history.slice(-THUMBNAIL_LIMIT).map((item) => blobKey(item.source, item.id)));
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

const statePanels: Record<ViewState, HTMLElement> = {
  empty: elements.empty,
  loading: elements.loading,
  error: elements.error,
  image: elements.imageZoom,
};

function setState(state: ViewState): void {
  viewState = state;
  for (const [name, target] of Object.entries(statePanels)) target.hidden = name !== state;
  if (state === "loading") elements.announcer.textContent = "Finding an available frame";
}

const stateControls: Record<ViewState, HTMLElement | null> = {
  empty: elements.start,
  loading: null,
  error: elements.retry,
  image: elements.next,
};

function startLoading(): void {
  loading = true;
  focusBeforeLoading = document.activeElement;
}

function focusLost(): boolean {
  return !document.activeElement || document.activeElement === document.body;
}

// Loading hides or disables the control that started it, which drops focus to <body>. Hand it back,
// or to the stage's own control when that one is gone (the start button, say), unless the visitor moved on.
function finishLoading(): void {
  loading = false;
  syncControls();
  const target = focusBeforeLoading as HTMLElement | null;
  focusBeforeLoading = null;
  if (!target || target === document.body || !focusLost()) return;
  target.focus();
  if (focusLost()) stateControls[viewState]?.focus();
}

function syncControls(): void {
  const current = history[index];
  elements.previous.setAttribute("aria-disabled", String(loading || index <= 0));
  elements.next.setAttribute("aria-disabled", String(loading || index < 0));
  // Copy and save act on the visible frame only, never on one hidden behind an error.
  const currentBlob = viewState === "image" && current && blobs.has(blobKey(current.source, current.id));
  elements.save.disabled = loading || !currentBlob;
  elements.copyImage.disabled = loading || !currentBlob;
  elements.copyLink.disabled = loading || !current;
  elements.previousId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, 1) === null;
  // History, jump, and the arrows stay enabled while loading (goTo ignores them), so they keep focus.
  elements.jumpInput.disabled = !history.length;
  elements.jumpButton.disabled = !history.length;
  elements.jumpInput.max = String(history.length);
  if (document.activeElement !== elements.jumpInput) elements.jumpInput.value = String(history.length ? index + 1 : 0);
  elements.historyTotal.textContent = String(history.length);
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
  // aria-disabled rather than disabled, so a focused retry keeps focus through the countdown.
  const waitSeconds = cooldownSeconds();
  elements.retry.setAttribute("aria-disabled", String(waitSeconds > 0));
  elements.retry.textContent = waitSeconds ? `Try another in ${waitSeconds}s` : "Try another";
  elements.back.hidden = !current;
  elements.back.textContent = `Show frame ${index + 1}`;
}

function cooldownSeconds(): number {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

// Requesting again straight into a rate limit only extends it, so new draws pause while the retry counts down.
function startCooldown(seconds: number): void {
  cooldownUntil = Date.now() + seconds * 1000;
  cooldownNoticeShown = false;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    if (!cooldownSeconds()) clearInterval(cooldownTimer);
    syncControls();
  }, 1000);
}

// Returns true when a network draw has to wait; history already on the device stays reachable.
function drawPaused(): boolean {
  const seconds = cooldownSeconds();
  if (!seconds) return false;
  const notice = `Drawing resumes in ${seconds}s`;
  // The countdown is already on stage in the error state; elsewhere one toast per pause, not one per key repeat.
  if (viewState !== "error" && !cooldownNoticeShown) {
    toast.error(notice);
    cooldownNoticeShown = true;
  } else elements.announcer.textContent = notice;
  return true;
}

function showError(error: unknown): void {
  const { title, message, cooldownSeconds: seconds } = describeError(error);
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  setState("error");
  elements.announcer.textContent = `${title} ${message}`;
  if (seconds) startCooldown(seconds);
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
  if (loading || drawPaused()) return;
  startLoading();
  setState("loading");
  syncControls();
  try {
    const frame = await getRandomFrame();
    await recordFrame(frame);
  } catch (error) {
    showError(error);
  } finally {
    finishLoading();
  }
}

async function goTo(targetIndex: number): Promise<void> {
  // The shown index may be re-requested when an error covers it, so the frame can be recovered.
  if (loading || (targetIndex === index && viewState === "image") || targetIndex < 0 || targetIndex >= history.length)
    return;
  const current = history[targetIndex];
  if (!current) return;
  startLoading();
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
    // A failed restore at startup keeps the target, so "Show frame N" retries it.
    index = previousIndex >= 0 ? previousIndex : targetIndex;
    showError(error);
  }
  finishLoading();
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
  if (loading) return;
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
  // closeDialog already faded the backdrop alongside the dialog.
  delete elements.dialogBackdrop.dataset.open;
  elements.dialogBackdrop.hidden = true;
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
  if (!dialogs.some((other) => other !== dialog && other.open)) delete elements.dialogBackdrop.dataset.open;
  // Not `once`: children's transitionend events bubble here first and would consume the listener.
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target !== dialog || event.propertyName !== "opacity") return;
    clearTimeout(fallback);
    finish();
  };
  const finish = (): void => {
    dialog.removeEventListener("transitionend", onTransitionEnd);
    dialog.close();
    classList.remove("is-closing");
  };
  const fallback = setTimeout(finish, 180);
  dialog.addEventListener("transitionend", onTransitionEnd);
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
  if (drawPaused()) return;
  startLoading();
  setState("loading");
  syncControls();
  try {
    const frame = await getFrameById(id);
    await recordFrame(frame);
  } catch (error) {
    showError(error);
  } finally {
    finishLoading();
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
  await copyImage(cached.blob);
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
    elements.announcer.textContent = describeError(error).message;
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
  for (const [dayIndex, day] of days.entries()) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "heatmap-cell";
    // One tab stop for the whole grid, on today; arrow keys move between days.
    cell.tabIndex = dayIndex === days.length - 1 ? 0 : -1;
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
    showError(error);
    syncControls();
  }
}

elements.start.addEventListener("click", () => void loadRandom());
elements.retry.addEventListener("click", () => void loadRandom());
elements.back.addEventListener("click", () => void goTo(index));
// aria-disabled buttons still fire clicks; goTo and loadRandom already ignore them while loading.
elements.next.addEventListener("click", () => {
  if (index >= 0) goNext();
});
elements.previous.addEventListener("click", goBack);
elements.previousId.addEventListener("click", () => void loadAdjacent(-1));
elements.nextId.addEventListener("click", () => void loadAdjacent(1));
elements.save.addEventListener("click", () => void saveCurrent());
elements.copyImage.addEventListener("click", () => void copyCurrentImage());
elements.copyLink.addEventListener("click", () => void copySourceLink());
elements.historyButton.addEventListener("click", openHistory);
elements.historyClose.addEventListener("click", () => closeDialog(elements.historyDialog));
// Hold-to-confirm: the fill's transitionend (dialogs.css) is the confirmation; releasing early cancels.
let clearPressed = false;
let clearArmedUntil = 0;
function startClearHold(): void {
  clearPressed = true;
  if (loading || elements.historyClear.disabled) return;
  elements.historyClear.dataset.holding = "";
}
function stopClearHold(): boolean {
  if (!("holding" in elements.historyClear.dataset)) return false;
  delete elements.historyClear.dataset.holding;
  return true;
}
elements.historyClear.addEventListener("pointerdown", (event) => {
  if (event.button === 0) startClearHold();
});
elements.historyClear.addEventListener("keydown", (event) => {
  if (!event.repeat && (event.key === " " || event.key === "Enter")) startClearHold();
});
for (const type of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) {
  elements.historyClear.addEventListener(type, () => {
    if (stopClearHold()) toast.success("Hold to clear history");
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
elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(pageIndex - 1));
elements.historyPageNext.addEventListener("click", () => showHistoryPage(pageIndex + 1));
elements.historyPageSize.addEventListener("change", changePageSize);
elements.historyDialog.addEventListener("close", () => {
  // Hiding mid-hold cancels the fill without a transitionend; drop the hold silently.
  stopClearHold();
  // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
  onDialogClosed();
  elements.historyButton.focus();
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
elements.statsHeatmapGrid.addEventListener("keydown", (event) => {
  const cells = [...elements.statsHeatmapGrid.querySelectorAll<HTMLButtonElement>("button.heatmap-cell")];
  const current = cells.indexOf(event.target as HTMLButtonElement);
  const target = current === -1 ? null : heatmapFocusTarget(event.key, current, cells.length);
  if (target === null) return;
  event.preventDefault();
  const from = cells[current];
  const to = cells[target];
  if (!from || !to || from === to) return;
  from.tabIndex = -1;
  to.tabIndex = 0;
  to.focus();
});
elements.statsHeatmapGrid.addEventListener("mouseleave", () => {
  elements.statsHeatmapDetail.textContent = HEATMAP_DEFAULT_DETAIL;
});
elements.statsHeatmapGrid.addEventListener("focusout", () => {
  elements.statsHeatmapDetail.textContent = HEATMAP_DEFAULT_DETAIL;
});
elements.statsClose.addEventListener("click", () => closeDialog(elements.statsDialog));
elements.statsDialog.addEventListener("close", () => {
  onDialogClosed();
  elements.statsButton.focus();
});
elements.imageZoom.addEventListener("click", openLightbox);
elements.lightboxDialog.addEventListener("click", () => closeDialog(elements.lightboxDialog));
elements.lightboxClose.addEventListener("click", (event) => {
  event.stopPropagation();
  closeDialog(elements.lightboxDialog);
});
elements.lightboxDialog.addEventListener("close", () => {
  onDialogClosed();
  elements.imageZoom.focus();
});
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

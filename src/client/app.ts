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
import type { HistoryItem, HistorySnapshot } from "./persistence.js";
import {
  clearHistory,
  getExplorationStats,
  getHistory,
  getViewingActivity,
  migrateViewingStats,
  recordHistoryItem,
  selectHistoryItem,
} from "./persistence.js";
import type { LedgerDay } from "./statistics.js";
import {
  drawStreak,
  formatExploredBreakdown,
  formatExploredPercent,
  formatLedgerCounts,
  LEDGER_PAGE_DAYS,
  LEDGER_STRIP_MAX,
  LEGACY_STATS_STORAGE_KEY,
  ledgerDateLabel,
  ledgerDays,
  localDayKey,
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
// Blob keys saved to disk this session, so revisiting a saved frame still shows its check.
const savedFrames = new Set<string>();
let index = -1;
let loading = true;
// A network draw in flight, as opposed to any loading; only this spins the Draw next button.
let drawing = false;
let viewState: ViewState = "empty";
let retryAction: () => Promise<void> = loadRandom;
let failedIndex = -1;
let cooldownUntil = 0;
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
let cooldownNoticeShown = false;
let pageSize = loadPageSize(localStorage);
let pageIndex = 0;
let focusBeforeLoading: Element | null = null;
let historyReturnFocus: HTMLElement = elements.historyButton;
let ledger: LedgerDay[] = [];
let ledgerShown = 0;

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
  // A shown frame stays on stage, dimmed under the loader or an error, so the next one can crossfade in.
  const keepFrame = (state === "loading" || state === "error") && !elements.imageZoom.hidden;
  viewState = state;
  for (const [name, target] of Object.entries(statePanels))
    target.hidden = name !== state && !(keepFrame && name === "image");
  elements.imageZoom.inert = keepFrame;
  if (keepFrame) elements.imageZoom.dataset.dimmed = "";
  else delete elements.imageZoom.dataset.dimmed;
  if (state === "loading") elements.announcer.textContent = "Finding an available frame";
}

const stateControls: Record<ViewState, HTMLElement | null> = {
  empty: elements.draw,
  loading: null,
  error: elements.retry,
  image: elements.draw,
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
  // At 0/0 the arrows have nowhere to go; the empty stage points at Draw next instead.
  elements.previous.hidden = elements.next.hidden = !history.length;
  elements.previous.setAttribute("aria-disabled", String(loading || index <= 0));
  elements.next.setAttribute("aria-disabled", String(loading || nextHistoryIndex(index, history.length) === null));
  // Copy and save act on the visible frame only, never on one hidden behind an error.
  const currentBlob = viewState === "image" && current && blobs.has(blobKey(current.source, current.id));
  elements.save.disabled = loading || !currentBlob;
  // A saved frame keeps its check while shown; only a fresh save plays the arrow-to-check.
  if (current && savedFrames.has(blobKey(current.source, current.id))) elements.save.dataset.saved ??= "shown";
  else delete elements.save.dataset.saved;
  elements.save.title = elements.save.dataset.saved ? "Saved · Save again (S)" : "Save image (S)";
  elements.copyImage.disabled = loading || !currentBlob;
  elements.copyLink.disabled = loading || !current;
  elements.previousId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, 1) === null;
  elements.previousIdMenuItem.disabled = elements.previousId.disabled;
  elements.nextIdMenuItem.disabled = elements.nextId.disabled;
  elements.idMenuButton.disabled = elements.previousId.disabled && elements.nextId.disabled;
  // History, the position readout, and the arrows stay enabled while loading (goTo ignores them), so they keep focus.
  const position = history.length ? index + 1 : 0;
  elements.positionButton.disabled = !history.length;
  elements.positionButton.setAttribute("aria-label", `Frame ${position} of ${history.length}. Jump to a frame`);
  elements.positionCurrent.textContent = String(position);
  elements.historyTotal.textContent = String(history.length);
  elements.jumpTotal.textContent = String(history.length);
  elements.jumpInput.max = String(history.length);
  elements.historyClear.disabled = loading || !history.length;
  elements.imageIdValue.textContent = current?.id ?? "———";
  // Without an href the link leaves the tab order and Enter has nothing to follow.
  if (current) elements.source.href = current.sourcePageUrl;
  else elements.source.removeAttribute("href");
  elements.source.setAttribute("aria-disabled", String(!current));
  // aria-disabled rather than disabled, so a focused retry or Draw next keeps focus through the countdown.
  const waitSeconds = cooldownSeconds();
  elements.retry.setAttribute("aria-disabled", String(waitSeconds > 0));
  elements.retry.textContent = waitSeconds ? `Try again in ${waitSeconds}s` : "Try again";
  elements.draw.setAttribute("aria-busy", String(drawing));
  elements.draw.setAttribute("aria-disabled", String(waitSeconds > 0));
  elements.drawLabel.textContent = waitSeconds ? `Wait ${waitSeconds}s` : "Draw next";
  // When the failed request was this very frame, Try again already says it.
  elements.back.hidden = !current || failedIndex === index;
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

// Try again repeats the request that failed; failedAt names the history frame it was restoring, if any.
function showError(error: unknown, retry: () => Promise<void>, failedAt = -1): void {
  retryAction = retry;
  failedIndex = failedAt;
  const { title, message, cooldownSeconds: seconds } = describeError(error);
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  setState("error");
  elements.announcer.textContent = `${title} ${message}`;
  if (seconds) startCooldown(seconds);
}

// A blob that will not decode never reaches the stage or history, so the counter only claims frames that show.
async function decodedUrl(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  const probe = document.createElement("img");
  probe.src = url;
  try {
    await probe.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw { kind: "invalid-response" };
  }
  return url;
}

function showFrame(source: string, id: string, blob: Blob, url: string): void {
  const oldUrl = elements.image.src;
  const key = blobKey(source, id);
  blobs.set(key, { blob, url });
  void cacheThumbnail(key, blob);
  swapImage(url, id);
  syncControls();
  elements.announcer.textContent = `Showing frame ${id}`;
  // The outgoing frame may still be fading out on the ghost, so release it after the crossfade.
  if (oldUrl.startsWith("blob:") && ![...blobs.values()].some((item) => item.url === oldUrl))
    setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
}

function restartAnimation(target: HTMLElement): void {
  target.style.animation = "none";
  void target.offsetWidth;
  target.style.animation = "";
}

// The outgoing frame fades out beneath the incoming one, so a draw never cuts through an empty stage.
function swapImage(url: string, id: string): void {
  const { image, imageGhost: ghost } = elements;
  const outgoing = image.src;
  const crossfade = !elements.imageZoom.hidden && outgoing.startsWith("blob:") && outgoing !== url;
  ghost.hidden = !crossfade;
  if (crossfade) {
    ghost.src = outgoing;
    restartAnimation(ghost);
  }
  image.src = url;
  image.alt = `Public image from Prnt.sc with identifier ${id}`;
  restartAnimation(image);
  setState("image");
}

async function recordFrame(frame: Frame): Promise<void> {
  const url = await decodedUrl(frame.blob);
  applyHistory(
    await recordHistoryItem({
      source: frame.source,
      id: frame.id,
      sourcePageUrl: frame.sourcePageUrl,
      viewedAt: Date.now(),
    }),
  );
  showFrame(frame.source, frame.id, frame.blob, url);
}

// Always a new frame, even mid-history: it joins the end of history and the view jumps to it.
async function loadRandom(): Promise<void> {
  if (loading || drawPaused()) return;
  startLoading();
  drawing = true;
  elements.idMenu.hidePopover?.();
  setState("loading");
  syncControls();
  try {
    const frame = await getRandomFrame();
    await recordFrame(frame);
  } catch (error) {
    showError(error, loadRandom);
  } finally {
    drawing = false;
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
      showFrame(frame.source, frame.id, frame.blob, await decodedUrl(frame.blob));
    } else {
      swapImage(cached.url, current.id);
      elements.announcer.textContent = `Showing frame ${current.id}`;
    }
    applyHistory(await selectHistoryItem(targetIndex));
  } catch (error) {
    // A failed restore at startup keeps the target, so "Show frame N" retries it.
    index = previousIndex >= 0 ? previousIndex : targetIndex;
    showError(error, () => goTo(targetIndex), targetIndex);
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

function ledgerThumbnail(itemIndex: number): HTMLButtonElement | null {
  const item = history[itemIndex];
  const key = item && blobKey(item.source, item.id);
  const src = key && (blobs.get(key)?.url ?? thumbnails.get(key));
  if (!item || !src) return null;
  const button = document.createElement("button");
  const image = document.createElement("img");
  button.type = "button";
  button.className = "ledger__thumb";
  button.title = item.id;
  button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
  if (itemIndex === index) button.setAttribute("aria-current", "true");
  image.src = src;
  image.alt = "";
  image.loading = "lazy";
  button.append(image);
  button.addEventListener("click", () => {
    closeDialog(elements.statsDialog);
    void goTo(itemIndex);
  });
  return button;
}

function ledgerRow(day: LedgerDay, todayIso: string, maxDrawn: number): HTMLLIElement {
  const row = document.createElement("li");
  const date = document.createElement("span");
  const counts = document.createElement("span");
  const strip = document.createElement("div");
  const label = ledgerDateLabel(day.date, todayIso);
  row.className = "ledger__row";
  // Focusable only for Show earlier days to land on; the thumbnails are the tab stops.
  row.tabIndex = -1;
  row.setAttribute("aria-label", `${label}: ${formatLedgerCounts(day.drawn, day.unavailable)}`);
  date.className = "ledger__date";
  date.textContent = label;
  counts.className = "ledger__counts";
  counts.textContent = formatLedgerCounts(day.drawn, day.unavailable);
  strip.className = "ledger__strip";
  const thumbs: HTMLButtonElement[] = [];
  for (const itemIndex of day.frames) {
    if (thumbs.length === LEDGER_STRIP_MAX) break;
    const thumb = ledgerThumbnail(itemIndex);
    if (thumb) thumbs.push(thumb);
  }
  strip.append(...thumbs);
  const overflow = Math.max(day.drawn, day.frames.length) - thumbs.length;
  if (thumbs.length && overflow > 0) {
    const more = document.createElement("span");
    more.className = "ledger__more-count";
    more.textContent = `+${overflow.toLocaleString("en-US")}`;
    strip.append(more);
  }
  if (!thumbs.length && day.drawn) {
    // No saved thumbnails for this day: a hairline sized to its share of the busiest day.
    const bar = document.createElement("span");
    bar.className = "ledger__bar";
    bar.setAttribute("aria-hidden", "true");
    bar.style.setProperty?.("--share", String(day.drawn / maxDrawn));
    strip.append(bar);
  }
  row.append(date, counts, strip);
  return row;
}

// Rows render in pages of LEDGER_PAGE_DAYS, so months of activity never build one long list up front.
function renderLedgerPage(): HTMLLIElement | undefined {
  const todayIso = localDayKey(Date.now());
  const maxDrawn = Math.max(1, ...ledger.map((day) => day.drawn));
  const rows = ledger
    .slice(ledgerShown, ledgerShown + LEDGER_PAGE_DAYS)
    .map((day) => ledgerRow(day, todayIso, maxDrawn));
  elements.ledgerList.append(...rows);
  ledgerShown += rows.length;
  elements.ledgerMore.hidden = ledgerShown >= ledger.length;
  return rows[0];
}

function renderLedger(days: LedgerDay[]): void {
  ledger = days;
  ledgerShown = 0;
  elements.ledgerList.replaceChildren();
  elements.ledgerEmpty.hidden = days.length > 0;
  elements.statsBody.scrollTop = 0;
  renderLedgerPage();
}

function openHistory(): void {
  if (loading) return;
  elements.historyClear.disabled = !history.length;
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
// which blocks window drag/controls; show() plus manual inert on main
// keeps the titlebar usable while a dialog is open.
const dialogs = [
  elements.entryDialog,
  elements.historyDialog,
  elements.statsDialog,
  elements.lightboxDialog,
  elements.shortcutsDialog,
];

function openDialog(dialog: HTMLDialogElement, variant?: "dark"): void {
  elements.main.inert = true;
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

// Arrows only move through history. Past the last frame they point at Draw next instead of drawing.
function goNext(): void {
  const targetIndex = nextHistoryIndex(index, history.length);
  if (targetIndex !== null) return void goTo(targetIndex);
  if (loading) return;
  restartAnimation(elements.draw);
  elements.draw.dataset.pulse = "";
  // A trailing no-break space alternates, so screen readers announce a repeated press too.
  const notice = "This is the newest frame. Press N to draw next.";
  elements.announcer.textContent = elements.announcer.textContent === notice ? `${notice}\u00a0` : notice;
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
    showError(error, () => loadAdjacent(offset));
  } finally {
    finishLoading();
  }
}

async function saveCurrent(): Promise<void> {
  const current = history[index];
  const cached = current && blobs.get(blobKey(current.source, current.id));
  if (!current || !cached) return;
  if (!(await saveImage(current.id, cached.blob))) return;
  savedFrames.add(blobKey(current.source, current.id));
  if (history[index] !== current) return;
  elements.save.dataset.saved = "new";
  syncControls();
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
    toast.success("Copied source link");
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
    // The History button no longer leads anywhere useful; the next step is a draw.
    historyReturnFocus = elements.draw;
    closeDialog(elements.historyDialog);
    toast.success("History cleared");
  } catch (error) {
    toast.error(describeError(error, "History could not be cleared. Try again.").message);
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
    // The stage starts blank, so a restored frame never flashes the first-draw prompt on launch.
    if (snapshot.index >= 0) await goTo(snapshot.index);
    else {
      setState("empty");
      if (!elements.entryDialog.open) elements.draw.focus();
    }
  } catch (error) {
    loading = false;
    showError(error, initialize);
    syncControls();
  }
}

// aria-disabled buttons still fire clicks; goTo and loadRandom already ignore them while loading or paused.
elements.draw.addEventListener("click", () => void loadRandom());
elements.draw.addEventListener("animationend", () => delete elements.draw.dataset.pulse);
elements.retry.addEventListener("click", () => {
  // A history frame is fetched from the source too, so every retry honors the cooldown.
  if (!drawPaused()) void retryAction();
});
elements.back.addEventListener("click", () => void goTo(index));
elements.next.addEventListener("click", goNext);
elements.previous.addEventListener("click", goBack);
elements.previousId.addEventListener("click", () => void loadAdjacent(-1));
elements.nextId.addEventListener("click", () => void loadAdjacent(1));
elements.idMenu.addEventListener("beforetoggle", (event) => {
  if ((event as ToggleEvent).newState !== "open") return;
  const rect = elements.idMenuButton.getBoundingClientRect();
  elements.idMenu.style.left = `${rect.left}px`;
  elements.idMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
});
for (const [item, offset] of [
  [elements.previousIdMenuItem, -1],
  [elements.nextIdMenuItem, 1],
] as const) {
  item.addEventListener("click", () => {
    elements.idMenu.hidePopover?.();
    void loadAdjacent(offset);
  });
}
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
elements.historyPagePrevious.addEventListener("click", () => showHistoryPage(pageIndex - 1));
elements.historyPageNext.addEventListener("click", () => showHistoryPage(pageIndex + 1));
elements.historyPageSize.addEventListener("change", changePageSize);
elements.historyDialog.addEventListener("close", () => {
  // Hiding mid-hold cancels the fill without a transitionend; drop the hold silently.
  stopClearHold();
  // Main is inert until onDialogClosed, and focus() on an inert element is ignored.
  onDialogClosed();
  historyReturnFocus.focus();
  historyReturnFocus = elements.historyButton;
});
async function loadStats(): Promise<void> {
  try {
    const [exploration, activity] = await Promise.all([getExplorationStats(), getViewingActivity()]);
    elements.statsToday.textContent = String(activity.days.at(-1)?.viewed ?? 0);
    elements.statsTotal.textContent = activity.viewedTotal.toLocaleString("en-US");
    elements.statsStreak.textContent = drawStreak(activity.days).toLocaleString("en-US");
    elements.statsExplored.textContent = `${exploration.explored.toLocaleString("en-US")} / ${exploration.total.toLocaleString("en-US")}`;
    elements.statsExploredPercent.textContent = `${formatExploredPercent(exploration.explored, exploration.total)} of known legacy ID space`;
    elements.statsExploredBreakdown.textContent = formatExploredBreakdown(
      exploration.explored,
      exploration.viewable,
      exploration.unavailable,
    );
    renderLedger(
      ledgerDays(
        activity.days,
        history.map((item) => item.viewedAt),
      ),
    );
    delete elements.statsExplored.dataset.state;
    elements.statsError.hidden = true;
    elements.ledger.hidden = false;
  } catch {
    // Dashes, not zeros: the counts are unknown, not empty.
    elements.statsToday.textContent = "—";
    elements.statsTotal.textContent = "—";
    elements.statsStreak.textContent = "—";
    elements.statsExplored.textContent = "Unavailable";
    elements.statsExplored.dataset.state = "unavailable";
    elements.statsExploredPercent.textContent = "";
    elements.statsExploredBreakdown.textContent = "";
    elements.statsError.hidden = false;
    elements.ledger.hidden = true;
  }
}
elements.statsButton.addEventListener("click", async () => {
  await loadStats();
  openDialog(elements.statsDialog);
});
elements.statsRetry.addEventListener("click", async () => {
  await loadStats();
  if (elements.statsError.hidden) elements.statsClose.focus();
  // A fresh toast node each time, so repeat failures are announced again.
  else toast.error("Stats still couldn’t be read");
});
elements.ledgerMore.addEventListener("click", () => renderLedgerPage()?.focus());
elements.statsClose.addEventListener("click", () => closeDialog(elements.statsDialog));
elements.statsDialog.addEventListener("close", () => {
  onDialogClosed();
  elements.statsButton.focus();
});
// Focus returns to whatever had it: the sheet opens from the titlebar or from ? anywhere.
let shortcutsOpener: HTMLElement | null = null;
function openShortcuts(): void {
  shortcutsOpener = document.activeElement as HTMLElement | null;
  openDialog(elements.shortcutsDialog);
}
elements.shortcutsButton.addEventListener("click", openShortcuts);
elements.shortcutsClose.addEventListener("click", () => closeDialog(elements.shortcutsDialog));
elements.shortcutsDialog.addEventListener("close", () => {
  onDialogClosed();
  (shortcutsOpener ?? elements.shortcutsButton).focus?.();
});
elements.imageZoom.addEventListener("click", openLightbox);
elements.imageGhost.addEventListener("animationend", () => {
  elements.imageGhost.hidden = true;
});
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
// The position readout turns into the number field in place, and back once the jump is made or dropped.
function editPosition(editing: boolean): void {
  elements.positionButton.hidden = editing;
  elements.jumpForm.hidden = !editing;
  if (!editing) {
    elements.positionButton.focus();
    return;
  }
  elements.jumpInput.value = String(index + 1);
  elements.jumpInput.setCustomValidity("");
  elements.jumpInput.focus();
  elements.jumpInput.select?.();
}
elements.positionButton.addEventListener("click", () => editPosition(true));
elements.jumpInput.addEventListener("input", () => elements.jumpInput.setCustomValidity(""));
elements.jumpInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") editPosition(false);
});
elements.jumpInput.addEventListener("blur", () => {
  if (!elements.jumpForm.hidden) {
    elements.jumpForm.hidden = true;
    elements.positionButton.hidden = false;
  }
});
elements.jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const targetIndex = frameNumberToIndex(elements.jumpInput.value, history.length);
  if (targetIndex === null) {
    elements.jumpInput.setCustomValidity(`Enter a number between 1 and ${history.length}.`);
    elements.jumpInput.reportValidity();
    return;
  }
  editPosition(false);
  void goTo(targetIndex);
});

const CONTROL_SELECTOR = "a, button, input, select, textarea, summary, [tabindex]";

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || elements.entryDialog.open) return;
  const target = event.target as HTMLElement | null;
  // The jump field owns its own keys: arrows move the caret, Enter submits.
  if (target?.tagName === "INPUT") return;
  // ? toggles the sheet, so the key that opened it also closes it.
  if (event.key === "?" && !event.repeat) {
    if (elements.shortcutsDialog.open) closeDialog(elements.shortcutsDialog);
    else if (!dialogs.some((dialog) => dialog.open)) openShortcuts();
    return;
  }
  // The ID menu popover is not a dialog but still owns the keyboard while open.
  if (dialogs.some((dialog) => dialog.open) || elements.idMenu.matches?.(":popover-open")) return;
  if (event.key === "ArrowLeft") goBack();
  if (event.key === "ArrowRight") goNext();
  if (!event.repeat) {
    const key = event.key.toLowerCase();
    if (key === "s") void saveCurrent();
    if (key === "c") void copyCurrentImage();
    if (key === "h") openHistory();
  }
  // N draws from anywhere; Space and Enter only when no control has focus to claim them.
  const onControl = Boolean(target?.closest?.(CONTROL_SELECTOR));
  if (event.key === "n" || event.key === "N" || (!onControl && (event.key === " " || event.key === "Enter"))) {
    event.preventDefault();
    if (!event.repeat) void loadRandom();
  }
});

window.addEventListener("pagehide", () => {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
});

document.querySelectorAll<HTMLAnchorElement>(".external-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (link.getAttribute("aria-disabled") !== "true" && link.href) void openUrl(link.href);
  });
});

syncControls();
void initialize();
void checkForUpdate();
void migrateLegacyStats();

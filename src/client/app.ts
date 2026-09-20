import { openUrl } from "@tauri-apps/plugin-opener";
import type { Frame } from "./api.js";
import { getFrameById, getRandomFrame } from "./api.js";
import { elements } from "./elements.js";
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
import { clearHistory, getExplorationStats, getHistory, recordHistoryItem, selectHistoryItem } from "./persistence.js";
import { createViewingStats, formatExploredPercent } from "./statistics.js";
import { toast } from "./toast.js";

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
const history: HistoryItem[] = [];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = true;
const viewingStats = createViewingStats(() => localStorage);

function blobKey(source: string, id: string): string {
  return `${source}:${id}`;
}

function applyHistory(snapshot: HistorySnapshot): void {
  history.splice(0, history.length, ...snapshot.history);
  index = snapshot.index;
}

try {
  if (shouldShowEntryDialog(localStorage.getItem(entryStorageKey))) elements.entryDialog.showModal();
} catch {
  elements.entryDialog.showModal();
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
  elements.historyClear.disabled = loading || !history.length;
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
  blobs.set(blobKey(source, id), { blob, url });
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
  viewingStats.recordView();
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

// renders only the most recent tiles so the dialog never lays out
// thousands of DOM nodes; virtualize the grid if this cap needs raising.
const MAX_HISTORY_TILES = 300;

function openHistory(): void {
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !history.length;
  elements.historyEmpty.hidden = Boolean(history.length);
  elements.historyClear.disabled = !history.length;

  const startIndex = Math.max(0, history.length - MAX_HISTORY_TILES);
  for (const [offset, item] of history.slice(startIndex).entries()) {
    const itemIndex = startIndex + offset;
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    button.className = "history-item";
    button.type = "button";
    button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
    if (itemIndex === index) button.setAttribute("aria-current", "true");
    image.src = blobs.get(blobKey(item.source, item.id))?.url ?? "";
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

  elements.historyDialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement): void {
  const classList = (dialog as unknown as { classList?: DOMTokenList }).classList;
  if (!classList) {
    dialog.close();
    return;
  }
  if (classList.contains("is-closing")) return;
  classList.add("is-closing");
  const fallback = setTimeout(() => dialog.close(), 250);
  dialog.addEventListener(
    "transitionend",
    (event) => {
      if (event.target !== dialog || event.propertyName !== "opacity") return;
      clearTimeout(fallback);
      dialog.close();
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
  if (loading || !history.length) return;
  loading = true;
  syncControls();
  try {
    await clearHistory();
    history.length = 0;
    index = -1;
    viewingStats.reset();
    for (const { url } of blobs.values()) URL.revokeObjectURL(url);
    blobs.clear();
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
  elements.lightboxDialog.showModal();
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
elements.historyClear.addEventListener("click", () => void clearSavedHistory());
elements.historyDialog.addEventListener("click", (event) => {
  if (event.target === elements.historyDialog) closeDialog(elements.historyDialog);
});
elements.historyDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog(elements.historyDialog);
});
elements.historyDialog.addEventListener("close", () => {
  elements.historyDialog.classList?.remove("is-closing");
  elements.historyButton.focus();
});
elements.statsButton.addEventListener("click", async () => {
  const stats = viewingStats.current();
  elements.statsToday.textContent = String(stats.today);
  elements.statsTotal.textContent = String(stats.total);
  try {
    const exploration = await getExplorationStats();
    elements.statsExplored.textContent = `${exploration.explored.toLocaleString("en-US")} / ${exploration.total.toLocaleString("en-US")}`;
    elements.statsExploredPercent.textContent = `${formatExploredPercent(exploration.explored, exploration.total)} of known legacy ID space`;
  } catch {
    elements.statsExplored.textContent = "Unavailable";
    elements.statsExploredPercent.textContent = "Could not read local exploration data";
  }
  elements.statsDialog.showModal();
});
elements.statsClose.addEventListener("click", () => closeDialog(elements.statsDialog));
elements.statsDialog.addEventListener("click", (event) => {
  if (event.target === elements.statsDialog) closeDialog(elements.statsDialog);
});
elements.statsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog(elements.statsDialog);
});
elements.statsDialog.addEventListener("close", () => {
  elements.statsDialog.classList?.remove("is-closing");
  elements.statsButton.focus();
});
elements.imageZoom.addEventListener("click", openLightbox);
elements.lightboxDialog.addEventListener("click", () => elements.lightboxDialog.close());
elements.lightboxClose.addEventListener("click", (event) => {
  event.stopPropagation();
  elements.lightboxDialog.close();
});
elements.lightboxDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  elements.lightboxDialog.close();
});
elements.lightboxDialog.addEventListener("close", () => elements.imageZoom.focus());
elements.entryConsent.addEventListener("change", () => {
  elements.entryButton.disabled = !elements.entryConsent.checked;
});
elements.entryDialog.addEventListener("cancel", (event) => event.preventDefault());
elements.entryButton.addEventListener("click", () => {
  if (!elements.entryConsent.checked) return;
  try {
    localStorage.setItem(entryStorageKey, "accepted");
  } catch {
    // Ignore errors, the dialog will just show again next time
  }
  elements.entryDialog.close();
  elements.start.focus();
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

for (const link of document.querySelectorAll<HTMLAnchorElement>(".external-link")) {
  link.addEventListener("click", (event) => {
    if (link.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    void openUrl(link.href);
  });
}

syncControls();
void initialize();

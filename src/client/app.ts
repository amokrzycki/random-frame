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
import { createViewingStats } from "./statistics.js";
import { toast } from "./toast.js";

interface HistoryItem {
  id: string;
}

interface CachedBlob {
  blob: Blob;
  url: string;
}

type ViewState = "empty" | "loading" | "error" | "image";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The image could not be loaded";
}

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
const storedHistory = historyFromStorage(navigation?.type === "reload" ? null : sessionStorage.getItem(storageKey));
const history: HistoryItem[] = [...storedHistory.history];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = false;
const viewingStats = createViewingStats(() => localStorage);

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
    image: elements.image,
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
  elements.save.disabled = loading || !current || !blobs.has(current.id);
  elements.copyImage.disabled = loading || !current || !blobs.has(current.id);
  elements.copyLink.disabled = loading || !current;
  elements.previousId.disabled = loading || !current || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = loading || !current || adjacentPrntscId(current.id, 1) === null;
  elements.jumpInput.disabled = loading || !history.length;
  elements.jumpButton.disabled = loading || !history.length;
  elements.jumpInput.max = String(history.length);
  if (document.activeElement !== elements.jumpInput) elements.jumpInput.value = String(history.length ? index + 1 : 0);
  elements.historyTotal.textContent = String(history.length);
  elements.next.setAttribute(
    "aria-label",
    index < history.length - 1 ? "Show the next saved frame" : "Draw a new frame",
  );
  elements.imageId.textContent = current ? `prnt.sc/${current.id}` : "prnt.sc/———";
  elements.source.href = current ? `https://prnt.sc/${current.id}` : "https://prnt.sc/";
  elements.source.setAttribute("aria-disabled", String(!current));
  elements.meta.textContent = current
    ? `Source: Prnt.sc · frame ${current.id}`
    : "One public image. No feed, no profile.";
  sessionStorage.setItem(storageKey, JSON.stringify({ history, index }));
}

function showFrame(id: string, blob: Blob): void {
  const oldUrl = elements.image.src;
  const url = URL.createObjectURL(blob);
  blobs.set(id, { blob, url });
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

async function loadRandom(): Promise<void> {
  if (loading) return;
  loading = true;
  setState("loading");
  syncControls();
  try {
    const frame = await getRandomFrame();
    history.push({ id: frame.id });
    index = history.length - 1;
    viewingStats.recordView();
    showFrame(frame.id, frame.blob);
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
  index = targetIndex;
  const cached = blobs.get(current.id);
  if (cached) {
    elements.image.src = cached.url;
    elements.image.alt = `Public image from Prnt.sc with identifier ${current.id}`;
    setState("image");
    elements.announcer.textContent = `Showing frame ${current.id}`;
  } else {
    setState("loading");
    syncControls();
    try {
      const frame = await getFrameById(current.id);
      showFrame(current.id, frame.blob);
    } catch (error) {
      index = previousIndex;
      setState("error", errorMessage(error));
    }
  }
  loading = false;
  syncControls();
}

function openHistory(): void {
  const stored = historyFromStorage(sessionStorage.getItem(storageKey));
  elements.historyGrid.replaceChildren();
  elements.historyGrid.hidden = !stored.history.length;
  elements.historyEmpty.hidden = Boolean(stored.history.length);

  for (const [itemIndex, item] of stored.history.entries()) {
    const button = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    button.className = "history-item";
    button.type = "button";
    button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
    if (itemIndex === stored.index) button.setAttribute("aria-current", "true");
    image.src = blobs.get(item.id)?.url ?? "";
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
    history.push({ id: frame.id });
    index = history.length - 1;
    viewingStats.recordView();
    showFrame(frame.id, frame.blob);
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
  const cached = current && blobs.get(current.id);
  if (!current || !cached) return;
  await saveImage(current.id, cached.blob, elements.announcer);
}

async function copyCurrentImage(): Promise<void> {
  const current = history[index];
  const cached = current && blobs.get(current.id);
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
elements.statsButton.addEventListener("click", () => {
  const stats = viewingStats.current();
  elements.statsToday.textContent = String(stats.today);
  elements.statsTotal.textContent = String(stats.total);
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
    elements.entryDialog.open
  )
    return;
  if (event.key === "ArrowLeft") goBack();
  if (event.key === "ArrowRight" && index >= 0) goNext();
});

window.addEventListener("pagehide", () => {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
});

syncControls();
if (storedHistory.index >= 0) void goTo(storedHistory.index);

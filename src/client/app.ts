import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getFrameById, getRandomFrame } from "./api.js";
import {
  adjacentPrntscId,
  frameNumberToIndex,
  historyFromStorage,
  historyIndexForId,
  nextHistoryIndex,
  shouldShowEntryDialog,
} from "./navigation.js";
import { toast } from "./toast.js";

interface HistoryItem {
  id: string;
}

interface CachedBlob {
  blob: Blob;
  url: string;
}

interface ViewingStats {
  day: string;
  today: number;
  total: number;
}

type ViewState = "empty" | "loading" | "error" | "image";

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing required element: ${selector}`);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The image could not be loaded";
}

const storageKey = "prntsc-gallery-history";
const entryStorageKey = "random-frame-risk-accepted";
const statsStorageKey = "random-frame-viewing-stats";
const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
const storedHistory = historyFromStorage(navigation?.type === "reload" ? null : sessionStorage.getItem(storageKey));
const history: HistoryItem[] = [...storedHistory.history];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = false;

function currentDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readStats(): ViewingStats {
  const day = currentDay();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(statsStorageKey) ?? "");
    if (
      typeof stored === "object" &&
      stored !== null &&
      "day" in stored &&
      "today" in stored &&
      "total" in stored &&
      typeof stored.day === "string" &&
      typeof stored.today === "number" &&
      Number.isInteger(stored.today) &&
      stored.today >= 0 &&
      typeof stored.total === "number" &&
      Number.isInteger(stored.total) &&
      stored.total >= stored.today
    )
      return { day, today: stored.day === day ? stored.today : 0, total: stored.total };
  } catch {
    // Use fresh in-memory statistics when browser storage is unavailable or invalid
  }
  return { day, today: 0, total: 0 };
}

let stats = readStats();

function recordView(): void {
  if (stats.day !== currentDay()) stats = { ...stats, day: currentDay(), today: 0 };
  stats.today += 1;
  stats.total += 1;
  try {
    localStorage.setItem(statsStorageKey, JSON.stringify(stats));
  } catch {
    // Keep counting in memory for this page view
  }
}

const elements = {
  image: element<HTMLImageElement>("#image"),
  empty: element<HTMLElement>("#empty-state"),
  loading: element<HTMLElement>("#loading-state"),
  error: element<HTMLElement>("#error-state"),
  errorMessage: element<HTMLElement>("#error-message"),
  start: element<HTMLButtonElement>("#start-button"),
  retry: element<HTMLButtonElement>("#retry-button"),
  previous: element<HTMLButtonElement>("#previous-button"),
  next: element<HTMLButtonElement>("#next-button"),
  save: element<HTMLButtonElement>("#save-button"),
  copyLink: element<HTMLButtonElement>("#copy-link-button"),
  source: element<HTMLAnchorElement>("#source-link"),
  imageId: element<HTMLElement>("#image-id"),
  previousId: element<HTMLButtonElement>("#previous-id-button"),
  nextId: element<HTMLButtonElement>("#next-id-button"),
  jumpForm: element<HTMLFormElement>("#jump-form"),
  jumpInput: element<HTMLInputElement>("#jump-input"),
  jumpButton: element<HTMLButtonElement>("#jump-button"),
  historyTotal: element<HTMLOutputElement>("#history-total"),
  historyButton: element<HTMLButtonElement>("#history-button"),
  historyDialog: element<HTMLDialogElement>("#history-dialog"),
  historyClose: element<HTMLButtonElement>("#history-close-button"),
  historyGrid: element<HTMLElement>("#history-grid"),
  historyEmpty: element<HTMLElement>("#history-empty"),
  statsButton: element<HTMLButtonElement>("#stats-button"),
  statsDialog: element<HTMLDialogElement>("#stats-dialog"),
  statsClose: element<HTMLButtonElement>("#stats-close-button"),
  statsToday: element<HTMLElement>("#stats-today"),
  statsTotal: element<HTMLElement>("#stats-total"),
  meta: element<HTMLElement>("#frame-meta"),
  announcer: element<HTMLElement>("#announcer"),
  entryDialog: element<HTMLDialogElement>("#entry-dialog"),
  entryConsent: element<HTMLInputElement>("#entry-consent"),
  entryButton: element<HTMLButtonElement>("#entry-button"),
};

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
    recordView();
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
      elements.historyDialog.close();
      void goTo(itemIndex);
    });
    elements.historyGrid.append(button);
  }

  elements.historyDialog.showModal();
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
    recordView();
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

function imageExtension(mimeType: string): string {
  const subtype =
    mimeType
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase()
      .replace(/^image\//, "") ?? "";
  const aliases: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg", tiff: "tif", "x-icon": "ico" };
  return aliases[subtype] ?? (subtype.replace(/[^a-z0-9]/g, "") || "img");
}

async function saveCurrent(): Promise<void> {
  const current = history[index];
  const cached = current && blobs.get(current.id);
  if (!current || !cached) return;
  const extension = imageExtension(cached.blob.type);
  try {
    const path = await save({
      title: "Save image",
      defaultPath: `random-frame-prntsc-${current.id}.${extension}`,
      filters: [{ name: "Image", extensions: [extension] }],
    });
    if (!path) return;
    await writeFile(path, new Uint8Array(await cached.blob.arrayBuffer()));
    elements.announcer.textContent = `Saved frame ${current.id}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be saved";
    toast.error(message);
    elements.announcer.textContent = `Error: ${message}`;
  }
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
elements.copyLink.addEventListener("click", () => void copySourceLink());
elements.historyButton.addEventListener("click", openHistory);
elements.historyClose.addEventListener("click", () => elements.historyDialog.close());
elements.historyDialog.addEventListener("click", (event) => {
  if (event.target === elements.historyDialog) elements.historyDialog.close();
});
elements.historyDialog.addEventListener("close", () => elements.historyButton.focus());
elements.statsButton.addEventListener("click", () => {
  if (stats.day !== currentDay()) stats = { ...stats, day: currentDay(), today: 0 };
  elements.statsToday.textContent = String(stats.today);
  elements.statsTotal.textContent = String(stats.total);
  elements.statsDialog.showModal();
});
elements.statsClose.addEventListener("click", () => elements.statsDialog.close());
elements.statsDialog.addEventListener("click", (event) => {
  if (event.target === elements.statsDialog) elements.statsDialog.close();
});
elements.statsDialog.addEventListener("close", () => elements.statsButton.focus());
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

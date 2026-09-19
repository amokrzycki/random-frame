import {
  adjacentPrntscId,
  frameNumberToIndex,
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
const history: HistoryItem[] = [];
const blobs = new Map<string, CachedBlob>();
let index = -1;
let loading = false;

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
  meta: element<HTMLElement>("#frame-meta"),
  announcer: element<HTMLElement>("#announcer"),
  entryDialog: element<HTMLDialogElement>("#entry-dialog"),
  entryConsent: element<HTMLInputElement>("#entry-consent"),
  entryButton: element<HTMLButtonElement>("#entry-button"),
};

sessionStorage.removeItem(storageKey);

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

async function responseToFrame(response: Response): Promise<{ id: string; blob: Blob }> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const responseError = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const message = responseError ? String(responseError) : "The image could not be loaded";
    throw new Error(message);
  }
  const id = response.headers.get("x-prntsc-id");
  if (!id) throw new Error("The source did not provide an image identifier");
  return { id, blob: await response.blob() };
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
    const frame = await responseToFrame(await fetch("/api/random", { cache: "no-store" }));
    history.push({ id: frame.id });
    index = history.length - 1;
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
      const frame = await responseToFrame(await fetch(`/api/image/${current.id}`));
      showFrame(current.id, frame.blob);
    } catch (error) {
      index = previousIndex;
      setState("error", errorMessage(error));
    }
  }
  loading = false;
  syncControls();
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
    const frame = await responseToFrame(await fetch(`/api/image/${id}`, { cache: "no-store" }));
    history.push({ id: frame.id });
    index = history.length - 1;
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

function saveCurrent(): void {
  const current = history[index];
  const cached = current && blobs.get(current.id);
  if (!current || !cached) return;
  const extension = cached.blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const link = document.createElement("a");
  link.href = cached.url;
  link.download = `random-frame-prntsc-${current.id}.${extension}`;
  link.click();
  elements.announcer.textContent = `Saved frame ${current.id}`;
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
elements.save.addEventListener("click", saveCurrent);
elements.copyLink.addEventListener("click", () => void copySourceLink());
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
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") goBack();
  if (event.key === "ArrowRight" && index >= 0) goNext();
});

window.addEventListener("pagehide", () => {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
});

syncControls();

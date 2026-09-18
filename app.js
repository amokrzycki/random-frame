import { adjacentPrntscId, frameNumberToIndex, nextHistoryIndex } from "./navigation.js";

const storageKey = "prntsc-gallery-history";
const history = [];
const blobs = new Map();
let index = -1;
let loading = false;

const elements = {
  stage: document.querySelector("#stage"),
  image: document.querySelector("#image"),
  empty: document.querySelector("#empty-state"),
  loading: document.querySelector("#loading-state"),
  error: document.querySelector("#error-state"),
  errorMessage: document.querySelector("#error-message"),
  start: document.querySelector("#start-button"),
  retry: document.querySelector("#retry-button"),
  previous: document.querySelector("#previous-button"),
  next: document.querySelector("#next-button"),
  save: document.querySelector("#save-button"),
  source: document.querySelector("#source-link"),
  imageId: document.querySelector("#image-id"),
  previousId: document.querySelector("#previous-id-button"),
  nextId: document.querySelector("#next-id-button"),
  jumpForm: document.querySelector("#jump-form"),
  jumpInput: document.querySelector("#jump-input"),
  jumpButton: document.querySelector("#jump-button"),
  historyTotal: document.querySelector("#history-total"),
  meta: document.querySelector("#frame-meta"),
  announcer: document.querySelector("#announcer"),
};

sessionStorage.removeItem(storageKey);

function setState(state, message = "") {
  for (const [name, element] of Object.entries({ empty: elements.empty, loading: elements.loading, error: elements.error, image: elements.image })) {
    element.hidden = name !== state;
  }
  if (message) elements.errorMessage.textContent = message;
  if (state === "loading") elements.announcer.textContent = "Finding an available frame";
}

function syncControls() {
  const current = history[index];
  elements.previous.disabled = loading || index <= 0;
  elements.next.disabled = loading || index < 0;
  elements.save.disabled = loading || !current || !blobs.has(current.id);
  elements.previousId.disabled = loading || !current || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = loading || !current || adjacentPrntscId(current.id, 1) === null;
  elements.jumpInput.disabled = loading || !history.length;
  elements.jumpButton.disabled = loading || !history.length;
  elements.jumpInput.max = history.length;
  if (document.activeElement !== elements.jumpInput) elements.jumpInput.value = history.length ? index + 1 : 0;
  elements.historyTotal.textContent = history.length;
  elements.next.setAttribute("aria-label", index < history.length - 1 ? "Show the next saved frame" : "Draw a new frame");
  elements.imageId.textContent = current ? `prnt.sc/${current.id}` : "prnt.sc/———";
  elements.source.href = current ? `https://prnt.sc/${current.id}` : "https://prnt.sc/";
  elements.source.setAttribute("aria-disabled", String(!current));
  elements.meta.textContent = current ? `Source: Prnt.sc · frame ${current.id}` : "One public image. No feed, no profile.";
  sessionStorage.setItem(storageKey, JSON.stringify({ history, index }));
}

async function responseToFrame(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "The image could not be loaded");
  }
  const id = response.headers.get("x-prntsc-id");
  if (!id) throw new Error("The source did not provide an image identifier");
  return { id, blob: await response.blob() };
}

function showFrame(id, blob) {
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
  if (oldUrl.startsWith("blob:") && ![...blobs.values()].some((item) => item.url === oldUrl)) URL.revokeObjectURL(oldUrl);
}

async function loadRandom() {
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
    setState("error", error.message);
    elements.announcer.textContent = `Error: ${error.message}`;
  } finally {
    loading = false;
    syncControls();
  }
}

async function goTo(targetIndex) {
  if (loading || targetIndex === index || targetIndex < 0 || targetIndex >= history.length) return;
  loading = true;
  const previousIndex = index;
  index = targetIndex;
  const { id } = history[index];
  const cached = blobs.get(id);
  if (cached) {
    elements.image.src = cached.url;
    elements.image.alt = `Public image from Prnt.sc with identifier ${id}`;
    setState("image");
    elements.announcer.textContent = `Showing frame ${id}`;
  } else {
    setState("loading");
    syncControls();
    try {
      const frame = await responseToFrame(await fetch(`/api/image/${id}`));
      showFrame(id, frame.blob);
    } catch (error) {
      index = previousIndex;
      setState("error", error.message);
    }
  }
  loading = false;
  syncControls();
}

function goBack() {
  goTo(index - 1);
}

function goNext() {
  const targetIndex = nextHistoryIndex(index, history.length);
  if (targetIndex === null) loadRandom();
  else goTo(targetIndex);
}

async function loadAdjacent(offset) {
  const current = history[index];
  const id = current && adjacentPrntscId(current.id, offset);
  if (loading || !id) return;
  loading = true;
  setState("loading");
  syncControls();
  try {
    const frame = await responseToFrame(await fetch(`/api/image/${id}`, { cache: "no-store" }));
    history.push({ id: frame.id });
    index = history.length - 1;
    showFrame(frame.id, frame.blob);
  } catch (error) {
    setState("error", error.message);
    elements.announcer.textContent = `Error: ${error.message}`;
  } finally {
    loading = false;
    syncControls();
  }
}

function saveCurrent() {
  const current = history[index];
  const cached = current && blobs.get(current.id);
  if (!cached) return;
  const extension = cached.blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const link = document.createElement("a");
  link.href = cached.url;
  link.download = `random-frame-prntsc-${current.id}.${extension}`;
  link.click();
  elements.announcer.textContent = `Saved frame ${current.id}`;
}

elements.start.addEventListener("click", loadRandom);
elements.retry.addEventListener("click", loadRandom);
elements.next.addEventListener("click", goNext);
elements.previous.addEventListener("click", goBack);
elements.previousId.addEventListener("click", () => loadAdjacent(-1));
elements.nextId.addEventListener("click", () => loadAdjacent(1));
elements.save.addEventListener("click", saveCurrent);
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
  goTo(targetIndex);
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

import type { Frame } from "./api.js";
import { getFrameById, getRandomFrame } from "./api.js";
import { elements } from "./elements.js";
import { blobKey, blobs } from "./frame-cache.js";
import { adjacentPrntscId, frameNumberToIndex, historyIndexForId, nextHistoryIndex } from "./navigation.js";
import { recordHistoryItem, selectHistoryItem } from "./persistence.js";
import {
  decodedUrl,
  drawPaused,
  finishLoading,
  getViewState,
  restartAnimation,
  retryFailed,
  setState,
  settleLoader,
  showError,
  showFrame,
  startLoading,
  swapImage,
  syncControls,
} from "./stage.js";
import { toast } from "./toast.js";
import { applyHistory, navigationView, state } from "./viewer-state.js";

const favoriteTipKey = "random-frame-favorite-tip";

let favoriteTipTimer: ReturnType<typeof setTimeout>;

// Give the first image time to settle; other notices and dialogs take priority.
function showFavoriteTip(): void {
  if (localStorage.getItem(favoriteTipKey) || state.favorites.length) return;
  clearTimeout(favoriteTipTimer);
  favoriteTipTimer = window.setTimeout(() => {
    if (
      state.favorites.length ||
      state.loading ||
      elements.main.inert ||
      getViewState() !== "image" ||
      document.querySelector(".toast")
    )
      return;
    localStorage.setItem(favoriteTipKey, "shown");
    toast.info("Tip: press F to favorite a frame.");
  }, 4000);
}

async function recordFrame(frame: Frame, canRecord = () => true): Promise<void> {
  const url = await decodedUrl(frame.blob);
  await settleLoader();
  if (!canRecord()) {
    URL.revokeObjectURL(url);
    return;
  }
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
let drawVersion = 0;
let drawCommitting = false;
let viewBeforeDraw: ReturnType<typeof getViewState> = "empty";

export function cancelDraw(): boolean {
  if (!state.drawing || drawCommitting) return false;
  drawVersion++;
  state.drawing = false;
  setState(viewBeforeDraw);
  finishLoading();
  elements.announcer.textContent = "Draw canceled";
  return true;
}

export async function loadRandom(): Promise<void> {
  if (state.loading || state.historyLoadFailed || drawPaused()) return;
  state.navigationMode = "history";
  state.historyTab = "history";
  state.historyReset = true;
  const version = ++drawVersion;
  viewBeforeDraw = getViewState();
  startLoading();
  state.drawing = true;
  setState("loading");
  elements.loading.dataset.cancelable = "";
  syncControls();
  try {
    const frame = await getRandomFrame();
    if (version !== drawVersion) return;
    await recordFrame(frame, () => {
      if (version !== drawVersion) return false;
      drawCommitting = true;
      return true;
    });
    if (version === drawVersion) showFavoriteTip();
  } catch (error) {
    if (version === drawVersion) showError(error, loadRandom);
  } finally {
    if (version === drawVersion) {
      drawCommitting = false;
      state.drawing = false;
      finishLoading();
    }
  }
}

export async function goTo(targetIndex: number): Promise<void> {
  // The shown index may be re-requested when an error covers it, so the frame can be recovered.
  if (
    state.loading ||
    (targetIndex === state.index && getViewState() === "image") ||
    targetIndex < 0 ||
    targetIndex >= state.history.length
  )
    return;
  const current = state.history[targetIndex];
  if (!current) return;
  startLoading();
  const previousIndex = state.index;
  const cached = blobs.get(blobKey(current.source, current.id));
  try {
    if (!cached) {
      setState("loading", `Restoring frame ${targetIndex + 1}…`);
      elements.announcer.textContent = `Restoring frame ${targetIndex + 1}`;
      syncControls();
      const frame = await getFrameById(current.id, current.source);
      const url = await decodedUrl(frame.blob);
      await settleLoader();
      showFrame(frame.source, frame.id, frame.blob, url);
    } else {
      swapImage(cached.url, current.id);
      elements.announcer.textContent = `Showing frame ${current.id}`;
    }
    applyHistory(await selectHistoryItem(targetIndex));
  } catch (error) {
    // A failed restore at startup keeps the target, so "Show frame N" retries it.
    state.index = previousIndex >= 0 ? previousIndex : targetIndex;
    showError(error, () => goTo(targetIndex), targetIndex);
  }
  finishLoading();
}

// Navigation positions may belong to favorites; persisted selection still belongs to history.
export async function goToPosition(position: number): Promise<void> {
  const item = navigationView().items[position];
  if (!item || state.loading) return;
  const index = state.history.findIndex((frame) => frame.source === item.source && frame.id === item.id);
  await (index >= 0 ? goTo(index) : loadById(item.id, item.source));
}

export function goBack(): void {
  void goToPosition(navigationView().index - 1);
}

// Past the last entry, arrows point at Draw instead of drawing.
export function goNext(): void {
  const view = navigationView();
  const targetIndex = nextHistoryIndex(view.index, view.items.length);
  if (targetIndex !== null) return void goToPosition(targetIndex);
  if (state.loading || state.historyLoadFailed || drawPaused()) return;
  restartAnimation(elements.draw);
  elements.draw.dataset.pulse = "";
  // A trailing no-break space alternates, so screen readers announce a repeated press too.
  const notice =
    view.items !== state.history
      ? "This is the last favorite. Press N to draw another."
      : "This is the newest frame. Press N to draw another.";
  elements.announcer.textContent = elements.announcer.textContent === notice ? `${notice} ` : notice;
}

// A frame already in history reopens there; any other id is fetched and joins the end of history.
export async function loadById(id: string, source = "prntsc"): Promise<void> {
  if (state.loading || state.historyLoadFailed) return;
  const savedIndex = historyIndexForId(state.history, id);
  if (savedIndex !== -1) return void goTo(savedIndex);
  if (drawPaused()) return;
  startLoading();
  setState("loading");
  syncControls();
  try {
    const frame = await getFrameById(id, source);
    await recordFrame(frame);
  } catch (error) {
    showError(error, () => loadById(id, source));
  } finally {
    finishLoading();
  }
}

async function loadAdjacent(offset: -1 | 1): Promise<void> {
  const current = state.history[state.index];
  const id = current && adjacentPrntscId(current.id, offset);
  if (id) await loadById(id);
}

// The position readout turns into the number field in place, and back once the jump is made or dropped.
function editPosition(editing: boolean): void {
  elements.positionButton.hidden = editing;
  elements.jumpForm.hidden = !editing;
  if (!editing) {
    elements.positionButton.focus();
    return;
  }
  elements.jumpInput.value = String(navigationView().index + 1);
  elements.jumpInput.setCustomValidity("");
  elements.jumpInput.focus();
  elements.jumpInput.select?.();
}

export function bindNavigationEvents(): void {
  // aria-disabled buttons still fire clicks; goTo and loadRandom already ignore them while loading or paused.
  elements.draw.addEventListener("click", () => void loadRandom());
  elements.draw.addEventListener("animationend", () => delete elements.draw.dataset.pulse);
  elements.retry.addEventListener("click", () => retryFailed());
  elements.back.addEventListener("click", () => void goTo(state.index));
  elements.next.addEventListener("click", goNext);
  elements.previous.addEventListener("click", goBack);
  elements.previousId.addEventListener("click", () => void loadAdjacent(-1));
  elements.nextId.addEventListener("click", () => void loadAdjacent(1));

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
    const targetIndex = frameNumberToIndex(elements.jumpInput.value, navigationView().items.length);
    if (targetIndex === null) {
      elements.jumpInput.setCustomValidity(`Enter a number between 1 and ${navigationView().items.length}.`);
      elements.jumpInput.reportValidity();
      return;
    }
    editPosition(false);
    void goToPosition(targetIndex);
  });
}

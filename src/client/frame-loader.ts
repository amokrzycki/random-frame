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
  showError,
  showFrame,
  startLoading,
  swapImage,
  syncControls,
} from "./stage.js";
import { applyHistory, state } from "./viewer-state.js";

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
export async function loadRandom(): Promise<void> {
  if (state.loading || drawPaused()) return;
  startLoading();
  state.drawing = true;
  elements.idMenu.hidePopover?.();
  setState("loading");
  syncControls();
  try {
    const frame = await getRandomFrame();
    await recordFrame(frame);
  } catch (error) {
    showError(error, loadRandom);
  } finally {
    state.drawing = false;
    finishLoading();
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
    state.index = previousIndex >= 0 ? previousIndex : targetIndex;
    showError(error, () => goTo(targetIndex), targetIndex);
  }
  finishLoading();
}

export function goBack(): void {
  void goTo(state.index - 1);
}

// Arrows only move through history. Past the last frame they point at Draw next instead of drawing.
export function goNext(): void {
  const targetIndex = nextHistoryIndex(state.index, state.history.length);
  if (targetIndex !== null) return void goTo(targetIndex);
  if (state.loading) return;
  restartAnimation(elements.draw);
  elements.draw.dataset.pulse = "";
  // A trailing no-break space alternates, so screen readers announce a repeated press too.
  const notice = "This is the newest frame. Press N to draw next.";
  elements.announcer.textContent = elements.announcer.textContent === notice ? `${notice} ` : notice;
}

async function loadAdjacent(offset: -1 | 1): Promise<void> {
  const current = state.history[state.index];
  const id = current && adjacentPrntscId(current.id, offset);
  if (state.loading || !id) return;
  const savedIndex = historyIndexForId(state.history, id);
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

// The position readout turns into the number field in place, and back once the jump is made or dropped.
function editPosition(editing: boolean): void {
  elements.positionButton.hidden = editing;
  elements.jumpForm.hidden = !editing;
  if (!editing) {
    elements.positionButton.focus();
    return;
  }
  elements.jumpInput.value = String(state.index + 1);
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
    const targetIndex = frameNumberToIndex(elements.jumpInput.value, state.history.length);
    if (targetIndex === null) {
      elements.jumpInput.setCustomValidity(`Enter a number between 1 and ${state.history.length}.`);
      elements.jumpInput.reportValidity();
      return;
    }
    editPosition(false);
    void goTo(targetIndex);
  });
}

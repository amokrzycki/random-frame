import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { blobKey, blobs, cacheThumbnail, savedFrames } from "./frame-cache.js";
import { adjacentPrntscId, nextHistoryIndex } from "./navigation.js";
import { toast } from "./toast.js";
import { state } from "./viewer-state.js";

type ViewState = "empty" | "loading" | "error" | "image";

let viewState: ViewState = "empty";
// Never actually invoked: the error state (and its Try again button) is only ever entered via showError,
// which always replaces this before retryFailed() could call it.
let retryAction: () => Promise<void> = async () => {
  // no-op default
};
let failedIndex = -1;
let cooldownUntil = 0;
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
let cooldownNoticeShown = false;

export function getViewState(): ViewState {
  return viewState;
}

const statePanels: Record<ViewState, HTMLElement> = {
  empty: elements.empty,
  loading: elements.loading,
  error: elements.error,
  image: elements.imageZoom,
};

export function setState(next: ViewState): void {
  // A shown frame stays on stage, dimmed under the loader or an error, so the next one can crossfade in.
  const keepFrame = (next === "loading" || next === "error") && !elements.imageZoom.hidden;
  viewState = next;
  for (const [name, target] of Object.entries(statePanels))
    target.hidden = name !== next && !(keepFrame && name === "image");
  elements.imageZoom.inert = keepFrame;
  if (keepFrame) elements.imageZoom.dataset.dimmed = "";
  else delete elements.imageZoom.dataset.dimmed;
  if (next === "loading") elements.announcer.textContent = "Finding an available frame";
}

const stateControls: Record<ViewState, HTMLElement | null> = {
  empty: elements.draw,
  loading: null,
  error: elements.retry,
  image: elements.draw,
};

export function startLoading(): void {
  state.loading = true;
  state.focusBeforeLoading = document.activeElement;
}

function focusLost(): boolean {
  return !document.activeElement || document.activeElement === document.body;
}

// Loading hides or disables the control that started it, which drops focus to <body>. Hand it back,
// or to the stage's own control when that one is gone (the start button, say), unless the visitor moved on.
export function finishLoading(): void {
  state.loading = false;
  syncControls();
  const target = state.focusBeforeLoading as HTMLElement | null;
  state.focusBeforeLoading = null;
  if (!target || target === document.body || !focusLost()) return;
  target.focus();
  if (focusLost()) stateControls[viewState]?.focus();
}

export function syncControls(): void {
  const current = state.history[state.index];
  // At 0/0 the arrows have nowhere to go; the empty stage points at Draw next instead.
  elements.previous.hidden = elements.next.hidden = !state.history.length;
  elements.previous.setAttribute("aria-disabled", String(state.loading || state.index <= 0));
  elements.next.setAttribute(
    "aria-disabled",
    String(state.loading || nextHistoryIndex(state.index, state.history.length) === null),
  );
  // Copy and save act on the visible frame only, never on one hidden behind an error.
  const currentBlob = viewState === "image" && current && blobs.has(blobKey(current.source, current.id));
  elements.save.disabled = state.loading || !currentBlob;
  // A saved frame keeps its check while shown; only a fresh save plays the arrow-to-check.
  if (current && savedFrames.has(blobKey(current.source, current.id))) elements.save.dataset.saved ??= "shown";
  else delete elements.save.dataset.saved;
  elements.save.title = elements.save.dataset.saved ? "Saved · Save again (S)" : "Save image (S)";
  elements.copyImage.disabled = state.loading || !currentBlob;
  elements.copyLink.disabled = state.loading || !current;
  elements.previousId.disabled =
    state.loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = state.loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, 1) === null;
  elements.previousIdMenuItem.disabled = elements.previousId.disabled;
  elements.nextIdMenuItem.disabled = elements.nextId.disabled;
  elements.idMenuButton.disabled = elements.previousId.disabled && elements.nextId.disabled;
  // History, the position readout, and the arrows stay enabled while loading (goTo ignores them), so they keep focus.
  const position = state.history.length ? state.index + 1 : 0;
  elements.positionButton.disabled = !state.history.length;
  elements.positionButton.setAttribute("aria-label", `Frame ${position} of ${state.history.length}. Jump to a frame`);
  elements.positionCurrent.textContent = String(position);
  elements.historyTotal.textContent = String(state.history.length);
  elements.jumpTotal.textContent = String(state.history.length);
  elements.jumpInput.max = String(state.history.length);
  elements.historyClear.disabled = state.loading || !state.history.length;
  elements.imageIdValue.textContent = current?.id ?? "———";
  // Without an href the link leaves the tab order and Enter has nothing to follow.
  if (current) elements.source.href = current.sourcePageUrl;
  else elements.source.removeAttribute("href");
  elements.source.setAttribute("aria-disabled", String(!current));
  // aria-disabled rather than disabled, so a focused retry or Draw next keeps focus through the countdown.
  const waitSeconds = cooldownSeconds();
  elements.retry.setAttribute("aria-disabled", String(waitSeconds > 0));
  elements.retry.textContent = waitSeconds ? `Try again in ${waitSeconds}s` : "Try again";
  elements.draw.setAttribute("aria-busy", String(state.drawing));
  elements.draw.setAttribute("aria-disabled", String(waitSeconds > 0));
  elements.drawLabel.textContent = waitSeconds ? `Wait ${waitSeconds}s` : "Draw next";
  // When the failed request was this very frame, Try again already says it.
  elements.back.hidden = !current || failedIndex === state.index;
  elements.back.textContent = `Show frame ${state.index + 1}`;
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
export function drawPaused(): boolean {
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
export function showError(error: unknown, retry: () => Promise<void>, failedAt = -1): void {
  retryAction = retry;
  failedIndex = failedAt;
  const { title, message, cooldownSeconds: seconds } = describeError(error);
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  setState("error");
  elements.announcer.textContent = `${title} ${message}`;
  if (seconds) startCooldown(seconds);
}

// A history frame is fetched from the source too, so every retry honors the cooldown.
export function retryFailed(): void {
  if (!drawPaused()) void retryAction();
}

// A blob that will not decode never reaches the stage or history, so the counter only claims frames that show.
export async function decodedUrl(blob: Blob): Promise<string> {
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

export function showFrame(source: string, id: string, blob: Blob, url: string): void {
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

export function restartAnimation(target: HTMLElement): void {
  target.style.animation = "none";
  void target.offsetWidth;
  target.style.animation = "";
}

// The outgoing frame fades out beneath the incoming one, so a draw never cuts through an empty stage.
export function swapImage(url: string, id: string): void {
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

export function bindStageEvents(): void {
  elements.imageGhost.addEventListener("animationend", () => {
    elements.imageGhost.hidden = true;
  });
}

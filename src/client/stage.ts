import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { blobKey, blobs, cacheThumbnail, savedFrames } from "./frame-cache.js";
import { adjacentPrntscId, nextHistoryIndex } from "./navigation.js";
import { toast } from "./toast.js";
import { isFavorite, state } from "./viewer-state.js";

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

// The ring's CSS animation is sometimes never instantiated by the webview, so the ring stays still; an animation made from script always runs.
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
let spinner: Animation | undefined;
let loadingSince = 0;

export function setState(next: ViewState): void {
  spinner?.cancel();
  spinner = undefined;
  if (next === "loading" && !reducedMotion?.matches)
    spinner = elements.loadingRing.animate(
      { transform: ["rotate(0)", "rotate(1turn)"] },
      { duration: 850, iterations: Infinity },
    );
  // A shown frame stays on stage, dimmed under the loader or an error, so the next one can crossfade in.
  const keepFrame = (next === "loading" || next === "error") && !elements.imageZoom.hidden;
  viewState = next;
  for (const [name, target] of Object.entries(statePanels))
    target.hidden = name !== next && !(keepFrame && name === "image");
  elements.imageZoom.inert = keepFrame;
  elements.draw.toggleAttribute("data-invite", next === "empty");
  // The value lets CSS hold the loading dim back 200ms while an error dims at once.
  if (keepFrame) elements.imageZoom.dataset.dimmed = next;
  else delete elements.imageZoom.dataset.dimmed;
  if (next === "loading") {
    loadingSince = Date.now();
    elements.loadingMessage.textContent = "Drawing a frame…";
    elements.announcer.textContent = "Drawing a frame…";
  }
}

const stateControls: Record<ViewState, HTMLElement | null> = {
  empty: elements.draw,
  loading: null,
  error: elements.retry,
  image: elements.draw,
};

// The loader appears after 200ms. Once it has, keep it up for 500ms, so it never flashes half-formed.
export async function settleLoader(): Promise<void> {
  const visible = Date.now() - loadingSince - 200;
  if (visible > 0 && visible < 500) await new Promise((resolve) => setTimeout(resolve, 500 - visible));
}

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
  delete elements.loading.dataset.cancelable;
  syncControls();
  const target = state.focusBeforeLoading as HTMLElement | null;
  state.focusBeforeLoading = null;
  if (!target || target === document.body || !focusLost()) return;
  target.focus();
  if (focusLost()) (viewState === "error" && elements.retry.hidden ? elements.draw : stateControls[viewState])?.focus();
}

export function syncControls(): void {
  const current = state.history[state.index];
  // At 0/0 the arrows have nowhere to go; the empty stage points at Draw instead.
  // The frame count beside the ID carries the position, so the newest frame drops Next instead of disabling it.
  elements.previous.hidden = !state.history.length;
  elements.next.hidden = nextHistoryIndex(state.index, state.history.length) === null;
  elements.previous.setAttribute("aria-disabled", String(state.loading || state.index <= 0));
  elements.next.setAttribute("aria-disabled", String(state.loading));
  // Copy and save act on the visible frame only, never on one hidden behind an error.
  const currentBlob = viewState === "image" && current && blobs.has(blobKey(current.source, current.id));
  elements.save.disabled = state.loading || !currentBlob;
  // A saved frame keeps its check while shown; only a fresh save plays the arrow-to-check.
  if (current && savedFrames.has(blobKey(current.source, current.id))) elements.save.dataset.saved ??= "shown";
  else delete elements.save.dataset.saved;
  elements.save.dataset.tip = elements.save.dataset.saved ? "Saved · Save again (S)" : "Save image (S)";
  elements.lightboxSave.disabled = elements.save.disabled;
  elements.copyImage.disabled = state.loading || !currentBlob;
  elements.copyLink.disabled = state.loading || !current;
  elements.removeFrame.disabled = state.loading || !current;
  const favorite = Boolean(current && isFavorite(current));
  const favoriteLabel = favorite ? "Remove from favorites" : "Add to favorites";
  elements.favoriteButton.disabled = state.loading || !current;
  elements.favoriteButton.setAttribute("aria-pressed", String(favorite));
  elements.favoriteButton.setAttribute("aria-label", favoriteLabel);
  elements.favoriteButton.dataset.tip = `${favoriteLabel} (F)`;
  elements.lightboxFavorite.disabled = elements.favoriteButton.disabled;
  elements.lightboxFavorite.setAttribute("aria-pressed", String(favorite));
  elements.lightboxFavorite.setAttribute("aria-label", favoriteLabel);
  elements.lightboxFavorite.dataset.tip = `${favoriteLabel} (F)`;
  elements.previousId.disabled =
    state.loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, -1) === null;
  elements.nextId.disabled = state.loading || current?.source !== "prntsc" || adjacentPrntscId(current.id, 1) === null;
  // Frame actions have nothing to act on until the first draw.
  elements.infoActions.hidden = !state.history.length;
  // History, the position readout, and the arrows stay enabled while loading (goTo ignores them), so they keep focus.
  const position = state.history.length ? state.index + 1 : 0;
  elements.positionButton.disabled = !state.history.length;
  elements.positionButton.setAttribute("aria-label", `Frame ${position} of ${state.history.length}. Jump to a frame`);
  elements.positionCurrent.textContent = String(position);
  elements.historyTotal.textContent = String(state.history.length);
  elements.frameCountCurrent.textContent = String(position);
  elements.frameCountTotal.textContent = String(state.history.length);
  elements.jumpTotal.textContent = String(state.history.length);
  elements.jumpInput.max = String(state.history.length);
  elements.historyClear.disabled = state.loading || !state.history.length;
  elements.imageIdValue.textContent = current?.id ?? "———";
  // The accessible name has to contain the visible text, so the ID leads and the purpose follows.
  elements.frameMenuButton.setAttribute(
    "aria-label",
    current ? `prnt.sc/${current.id}, frame options` : "Frame options",
  );
  // Without an href the link leaves the tab order and Enter has nothing to follow.
  if (current) elements.source.href = current.sourcePageUrl;
  else elements.source.removeAttribute("href");
  elements.source.setAttribute("aria-disabled", String(!current));
  // aria-disabled rather than disabled, so a focused retry or Draw keeps focus through the countdown.
  const waitSeconds = cooldownSeconds();
  elements.retry.hidden = false;
  elements.retry.setAttribute("aria-disabled", String(state.loading || waitSeconds > 0));
  elements.retry.textContent = waitSeconds ? `Try again in ${waitSeconds}s` : "Try again";
  elements.draw.setAttribute("aria-busy", String(state.drawing));
  elements.draw.setAttribute("aria-disabled", String(state.loading || state.historyLoadFailed || waitSeconds > 0));
  elements.draw.toggleAttribute("data-paused", waitSeconds > 0);
  elements.draw.toggleAttribute(
    "data-invite",
    viewState === "empty" && !state.loading && !state.historyLoadFailed && !waitSeconds,
  );
  if (state.loading || state.historyLoadFailed || waitSeconds) delete elements.draw.dataset.pulse;
  elements.drawLabel.textContent = waitSeconds ? `Wait ${waitSeconds}s` : "Draw";
  // Both draw controls show the cooldown without dropping focus.
  elements.back.hidden = !current || failedIndex === state.index;
  elements.back.textContent = `Keep viewing frame ${state.index + 1}`;
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
    toast.info(notice);
    cooldownNoticeShown = true;
  } else elements.announcer.textContent = notice;
  return true;
}

// Try again repeats the request that failed; failedAt names the history frame it was restoring, if any.
// `copy` replaces the source-oriented wording for failures that are not about a frame.
export function showError(
  error: unknown,
  retry: () => Promise<void>,
  failedAt = -1,
  copy?: { title: string; message: string },
): void {
  retryAction = retry;
  failedIndex = failedAt;
  const { title, message, cooldownSeconds: seconds } = copy ? { ...copy, cooldownSeconds: 0 } : describeError(error);
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

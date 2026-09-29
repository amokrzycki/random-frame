import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { type FavoriteItem, toggleFavorite } from "./favorites.js";
import { blobKey, blobs, savedFrames } from "./frame-cache.js";
import { goTo } from "./frame-loader.js";
import { copyImage, saveImage } from "./image-actions.js";
import { getViewState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applyFavorites, isFavorite, state } from "./viewer-state.js";

export async function saveCurrent(): Promise<void> {
  const current = state.history[state.index];
  const cached = current && blobs.get(blobKey(current.source, current.id));
  if (!current || !cached) return;
  if (!(await saveImage(current.id, cached.blob))) return;
  savedFrames.add(blobKey(current.source, current.id));
  if (state.history[state.index] !== current) return;
  elements.save.dataset.saved = "new";
  syncControls();
}

export async function copyCurrentImage(): Promise<void> {
  const current = state.history[state.index];
  const cached = current && blobs.get(blobKey(current.source, current.id));
  if (!current || !cached) return;
  await copyImage(cached.blob);
}

let favoritePending = false;
let lastRemovedFavorite: FavoriteItem | null = null;

export function undoFavoriteRemoval(): boolean {
  if (!lastRemovedFavorite || favoritePending) return false;
  if (isFavorite(lastRemovedFavorite)) {
    lastRemovedFavorite = null;
    return false;
  }
  void restoreFavorite(lastRemovedFavorite);
  return true;
}

export async function toggleCurrentFavorite(): Promise<void> {
  const current = state.history[state.index];
  if (state.loading || favoritePending || !current) return;
  favoritePending = true;
  const previous = state.favorites.find((favorite) => favorite.source === current.source && favorite.id === current.id);
  try {
    applyFavorites(
      await toggleFavorite(
        previous ?? {
          source: current.source,
          id: current.id,
          sourcePageUrl: current.sourcePageUrl,
          addedAt: Date.now(),
        },
      ),
    );
    syncControls();
    if (!previous) toast.success("Added to favorites");
    else {
      lastRemovedFavorite = previous;
      toast.info("Removed from favorites", { label: "Undo", run: () => void restoreFavorite(previous) });
    }
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be updated. Try again.").message);
  } finally {
    favoritePending = false;
  }
}

// Undo toggles the removed favorite back on with its original date, so it keeps its place in the list.
async function restoreFavorite(item: FavoriteItem): Promise<void> {
  if (favoritePending || isFavorite(item)) return;
  favoritePending = true;
  try {
    applyFavorites(await toggleFavorite(item));
    syncControls();
    if (lastRemovedFavorite === item) lastRemovedFavorite = null;
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be updated. Try again.").message);
  } finally {
    favoritePending = false;
  }
}

async function copySourceLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(elements.source.href);
    toast.success("Copied source link");
  } catch {
    elements.announcer.textContent = "Could not copy the source link";
  }
}

function showLightboxFrame(): void {
  const current = state.history[state.index];
  if (!current) return;
  elements.lightboxImage.src = elements.image.src;
  elements.lightboxImage.alt = elements.image.alt;
  elements.lightboxCaption.textContent = `${current.id}  ·  ${state.index + 1} / ${state.history.length}`;
  elements.lightboxPrevious.setAttribute("aria-disabled", String(state.index <= 0));
  elements.lightboxNext.setAttribute("aria-disabled", String(state.index >= state.history.length - 1));
  setLightboxZoom(false);
}

function setLightboxZoom(zoomed: boolean): void {
  elements.lightboxView.classList.toggle("is-zoomed", zoomed);
  elements.lightboxZoom.setAttribute("aria-pressed", String(zoomed));
  elements.lightboxZoom.textContent = zoomed ? "Fit" : "1:1";
  if (zoomed) {
    elements.lightboxView.scrollLeft = (elements.lightboxView.scrollWidth - elements.lightboxView.clientWidth) / 2;
    elements.lightboxView.scrollTop = (elements.lightboxView.scrollHeight - elements.lightboxView.clientHeight) / 2;
  }
}

async function stepLightbox(offset: -1 | 1): Promise<void> {
  const target = state.index + offset;
  if (state.loading || target < 0 || target >= state.history.length) return;
  elements.lightboxPrevious.setAttribute("aria-disabled", "true");
  elements.lightboxNext.setAttribute("aria-disabled", "true");
  await goTo(target);
  if (getViewState() === "image") showLightboxFrame();
  else closeDialog(elements.lightboxDialog);
}

function openLightbox(): void {
  if (elements.imageZoom.hidden || !elements.image.src) return;
  showLightboxFrame();
  openDialog(elements.lightboxDialog, "dark");
}

export function bindFrameActionEvents(): void {
  elements.favoriteButton.addEventListener("click", () => void toggleCurrentFavorite());
  elements.save.addEventListener("click", () => void saveCurrent());
  elements.copyImage.addEventListener("click", () => void copyCurrentImage());
  elements.copyLink.addEventListener("click", () => void copySourceLink());
  elements.imageZoom.addEventListener("click", openLightbox);
  elements.lightboxClose.addEventListener("click", () => closeDialog(elements.lightboxDialog));
  elements.lightboxZoom.addEventListener("click", () =>
    setLightboxZoom(!elements.lightboxView.classList.contains("is-zoomed")),
  );
  elements.lightboxImage.addEventListener("click", () =>
    setLightboxZoom(!elements.lightboxView.classList.contains("is-zoomed")),
  );
  elements.lightboxPrevious.addEventListener("click", () => void stepLightbox(-1));
  elements.lightboxNext.addEventListener("click", () => void stepLightbox(1));
  elements.lightboxDialog.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    void stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
  });
  let pointer: { id: number; x: number; y: number; left: number; top: number } | null = null;
  elements.lightboxView.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !elements.lightboxView.classList.contains("is-zoomed")) return;
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: elements.lightboxView.scrollLeft,
      top: elements.lightboxView.scrollTop,
    };
    elements.lightboxView.setPointerCapture(event.pointerId);
  });
  elements.lightboxView.addEventListener("pointermove", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    elements.lightboxView.scrollLeft = pointer.left - dx;
    elements.lightboxView.scrollTop = pointer.top - dy;
  });
  elements.lightboxView.addEventListener("pointerup", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer = null;
  });
  elements.lightboxView.addEventListener("pointercancel", () => {
    pointer = null;
  });
  elements.lightboxDialog.addEventListener("click", (event) => {
    if (event.target === elements.lightboxDialog) closeDialog(elements.lightboxDialog);
  });
  elements.lightboxDialog.addEventListener("close", () => {
    onDialogClosed();
    (getViewState() === "image" ? elements.imageZoom : elements.retry.hidden ? elements.draw : elements.retry).focus();
  });
}

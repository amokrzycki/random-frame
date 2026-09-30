import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { type FavoriteItem, toggleFavorite } from "./favorites.js";
import { blobKey, blobs, ensureThumbnail, savedFrames } from "./frame-cache.js";
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
    if (!previous) {
      toast.success("Added to favorites");
      void ensureThumbnail(current).catch(() => false);
    } else {
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
    void ensureThumbnail(item).catch(() => false);
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
  setLightboxZoom(1);
}

const MAX_ZOOM = 16;
let zoom = 1;
let fitWidth = 0;

// zoom is a multiple of the fit-to-window width; 1 = fit. Scaling the width (not toggling natural size)
// keeps zoom working for images smaller than the window.
function setLightboxZoom(next: number, anchorX?: number, anchorY?: number): void {
  const view = elements.lightboxView;
  const img = elements.lightboxImage;
  next = Math.min(MAX_ZOOM, Math.max(1, next));
  if (zoom === 1) fitWidth = img.getBoundingClientRect().width;
  const before = img.getBoundingClientRect();
  zoom = next;
  const zoomed = zoom > 1;
  view.classList.toggle("is-zoomed", zoomed);
  img.style.width = zoomed ? `${fitWidth * zoom}px` : "";
  elements.lightboxZoom.setAttribute("aria-pressed", String(zoomed));
  elements.lightboxZoom.textContent = zoomed ? "Fit" : "1:1";
  elements.lightboxZoom.dataset.tip = zoomed
    ? "Fit to window. Ctrl+scroll zooms, Shift+arrows pan"
    : "Actual size. Ctrl+scroll zooms, Shift+arrows pan";
  if (!zoomed) return;
  const after = img.getBoundingClientRect();
  if (anchorX === undefined || anchorY === undefined || !before.width) {
    view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
    view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
    return;
  }
  // keep the image point under the cursor fixed
  const fx = Math.min(1, Math.max(0, (anchorX - before.left) / before.width));
  const fy = Math.min(1, Math.max(0, (anchorY - before.top) / before.height));
  view.scrollLeft += after.left + fx * after.width - anchorX;
  view.scrollTop += after.top + fy * after.height - anchorY;
}

function toggleLightboxZoom(): void {
  if (zoom > 1) {
    setLightboxZoom(1);
    return;
  }
  const fit = elements.lightboxImage.getBoundingClientRect().width;
  const actual = fit ? elements.lightboxImage.naturalWidth / fit : 1;
  setLightboxZoom(actual > 1.05 ? actual : 2);
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

const PAN_STEP = 120;
const PAN: Record<string, [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function bindFrameActionEvents(): void {
  elements.favoriteButton.addEventListener("click", () => void toggleCurrentFavorite());
  elements.save.addEventListener("click", () => void saveCurrent());
  elements.copyImage.addEventListener("click", () => void copyCurrentImage());
  elements.copyLink.addEventListener("click", () => void copySourceLink());
  elements.imageZoom.addEventListener("click", openLightbox);
  elements.lightboxClose.addEventListener("click", () => closeDialog(elements.lightboxDialog));
  elements.lightboxFavorite.addEventListener("click", () => void toggleCurrentFavorite());
  elements.lightboxSave.addEventListener("click", () => void saveCurrent());
  elements.lightboxZoom.addEventListener("click", toggleLightboxZoom);
  elements.lightboxImage.addEventListener("click", toggleLightboxZoom);
  elements.lightboxView.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); // also stops the webview zooming the whole page (trackpad pinch sends ctrl+wheel)
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      setLightboxZoom(zoom * Math.exp(-delta * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );
  elements.lightboxPrevious.addEventListener("click", () => void stepLightbox(-1));
  elements.lightboxNext.addEventListener("click", () => void stepLightbox(1));
  elements.lightboxDialog.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const arrow = PAN[event.key];
    if (arrow && event.shiftKey) {
      // Shift+arrow pans a zoomed image; unzoomed there is nothing to pan, and it must not step frames.
      event.preventDefault();
      event.stopPropagation();
      if (elements.lightboxView.classList.contains("is-zoomed"))
        elements.lightboxView.scrollBy(arrow[0] * PAN_STEP, arrow[1] * PAN_STEP);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      void stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    const key = event.key.toLowerCase();
    if ((key !== "s" && key !== "f") || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    void (key === "s" ? saveCurrent() : toggleCurrentFavorite());
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

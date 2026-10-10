import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { type FavoriteItem, toggleFavorite } from "./favorites.js";
import { blobKey, blobs, ensureThumbnail, savedFrames } from "./frame-cache.js";
import { goToPosition } from "./frame-loader.js";
import { copyImage, saveImage } from "./image-actions.js";
import { getPlatformCapabilities } from "./platform.js";
import { getViewState, syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applyFavorites, isFavorite, navigationView, state } from "./viewer-state.js";

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
  if (!current || !cached || !getPlatformCapabilities().imageClipboard) return;
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
      toast.info("Removed from favorites", { label: "Undo", run: () => restoreFavorite(previous) });
    }
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be updated. Try again.").message);
  } finally {
    favoritePending = false;
  }
}

// Undo toggles the removed favorite back on with its original date, so it keeps its place in the list.
async function restoreFavorite(item: FavoriteItem): Promise<boolean> {
  if (favoritePending) return false;
  if (isFavorite(item)) return true;
  favoritePending = true;
  try {
    applyFavorites(await toggleFavorite(item));
    syncControls();
    void ensureThumbnail(item).catch(() => false);
    return true;
  } catch (error) {
    toast.error(describeError(error, "Favorites could not be updated. Try again.").message);
    return false;
  } finally {
    favoritePending = false;
  }
}

async function copySourceLink(): Promise<void> {
  try {
    await writeText(elements.source.href);
    toast.success("Copied source link");
  } catch {
    elements.announcer.textContent = "Could not copy the source link";
  }
}

// ponytail: gesture state consolidated into single object for reset simplicity
const gesture = {
  pointers: new Map<number, { x: number; y: number; startX: number; startY: number }>(),
  suppressClick: false,
  imageTap: false,
  touchTap: false,
  lastTap: { at: 0, x: 0, y: 0 },
};

function showLightboxFrame(): void {
  gesture.pointers.clear();
  gesture.suppressClick = false;
  gesture.touchTap = false;
  const current = state.history[state.index];
  if (!current) return;
  elements.lightboxImage.src = elements.image.src;
  elements.lightboxImage.alt = elements.image.alt;
  syncControls();
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
  if (zoom === 1) fitWidth = img.clientWidth || img.getBoundingClientRect().width;
  const fitToNatural = fitWidth && img.naturalWidth ? fitWidth / img.naturalWidth : 1;
  const actual = 1 / fitToNatural;
  next = Math.min(Math.max(MAX_ZOOM, actual), Math.max(1, next));
  const before = img.getBoundingClientRect();
  zoom = next;
  const zoomed = zoom > 1;
  view.classList.toggle("is-zoomed", zoomed);
  img.style.width = zoomed ? `${fitWidth * zoom}px` : "";
  elements.lightboxZoom.setAttribute("aria-pressed", String(zoomed));
  elements.lightboxZoom.textContent = zoomed ? "Fit" : actual > 1 ? "1:1" : "2×";
  const scale = fitToNatural * zoom;
  elements.lightboxZoom.setAttribute(
    "aria-label",
    `${zoomed ? "Fit to window" : actual > 1 ? "Zoom to actual size" : "Enlarge image to 2×"}. Current scale: ${Math.round(scale * 100)}%.`,
  );
  elements.lightboxZoom.dataset.tip = zoomed
    ? `Fit to window. Current scale: ${Math.round(scale * 100)}%. Ctrl+scroll or pinch to zoom, drag or Shift+arrows to pan`
    : `${actual > 1 ? "Actual size" : "Enlarge to 2×"}. Ctrl+scroll or pinch to zoom, drag or Shift+arrows to pan`;
  elements.lightboxZoomOut.disabled = zoom === 1;
  elements.lightboxZoomIn.disabled = zoom === Math.max(MAX_ZOOM, actual);
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
  const fit = elements.lightboxImage.clientWidth || elements.lightboxImage.getBoundingClientRect().width;
  const actual = fit ? elements.lightboxImage.naturalWidth / fit : 1;
  setLightboxZoom(actual > 1 ? actual : 2);
}

async function stepLightbox(offset: -1 | 1): Promise<void> {
  const view = navigationView();
  const target = view.index + offset;
  if (state.loading || target < 0 || target >= view.items.length) return;
  elements.lightboxPrevious.setAttribute("aria-disabled", "true");
  elements.lightboxNext.setAttribute("aria-disabled", "true");
  await goToPosition(target);
  if (getViewState() === "image") showLightboxFrame();
  else closeDialog(elements.lightboxDialog);
}

function openLightbox(): void {
  if (elements.imageZoom.hidden || !elements.image.src) return;
  showLightboxFrame();
  openDialog(elements.lightboxDialog, "dark");
  setLightboxZoom(1);
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
  elements.lightboxImage.addEventListener("load", () => {
    if (zoom === 1) setLightboxZoom(1);
  });
  elements.lightboxZoom.addEventListener("click", toggleLightboxZoom);
  const tapImage = (event: MouseEvent): void => {
    if (gesture.suppressClick || event.detail > 1) return;
    const at = Date.now();
    if (
      gesture.touchTap &&
      at - gesture.lastTap.at < 300 &&
      Math.hypot(event.clientX - gesture.lastTap.x, event.clientY - gesture.lastTap.y) < 24
    )
      return;
    gesture.lastTap = { at, x: event.clientX, y: event.clientY };
    toggleLightboxZoom();
  };
  elements.lightboxImage.addEventListener("click", tapImage);
  elements.lightboxZoomIn.addEventListener("click", () => setLightboxZoom(zoom * 1.25));
  elements.lightboxZoomOut.addEventListener("click", () => setLightboxZoom(zoom / 1.25));
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
  const pair = (): { x: number; y: number; distance: number } | undefined => {
    const [a, b] = [...gesture.pointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) } : undefined;
  };
  elements.lightboxView.addEventListener("pointerdown", (event) => {
    if ((event.button !== 0 && event.pointerType !== "touch") || gesture.pointers.size >= 2) return;
    // Prevent default on touch to avoid browser mouse event synthesis and scrolling interference
    if (event.pointerType === "touch") event.preventDefault();
    if (!gesture.pointers.size) {
      gesture.suppressClick = false;
      gesture.imageTap = event.target === elements.lightboxImage;
      gesture.touchTap = event.pointerType === "touch";
    }
    gesture.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    if (gesture.pointers.size === 2) gesture.suppressClick = true;
    elements.lightboxView.setPointerCapture(event.pointerId);
  });
  elements.lightboxView.addEventListener("pointermove", (event) => {
    const previous = gesture.pointers.get(event.pointerId);
    if (!previous) return;
    const before = pair();
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    gesture.pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > 3) gesture.suppressClick = true;
    const after = pair();
    if (before && after) {
      event.preventDefault();
      if (before.distance > 0) setLightboxZoom((zoom * after.distance) / before.distance, before.x, before.y);
      elements.lightboxView.scrollLeft -= after.x - before.x;
      elements.lightboxView.scrollTop -= after.y - before.y;
    } else if (zoom > 1) {
      event.preventDefault();
      elements.lightboxView.scrollLeft -= dx;
      elements.lightboxView.scrollTop -= dy;
    }
  });
  elements.lightboxView.addEventListener("pointerup", (event) => {
    gesture.pointers.delete(event.pointerId);
  });
  for (const type of ["pointercancel", "lostpointercapture"] as const) {
    elements.lightboxView.addEventListener(type, (event) => {
      if (!gesture.pointers.has(event.pointerId)) return;
      gesture.suppressClick = true;
      gesture.pointers.delete(event.pointerId);
    });
  }
  // Pointer capture targets the viewport's click; a stationary image tap keeps its existing toggle.
  elements.lightboxView.addEventListener("click", (event) => {
    if (event.target === elements.lightboxView && gesture.imageTap) tapImage(event);
  });
  window.addEventListener("resize", () => {
    if (!elements.lightboxDialog.open) return;
    gesture.pointers.clear();
    gesture.suppressClick = true;
    const view = elements.lightboxView;
    const img = elements.lightboxImage;
    const before = img.getBoundingClientRect();
    const rect = view.getBoundingClientRect();
    const x = rect.left + view.clientWidth / 2;
    const y = rect.top + view.clientHeight / 2;
    const fx = before.width ? Math.max(0, Math.min(1, (x - before.left) / before.width)) : 0.5;
    const fy = before.height ? Math.max(0, Math.min(1, (y - before.top) / before.height)) : 0.5;
    const width = fitWidth * zoom;
    const fitted = zoom === 1;
    zoom = 1;
    view.classList.toggle("is-zoomed", false);
    img.style.width = "";
    fitWidth = img.clientWidth || img.getBoundingClientRect().width;
    setLightboxZoom(fitted || !fitWidth ? 1 : width / fitWidth);
    if (zoom > 1) {
      const after = img.getBoundingClientRect();
      view.scrollLeft += after.left + fx * after.width - x;
      view.scrollTop += after.top + fy * after.height - y;
    }
  });
  elements.lightboxDialog.addEventListener("click", (event) => {
    if (event.target === elements.lightboxDialog) closeDialog(elements.lightboxDialog);
  });
  elements.lightboxDialog.addEventListener("close", () => {
    gesture.pointers.clear();
    onDialogClosed();
    (getViewState() === "image" ? elements.imageZoom : elements.retry.hidden ? elements.draw : elements.retry).focus();
  });
}

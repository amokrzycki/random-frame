import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import { toggleFavorite } from "./favorites.js";
import { blobKey, blobs, savedFrames } from "./frame-cache.js";
import { copyImage, saveImage } from "./image-actions.js";
import { syncControls } from "./stage.js";
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
  const adding = !isFavorite(current);
  try {
    applyFavorites(
      await toggleFavorite({
        source: current.source,
        id: current.id,
        sourcePageUrl: current.sourcePageUrl,
        addedAt: Date.now(),
      }),
    );
    syncControls();
    if (adding) toast.success("Added to favorites");
    else toast.info("Removed from favorites");
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

function openLightbox(): void {
  if (elements.imageZoom.hidden || !elements.image.src) return;
  elements.lightboxImage.src = elements.image.src;
  elements.lightboxImage.alt = elements.image.alt;
  openDialog(elements.lightboxDialog, "dark");
}

export function bindFrameActionEvents(): void {
  elements.favoriteButton.addEventListener("click", () => void toggleCurrentFavorite());
  elements.save.addEventListener("click", () => void saveCurrent());
  elements.copyImage.addEventListener("click", () => void copyCurrentImage());
  elements.copyLink.addEventListener("click", () => void copySourceLink());
  elements.imageZoom.addEventListener("click", openLightbox);
  elements.lightboxDialog.addEventListener("click", () => closeDialog(elements.lightboxDialog));
  elements.lightboxClose.addEventListener("click", (event) => {
    event.stopPropagation();
    closeDialog(elements.lightboxDialog);
  });
  elements.lightboxDialog.addEventListener("close", () => {
    onDialogClosed();
    elements.imageZoom.focus();
  });
}

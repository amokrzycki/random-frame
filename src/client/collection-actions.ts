import { elements } from "./elements.js";
import { bindMenu } from "./menu.js";

export function closeCollectionActions(restoreFocus = true): boolean {
  if (!elements.collectionActionsMenu.matches?.(":popover-open")) return false;
  elements.collectionActionsMenu.hidePopover?.();
  if (restoreFocus) elements.collectionActionsButton.focus({ preventScroll: true });
  return true;
}

export function bindCollectionActions(): void {
  const menu = elements.collectionActionsMenu;
  const button = elements.collectionActionsButton;
  bindMenu(menu, button, "below");
  const position = (): void => {
    const rect = button.getBoundingClientRect();
    const bounds = elements.historyDialog.getBoundingClientRect();
    const bottom = Math.min(window.innerHeight - 8, bounds.bottom - 12);
    const above = bottom - rect.bottom < 100 && rect.top - bounds.top > bottom - rect.bottom;
    menu.dataset.placement = above ? "above" : "below";
    menu.style.top = above ? "auto" : `${rect.bottom + 6}px`;
    menu.style.bottom = above ? `${window.innerHeight - rect.top + 6}px` : "auto";
    menu.style.maxHeight = `${Math.max(0, above ? rect.top - bounds.top - 18 : bottom - rect.bottom - 6)}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  };
  menu.addEventListener("beforetoggle", (event) => {
    const opening = (event as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(opening));
    if (opening) position();
  });
  menu.addEventListener("toggle", () => {
    if (menu.matches(":popover-open") && document.activeElement === button) elements.collectionRename.focus();
  });
  // Focus the durable trigger before opening a management dialog, so Cancel returns here.
  menu.addEventListener("click", () => button.focus({ preventScroll: true }), true);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      closeCollectionActions();
    }
  });
  elements.historyDialog.addEventListener("close", () => closeCollectionActions(false));
  window.addEventListener?.("resize", () => {
    if (menu.matches(":popover-open")) position();
  });
}

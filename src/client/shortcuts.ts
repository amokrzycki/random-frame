import { closeDialog, dialogs, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { copyCurrentImage, saveCurrent, toggleCurrentFavorite } from "./frame-actions.js";
import { goBack, goNext, loadRandom } from "./frame-loader.js";
import { openHistory } from "./history-dialog.js";

// Focus returns to whatever had it: the sheet opens from the titlebar or from ? anywhere.
let shortcutsOpener: HTMLElement | null = null;
function openShortcuts(): void {
  shortcutsOpener = document.activeElement as HTMLElement | null;
  openDialog(elements.shortcutsDialog);
}

const CONTROL_SELECTOR = "a, button, input, select, textarea, summary, [tabindex]";

export function bindShortcutsEvents(): void {
  elements.shortcutsButton.addEventListener("click", openShortcuts);
  elements.shortcutsClose.addEventListener("click", () => closeDialog(elements.shortcutsDialog));
  elements.shortcutsDialog.addEventListener("close", () => {
    onDialogClosed();
    (shortcutsOpener ?? elements.shortcutsButton).focus?.();
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || elements.entryDialog.open) return;
    const target = event.target as HTMLElement | null;
    // The jump field owns its own keys: arrows move the caret, Enter submits.
    if (target?.tagName === "INPUT") return;
    // ? toggles the sheet, so the key that opened it also closes it.
    if (event.key === "?" && !event.repeat) {
      if (elements.shortcutsDialog.open) closeDialog(elements.shortcutsDialog);
      else if (!dialogs.some((dialog) => dialog.open)) openShortcuts();
      return;
    }
    // The ID menu popover is not a dialog but still owns the keyboard while open.
    if (dialogs.some((dialog) => dialog.open) || elements.idMenu.matches?.(":popover-open")) return;
    if (event.key === "ArrowLeft") goBack();
    if (event.key === "ArrowRight") goNext();
    if (!event.repeat) {
      const key = event.key.toLowerCase();
      if (key === "s") void saveCurrent();
      if (key === "c") void copyCurrentImage();
      if (key === "h") openHistory();
      if (key === "f") void toggleCurrentFavorite();
    }
    // N draws from anywhere; Space and Enter only when no control has focus to claim them.
    const onControl = Boolean(target?.closest?.(CONTROL_SELECTOR));
    if (event.key === "n" || event.key === "N" || (!onControl && (event.key === " " || event.key === "Enter"))) {
      event.preventDefault();
      if (!event.repeat) void loadRandom();
    }
  });
}

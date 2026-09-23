import { elements } from "./elements.js";

// showModal() makes the rest of the document inert, including the titlebar,
// which blocks window drag/controls; show() plus manual inert on main
// keeps the titlebar usable while a dialog is open.
export const dialogs = [
  elements.entryDialog,
  elements.historyDialog,
  elements.statsDialog,
  elements.lightboxDialog,
  elements.shortcutsDialog,
  elements.syncDialog,
];

export function openDialog(dialog: HTMLDialogElement, variant?: "dark"): void {
  elements.main.inert = true;
  if (variant) elements.dialogBackdrop.dataset.variant = variant;
  else delete elements.dialogBackdrop.dataset.variant;
  elements.dialogBackdrop.hidden = false;
  void elements.dialogBackdrop.offsetWidth;
  elements.dialogBackdrop.dataset.open = "";
  dialog.show();
}

export function onDialogClosed(): void {
  if (dialogs.some((dialog) => dialog.open)) return;
  elements.main.inert = false;
  // closeDialog already faded the backdrop alongside the dialog.
  delete elements.dialogBackdrop.dataset.open;
  elements.dialogBackdrop.hidden = true;
}

// The entry dialog can only be dismissed by accepting; it never closes on backdrop click or Escape.
function dismissibleOpenDialog(): HTMLDialogElement | undefined {
  return dialogs.find((dialog) => dialog.open && dialog !== elements.entryDialog);
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.dataset.busy) return;
  const classList = (dialog as unknown as { classList?: DOMTokenList }).classList;
  if (!classList) {
    dialog.close();
    return;
  }
  if (classList.contains("is-closing")) return;
  classList.add("is-closing");
  if (!dialogs.some((other) => other !== dialog && other.open)) delete elements.dialogBackdrop.dataset.open;
  // Not `once`: children's transitionend events bubble here first and would consume the listener.
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target !== dialog || event.propertyName !== "opacity") return;
    clearTimeout(fallback);
    finish();
  };
  const finish = (): void => {
    dialog.removeEventListener("transitionend", onTransitionEnd);
    dialog.close();
    classList.remove("is-closing");
  };
  const fallback = setTimeout(finish, 180);
  dialog.addEventListener("transitionend", onTransitionEnd);
}

export function bindDialogChromeEvents(): void {
  elements.dialogBackdrop.addEventListener("click", () => {
    const dialog = dismissibleOpenDialog();
    if (dialog) closeDialog(dialog);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const dialog = dismissibleOpenDialog();
    if (dialog) closeDialog(dialog);
  });
}

import { elements } from "./elements.js";

// showModal() would also inert the titlebar's drag region and window controls, and would silence the live
// region outside the dialog. Keep those available and inert the rest ourselves: the app's content, the
// titlebar tools, and the update banner. Inert also drops them from the accessibility tree.
export const dialogs = [
  elements.entryDialog,
  elements.historyDialog,
  elements.statsDialog,
  elements.lightboxDialog,
  elements.shortcutsDialog,
  elements.syncDialog,
];

export function setBackgroundInert(inert: boolean): void {
  elements.main.inert = inert;
  elements.mastheadTools.inert = inert;
  for (const banner of document.querySelectorAll<HTMLElement>(".update-banner")) banner.inert = inert;
}

export function openDialog(dialog: HTMLDialogElement, variant?: "dark"): void {
  setBackgroundInert(true);
  if (variant) elements.dialogBackdrop.dataset.variant = variant;
  else delete elements.dialogBackdrop.dataset.variant;
  elements.dialogBackdrop.hidden = false;
  void elements.dialogBackdrop.offsetWidth;
  elements.dialogBackdrop.dataset.open = "";
  dialog.show();
  focusInDialog(dialog);
}

export function onDialogClosed(): void {
  const open = activeDialog();
  if (open) {
    focusInDialog(open);
    return;
  }
  setBackgroundInert(false);
  // closeDialog already faded the backdrop alongside the dialog.
  delete elements.dialogBackdrop.dataset.open;
  elements.dialogBackdrop.hidden = true;
}

// The entry dialog can only be dismissed by accepting; it never closes on backdrop click or Escape.
function dismissibleOpenDialog(): HTMLDialogElement | undefined {
  return [...dialogs].reverse().find((dialog) => dialog.open && dialog !== elements.entryDialog);
}

const focusableSelector = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

function activeDialog(): HTMLDialogElement | undefined {
  return [...dialogs].reverse().find((dialog) => dialog.open);
}

function focusableIn(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (item) => !item.matches(":disabled") && item.getClientRects().length > 0,
  );
}

function focusInDialog(dialog: HTMLDialogElement): void {
  if (document.activeElement !== dialog && dialog.contains(document.activeElement)) return;
  const items = focusableIn(dialog);
  (items.find((item) => item.hasAttribute("autofocus")) ?? items[0] ?? dialog).focus();
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.dataset.busy) return;
  if (dialog === elements.syncDialog && elements.syncRecoveryKey.textContent && !elements.syncKeySaved.checked) {
    elements.announcer.textContent = "Save the recovery key and confirm it before closing.";
    return;
  }
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
    if (event.key === "Tab") {
      const dialog = activeDialog();
      if (!dialog) return;
      const items = focusableIn(dialog);
      const first = items[0] ?? dialog;
      const last = items.at(-1) ?? dialog;
      if (
        !dialog.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    const dialog = dismissibleOpenDialog();
    if (dialog) closeDialog(dialog);
  });

  document.addEventListener("focusin", (event) => {
    const dialog = activeDialog();
    if (dialog && !dialog.contains(event.target as Node)) focusInDialog(dialog);
  });
}

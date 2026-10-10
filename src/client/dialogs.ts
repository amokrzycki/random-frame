import { elements } from "./elements.js";
import { setToastScope } from "./toast.js";

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
  elements.changelogDialog,
];

const opened: HTMLDialogElement[] = [];
const returnFocus = new WeakMap<HTMLDialogElement, HTMLElement>();
const variants = new WeakMap<HTMLDialogElement, "dark" | undefined>();

export function refreshDialogBoundary(): void {
  const active = activeDialog();
  for (const dialog of dialogs) {
    dialog.inert = Boolean(active && dialog.open && dialog !== active);
    // Desktop shell controls remain available outside the dialog; mobile has a fully modal boundary.
    if (dialog === active && !document.querySelector("#window-controls")) dialog.setAttribute("aria-modal", "true");
    else dialog.removeAttribute("aria-modal");
  }
}

export function setBackgroundInert(inert: boolean): void {
  elements.main.inert = inert;
  elements.mastheadTools.inert = inert;
  for (const banner of document.querySelectorAll<HTMLElement>(".update-banner")) banner.inert = inert;
}

export function openDialog(dialog: HTMLDialogElement, variant?: "dark"): void {
  if (dialog.open) return;
  if (document.activeElement) returnFocus.set(dialog, document.activeElement as HTMLElement);
  opened.push(dialog);
  variants.set(dialog, variant);
  dialog.style.zIndex = String(40 + opened.length);
  setBackgroundInert(true);
  if (variant) elements.dialogBackdrop.dataset.variant = variant;
  else delete elements.dialogBackdrop.dataset.variant;
  elements.dialogBackdrop.hidden = false;
  void elements.dialogBackdrop.offsetWidth;
  elements.dialogBackdrop.dataset.open = "";
  dialog.show();
  refreshDialogBoundary();
  setToastScope(dialog);
  focusInDialog(dialog);
}

export function onDialogClosed(): void {
  const closed = opened.filter((dialog) => !dialog.open);
  for (const dialog of closed) opened.splice(opened.indexOf(dialog), 1);
  const open = activeDialog();
  refreshDialogBoundary();
  setToastScope(open);
  if (open) {
    const variant = variants.get(open);
    if (variant) elements.dialogBackdrop.dataset.variant = variant;
    else delete elements.dialogBackdrop.dataset.variant;
    const target = closed.at(-1) && returnFocus.get(closed.at(-1) as HTMLDialogElement);
    queueMicrotask(() => {
      if (activeDialog() !== open) return;
      if (target && open.contains(target) && !target.matches?.(":disabled")) target.focus();
      else focusInDialog(open);
    });
    return;
  }
  setBackgroundInert(false);
  // closeDialog already faded the backdrop alongside the dialog.
  delete elements.dialogBackdrop.dataset.open;
  elements.dialogBackdrop.hidden = true;
}

// The entry dialog can only be dismissed by accepting; it never closes on backdrop click or Escape.
function dismissibleOpenDialog(): HTMLDialogElement | undefined {
  const dialog = activeDialog();
  return dialog === elements.entryDialog ? undefined : dialog;
}

const focusableSelector = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

function activeDialog(): HTMLDialogElement | undefined {
  return [...opened].reverse().find((dialog) => dialog.open) ?? [...dialogs].reverse().find((dialog) => dialog.open);
}

function focusableIn(dialog: HTMLDialogElement): HTMLElement[] {
  const shell = document.querySelector<HTMLElement>("#window-controls");
  return [
    ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
    ...(shell?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
  ].filter((item) => !item.matches(':disabled, [tabindex="-1"]') && item.getClientRects().length > 0);
}

function focusInDialog(dialog: HTMLDialogElement): void {
  if (document.activeElement !== dialog && dialog.contains(document.activeElement)) return;
  const items = focusableIn(dialog);
  (items.find((item) => item.hasAttribute("autofocus")) ?? items[0] ?? dialog).focus();
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.dataset.busy) return;
  if (dialog === elements.syncDialog && elements.syncRecovery.dataset.gated && !elements.syncKeySaved.checked) {
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

/**
 * Android Back closes what Escape would: the open menu, else the top dialog. A busy dialog or an
 * unconfirmed recovery key still holds Back. Returns false when Back belongs to the system, including on
 * the consent screen, which is only ever left by accepting or by leaving the app.
 */
export function dismissTopLayer(): boolean {
  if (elements.entryDialog.open) return false;
  const menu = [elements.toolsMenu, elements.frameMenu].find((item) => item.matches(":popover-open"));
  if (menu) {
    menu.hidePopover();
    return true;
  }
  const dialog = dismissibleOpenDialog();
  if (!dialog) return false;
  closeDialog(dialog);
  return true;
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
        (!dialog.contains(document.activeElement) &&
          !document.querySelector("#window-controls")?.contains(document.activeElement)) ||
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
    if (
      dialog &&
      !dialog.contains(event.target as Node) &&
      !document.querySelector("#window-controls")?.contains(event.target as Node)
    )
      focusInDialog(dialog);
  });
}

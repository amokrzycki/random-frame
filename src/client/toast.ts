type ToastTone = "success" | "info" | "error";

interface ToastAction {
  label: string;
  run: () => void | boolean | Promise<void> | Promise<boolean>;
}

const DWELL_MS = 3200;
const LONG_DWELL_MS = 6000;
const recoveries: (() => void)[] = [];
let replaceCurrent: (() => void) | undefined;
let scope: HTMLElement | undefined;
const notices = new Set<{ element: HTMLElement; tone: ToastTone }>();
const dialogAnnouncements = new WeakMap<HTMLElement, HTMLDivElement>();
let announcementObserver: MutationObserver | undefined;
const dialogRegions = new WeakMap<HTMLElement, Map<ToastTone, HTMLDivElement>>();
const dialogLayers = new WeakMap<HTMLElement, HTMLDivElement>();
let layerObserver: ResizeObserver | undefined;
let layerEventsBound = false;

function positionDialogNotices(): void {
  const layer = scope && dialogLayers.get(scope);
  if (!scope || !layer) return;
  const dialog = scope.getBoundingClientRect();
  layer.style.right = `${Math.max(16, window.innerWidth - dialog.right + 16)}px`;
  // Collection surfaces reserve a stable external gap. Bound consecutive Undo
  // notices to it rather than covering controls or resizing the dialog.
  const available = window.innerHeight - dialog.bottom - 24;
  if (available >= 44) {
    layer.style.maxHeight = `${available}px`;
    layer.style.bottom = "16px";
    layer.style.top = "auto";
    return;
  }
  layer.style.maxHeight = "min(30dvh, 240px)";
  const height = layer.getBoundingClientRect().height;
  // Other app dialogs retain their existing dimensions. Keep their notices
  // clear of header/footer controls and move aside for keyboard focus.
  let bottom = 16;
  if (height + 24 > window.innerHeight - dialog.bottom) {
    const footer = scope.querySelector<HTMLElement>("footer, .collections-actions");
    const edge = footer?.getBoundingClientRect().top ?? dialog.bottom - 16;
    bottom = Math.max(16, window.innerHeight - edge + 12);
  }
  layer.style.bottom = `${bottom}px`;
  const focused = document.activeElement as HTMLElement | null;
  if (focused && scope.contains(focused) && !layer.contains(focused)) {
    const target = focused.getBoundingClientRect();
    const rail = layer.getBoundingClientRect();
    if (target.right > rail.left && target.left < rail.right && target.bottom > rail.top && target.top < rail.bottom) {
      const top = scope.querySelector("header")?.getBoundingClientRect().bottom ?? dialog.top + 16;
      const above = target.top - top - 8;
      const below = window.innerHeight - bottom - target.bottom - 8;
      layer.style.bottom = "auto";
      layer.style.top = `${below > above ? target.bottom + 8 : top}px`;
      layer.style.maxHeight = `${Math.max(0, Math.min(height, Math.max(above, below)))}px`;
      return;
    }
  }
  layer.style.top = "auto";
}

function dialogLayer(dialog: HTMLElement): HTMLDivElement {
  const existing = dialogLayers.get(dialog);
  if (existing) return existing;
  const layer = document.createElement("div");
  layer.className = "dialog-notice-layer";
  layer.popover = "manual";
  dialog.append(layer);
  dialogLayers.set(dialog, layer);
  if (typeof ResizeObserver !== "undefined") {
    layerObserver ??= new ResizeObserver(positionDialogNotices);
    layerObserver.observe(layer);
  }
  if (!layerEventsBound) {
    window.addEventListener?.("resize", positionDialogNotices);
    document.addEventListener("focusin", positionDialogNotices);
    layerEventsBound = true;
  }
  return layer;
}

function region(tone: ToastTone): HTMLDivElement {
  // Success and information share one polite announcement region.
  if (tone === "success") tone = "info";
  if (scope) {
    let regions = dialogRegions.get(scope);
    if (!regions) {
      regions = new Map();
      dialogRegions.set(scope, regions);
    }
    const existing = regions.get(tone);
    if (existing) return existing;
    const element = document.createElement("div");
    element.className = "dialog-notices";
    element.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    dialogLayer(scope).append(element);
    regions.set(tone, element);
    return element;
  }
  const existing = document.querySelector<HTMLDivElement>(tone === "error" ? ".toast-region--error" : ".toast-region");
  if (existing) return existing;
  const element = document.createElement("div");
  element.className = tone === "error" ? "toast-region toast-region--error" : "toast-region";
  element.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  document.body.append(element);
  return element;
}

// Actionable feedback follows the active dialog into its focus and accessibility scope.
export function setToastScope(dialog?: HTMLElement): void {
  const previousLayer = scope && dialogLayers.get(scope);
  if (previousLayer?.matches?.(":popover-open")) previousLayer.hidePopover();
  scope = dialog;
  const announcer = document.querySelector<HTMLElement>("#announcer");
  if (announcer) {
    announcer.setAttribute("aria-live", scope ? "off" : "polite");
    if (scope && !dialogAnnouncements.has(scope)) {
      const live = document.createElement("div");
      live.className = "sr-only";
      live.setAttribute("aria-live", "polite");
      scope.append(live);
      dialogAnnouncements.set(scope, live);
    }
    if (!announcementObserver && typeof MutationObserver !== "undefined") {
      announcementObserver = new MutationObserver(() => {
        const live = scope && dialogAnnouncements.get(scope);
        if (live) live.textContent = announcer.textContent;
      });
      announcementObserver.observe(announcer, { childList: true, characterData: true, subtree: true });
    }
  }
  if (scope) {
    region("info");
    region("error");
  }
  for (const notice of notices) region(notice.tone).append(notice.element);
  if (scope) {
    const layer = dialogLayer(scope);
    layer.showPopover?.();
    positionDialogNotices();
    layer.scrollTop = layer.scrollHeight;
  }
}

function show(message: string, tone: ToastTone, action?: ToastAction, completion?: ToastAction) {
  // ponytail: "Undo" label is the recovery discriminator; rename the field if this ever needs to apply to non-Undo actions.
  const recovery = action?.label === "Undo";
  if (!recovery) replaceCurrent?.();
  const returnFocus = document.activeElement as HTMLElement | null;
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  const copy = completion ? document.createElement("span") : notification;
  copy.textContent = message;
  if (completion) notification.append(copy);
  region(tone).append(notification);
  const notice = { element: notification, tone };
  notices.add(notice);
  positionDialogNotices();
  let timer = 0;
  let expired = false;
  let running = false;
  const dismiss = (immediate = false): void => {
    if (expired) return;
    expired = true;
    clearTimeout(timer);
    notices.delete(notice);
    if (recovery) {
      const index = undoRun && recoveries.indexOf(undoRun);
      if (typeof index === "number" && index >= 0) recoveries.splice(index, 1);
    } else replaceCurrent = undefined;
    const focused = notification.contains(document.activeElement);
    notification.setAttribute("aria-hidden", "true");
    notification.classList?.add("toast--leaving");
    notification.style.pointerEvents = "none";
    for (const button of buttons) button.tabIndex = -1;
    // Correctness never depends on transitionend; rapid replacement removes immediately.
    if (immediate) notification.remove();
    else window.setTimeout(() => notification.remove(), 140);
    if (focused) {
      const target =
        returnFocus?.isConnected &&
        returnFocus.getClientRects().length > 0 &&
        (!scope || scope.contains(returnFocus)) &&
        !returnFocus.matches(":disabled")
          ? returnFocus
          : (scope?.querySelector<HTMLElement>("[autofocus], button:not(:disabled)") ??
            document.querySelector<HTMLElement>("#draw-button"));
      target?.focus();
    }
  };
  if (!recovery) replaceCurrent = () => dismiss(true);
  const arm = (): void => {
    timer = window.setTimeout(dismiss, tone === "error" || action ? LONG_DWELL_MS : DWELL_MS);
  };
  if (!recovery) {
    arm();
    for (const [enter, leave] of [
      ["pointerenter", "pointerleave"],
      ["focusin", "focusout"],
    ] as const) {
      notification.addEventListener(enter, () => clearTimeout(timer));
      notification.addEventListener(leave, () => {
        clearTimeout(timer);
        arm();
      });
    }
  }
  const buttons: HTMLButtonElement[] = [];
  let undoRun: (() => void) | undefined;
  for (const current of [action, completion]) {
    if (!current) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast__action";
    button.textContent = current.label;
    const run = (): void => {
      if (expired || running) return;
      running = true;
      clearTimeout(timer);
      for (const item of buttons) item.setAttribute("aria-disabled", "true");
      void Promise.resolve()
        .then(current.run)
        .then((succeeded) => {
          if (succeeded !== false) dismiss();
        })
        .catch(() => {
          show("That action could not be completed. Try again.", "error");
        })
        .finally(() => {
          running = false;
          for (const item of buttons) item.removeAttribute("aria-disabled");
          if (!expired && !recovery) arm();
        });
    };
    button.addEventListener("click", run);
    if (current.label === "Undo") {
      undoRun = run;
      recoveries.push(run);
    }
    buttons.push(button);
    notification.append(button);
  }
  const layer = scope && dialogLayers.get(scope);
  if (layer) layer.scrollTop = layer.scrollHeight;
  return {
    dismiss,
    confirm: (message: string): void => {
      copy.textContent = message;
      const undo = buttons[0];
      if (undo) undo.hidden = true;
      const index = undoRun && recoveries.indexOf(undoRun);
      if (typeof index === "number" && index >= 0) recoveries.splice(index, 1);
    },
  };
}

export const toast = {
  undo: (): boolean => {
    const undo = recoveries.at(-1);
    if (!undo) return false;
    undo();
    return true;
  },
  success: (message: string, action?: ToastAction): void => {
    show(message, "success", action);
  },
  info: (message: string, action?: ToastAction): void => {
    show(message, "info", action);
  },
  review: (message: string, undo: ToastAction, finish: ToastAction) => show(message, "info", undo, finish),
  error: (message: string, action?: ToastAction): void => {
    show(message, "error", action);
  },
};

type ToastTone = "success" | "info" | "error";

interface ToastAction {
  label: string;
  run: () => void | boolean | Promise<void> | Promise<boolean>;
}

const DWELL_MS = 3200;
const LONG_DWELL_MS = 6000;
let undoCurrent: (() => void) | undefined;
let dismissRecovery: (() => void) | undefined;
let replaceCurrent: (() => void) | undefined;
let scope: HTMLElement | undefined;
const notices = new Set<{ element: HTMLElement; tone: ToastTone }>();
const dialogAnnouncements = new WeakMap<HTMLElement, HTMLDivElement>();
let announcementObserver: MutationObserver | undefined;
const dialogRegions = new WeakMap<HTMLElement, Map<ToastTone, HTMLDivElement>>();

function region(tone: ToastTone): HTMLDivElement {
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
    (scope.querySelector?.(".history-dialog__content") ?? scope).append(element);
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
}

function show(message: string, tone: ToastTone, action?: ToastAction, completion?: ToastAction) {
  const recovery = action?.label === "Undo";
  if (recovery) dismissRecovery?.();
  else replaceCurrent?.();
  const returnFocus = document.activeElement as HTMLElement | null;
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  const copy = completion ? document.createElement("span") : notification;
  copy.textContent = message;
  if (completion) notification.append(copy);
  region(tone).append(notification);
  const notice = { element: notification, tone };
  notices.add(notice);
  let timer = 0;
  let expired = false;
  let running = false;
  const dismiss = (): void => {
    if (expired) return;
    expired = true;
    clearTimeout(timer);
    notices.delete(notice);
    if (recovery) {
      undoCurrent = undefined;
      dismissRecovery = undefined;
    } else replaceCurrent = undefined;
    const focused = notification.contains(document.activeElement);
    notification.remove();
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
  if (recovery) dismissRecovery = dismiss;
  else replaceCurrent = dismiss;
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
    if (current.label === "Undo") undoCurrent = run;
    buttons.push(button);
    notification.append(button);
  }
  return {
    dismiss,
    confirm: (message: string): void => {
      copy.textContent = message;
      const undo = buttons[0];
      if (undo) undo.hidden = true;
      undoCurrent = undefined;
    },
  };
}

export const toast = {
  undo: (): boolean => {
    if (!undoCurrent) return false;
    undoCurrent();
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

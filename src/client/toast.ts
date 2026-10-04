type ToastTone = "success" | "info" | "error";

interface ToastAction {
  label: string;
  run: () => void;
}

// Errors and toasts with an action need time to be read and used; a passing confirmation does not.
const DWELL_MS = 3200;
const LONG_DWELL_MS = 6000;
let undoCurrent: (() => void) | undefined;
let replaceCurrent: (() => void) | undefined;

// The region ships in the page markup: screen readers only watch live regions that exist before content lands.
function region(tone: ToastTone): HTMLDivElement {
  const existing = document.querySelector<HTMLDivElement>(tone === "error" ? ".toast-region--error" : ".toast-region");
  if (existing) return existing;

  const element = document.createElement("div");
  element.className = tone === "error" ? "toast-region toast-region--error" : "toast-region";
  element.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  document.body.append(element);
  return element;
}

function show(message: string, tone: ToastTone, action?: ToastAction, onExpire?: () => void): void {
  replaceCurrent?.();
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  notification.textContent = message;
  region(tone).replaceChildren(notification);

  let timer = 0;
  let expired = false;
  replaceCurrent = (): void => {
    if (expired) return;
    expired = true;
    undoCurrent = undefined;
    clearTimeout(timer);
    replaceCurrent = undefined;
    onExpire?.();
    notification.remove();
  };
  const dismiss = (): void => {
    if (expired) return;
    expired = true;
    undoCurrent = undefined;
    replaceCurrent = undefined;
    onExpire?.();
    notification.classList.add("toast--leaving");
    notification.addEventListener("transitionend", () => notification.remove(), { once: true });
  };
  const arm = (): void => {
    timer = window.setTimeout(dismiss, tone === "error" || action ? LONG_DWELL_MS : DWELL_MS);
  };
  arm();

  // A toast that commits work on expiry must keep its deadline even while hovered or focused.
  if (!onExpire) {
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

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast__action";
    button.textContent = action.label;
    const run = (): void => {
      if (expired) return;
      expired = true;
      undoCurrent = undefined;
      clearTimeout(timer);
      replaceCurrent = undefined;
      notification.remove();
      action.run();
    };
    button.addEventListener("click", run);
    if (action.label === "Undo") undoCurrent = run;
    notification.append(button);
  }
}

export const toast = {
  undo: (): boolean => {
    if (!undoCurrent) return false;
    undoCurrent();
    return true;
  },
  success: (message: string, action?: ToastAction): void => show(message, "success", action),
  info: (message: string, action?: ToastAction, onExpire?: () => void): void => show(message, "info", action, onExpire),
  error: (message: string, action?: ToastAction): void => show(message, "error", action),
};

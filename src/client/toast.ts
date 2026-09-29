type ToastTone = "success" | "info" | "error";

interface ToastAction {
  label: string;
  run: () => void;
}

// Errors and toasts with an action need time to be read and used; a passing confirmation does not.
const DWELL_MS = 3200;
const LONG_DWELL_MS = 6000;

// The region ships in the page markup: screen readers only watch live regions that exist before content lands.
function region(): HTMLDivElement {
  const existing = document.querySelector<HTMLDivElement>(".toast-region");
  if (existing) return existing;

  const element = document.createElement("div");
  element.className = "toast-region";
  element.setAttribute("aria-live", "polite");
  document.body.append(element);
  return element;
}

function show(message: string, tone: ToastTone, action?: ToastAction, onExpire?: () => void): void {
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  notification.textContent = message;
  region().append(notification);

  let timer = 0;
  let expired = false;
  const dismiss = (): void => {
    if (expired) return;
    expired = true;
    onExpire?.();
    notification.classList.add("toast--leaving");
    notification.addEventListener("transitionend", () => notification.remove(), { once: true });
  };
  const arm = (): void => {
    timer = window.setTimeout(dismiss, tone === "error" || action ? LONG_DWELL_MS : DWELL_MS);
  };
  arm();

  // Reading or reaching for a toast holds it; leaving restarts the full dwell.
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

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast__action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (expired) return;
      expired = true;
      clearTimeout(timer);
      notification.remove();
      action.run();
    });
    notification.append(button);
  }
}

export const toast = {
  success: (message: string): void => show(message, "success"),
  info: (message: string, action?: ToastAction, onExpire?: () => void): void => show(message, "info", action, onExpire),
  error: (message: string): void => show(message, "error"),
};

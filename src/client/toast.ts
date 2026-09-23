type ToastTone = "success" | "info" | "error";

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

function show(message: string, tone: ToastTone): void {
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  notification.textContent = message;
  region().append(notification);

  window.setTimeout(() => {
    notification.classList.add("toast--leaving");
    notification.addEventListener("transitionend", () => notification.remove(), { once: true });
  }, 3200);
}

export const toast = {
  success: (message: string): void => show(message, "success"),
  info: (message: string): void => show(message, "info"),
  error: (message: string): void => show(message, "error"),
};

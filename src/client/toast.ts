type ToastTone = "success" | "error";

function region(): HTMLDivElement {
  const existing = document.querySelector<HTMLDivElement>(".toast-region");
  if (existing) return existing;

  const element = document.createElement("div");
  element.className = "toast-region";
  element.setAttribute("aria-label", "Notifications");
  document.body.append(element);
  return element;
}

function show(message: string, tone: ToastTone): void {
  const notification = document.createElement("div");
  notification.className = `toast toast--${tone}`;
  notification.role = tone === "error" ? "alert" : "status";
  notification.textContent = message;
  region().append(notification);

  window.setTimeout(() => {
    notification.classList.add("toast--leaving");
    notification.addEventListener(
      "transitionend",
      () => {
        const parent = notification.parentElement;
        notification.remove();
        if (!parent?.childElementCount) parent?.remove();
      },
      { once: true },
    );
  }, 3200);
}

export const toast = {
  success: (message: string): void => show(message, "success"),
  error: (message: string): void => show(message, "error"),
};

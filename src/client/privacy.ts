import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "./toast.js";

export async function handleMailtoClick(event: MouseEvent, href: string): Promise<void> {
  event.preventDefault();
  const email = href.replace(/^mailto:/i, "");
  try {
    await navigator.clipboard.writeText(email);
    toast.success("Copied email to clipboard");
  } catch {
    // Ponytail: clipboard write can fail if window unfocused; ignore error
  }
  try {
    await openUrl(href);
  } catch {
    // Ponytail: no default email client configured on OS; safe no-op
  }
}

export function initializePrivacy(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      void handleMailtoClick(event, link.href);
    });
  });
}

if (typeof document !== "undefined") {
  initializePrivacy();
}

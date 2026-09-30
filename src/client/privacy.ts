import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "./toast.js";

export async function handleMailtoClick(event: MouseEvent, href: string): Promise<void> {
  event.preventDefault();
  try {
    await openUrl(href);
  } catch {
    toast.error("Could not open your email app. Please email contact@amokrzycki.ovh.");
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

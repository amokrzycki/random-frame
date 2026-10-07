import { onBackButtonPress } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initializePlatform } from "./platform.js";
import { toast } from "./toast.js";
import { initializeWindowControls } from "./window-controls.js";

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
  // Without an answer the page keeps its controls unbound rather than guessing the platform.
  void initializePlatform()
    .then((platform) => {
      initializeWindowControls(platform.desktopWindowControls);
      // Replacing the page keeps Back from stepping into a stale Privacy entry later.
      if (platform.platform === "android") return onBackButtonPress(() => location.replace("index.html"));
    })
    .catch(() => undefined);
}

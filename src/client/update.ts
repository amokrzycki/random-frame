import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { elements } from "./elements.js";

export async function checkForUpdate(): Promise<void> {
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;

  const banner = document.createElement("div");
  banner.className = "update-banner";

  const message = document.createElement("span");
  message.textContent = `Update ${update.version} available`;
  // A live region inserted already filled is not announced; the page's announcer was there before the update was.
  elements.announcer.textContent = message.textContent;

  const installButton = document.createElement("button");
  installButton.type = "button";
  installButton.textContent = "Install & restart";
  installButton.addEventListener("click", async () => {
    installButton.disabled = true;
    installButton.textContent = "Installing…";
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          installButton.textContent = total ? `Installing… ${Math.round((downloaded / total) * 100)}%` : "Installing…";
        }
      });
      await relaunch();
    } catch {
      installButton.disabled = false;
      installButton.textContent = "Install & restart";
      message.textContent = "Update failed. Try again later.";
      elements.announcer.textContent = message.textContent;
    }
  });

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "update-banner__dismiss";
  dismissButton.textContent = "Dismiss";
  dismissButton.addEventListener("click", () => {
    banner.classList.add("update-banner--leaving");
    banner.addEventListener("transitionend", () => banner.remove(), { once: true });
  });

  banner.append(message, installButton, dismissButton);
  // A dialog may already be open by the time the check resolves.
  banner.inert = elements.main.inert;
  document.body.append(banner);
}

import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import MarkdownIt from "markdown-it";
import changelog from "../../CHANGELOG.md";
import { closeDialog, dialogs, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";

const pendingChangelogKey = "random-frame-pending-changelog";
const markdown = new MarkdownIt({ html: false });

export function renderReleaseNotes(source: string, version: string): string {
  const tokens = markdown.parse(source, {});
  const isVersionHeading = (index: number): boolean =>
    tokens[index]?.type === "heading_open" && tokens[index]?.tag === "h2" && tokens[index]?.level === 0;
  const heading = tokens.findIndex((_, index) => isVersionHeading(index) && tokens[index + 1]?.content === version);
  if (heading < 0) return "";
  const start = heading + 3;
  const next = tokens.findIndex((_, index) => index >= start && isVersionHeading(index));
  return markdown.renderer.render(tokens.slice(start, next < 0 ? undefined : next), markdown.options, {}).trim();
}

function clearPendingChangelog(): void {
  try {
    localStorage.removeItem(pendingChangelogKey);
  } catch {
    // Release notes must not prevent the app from working when storage is unavailable.
  }
}

function openChangelog(version: string, html: string, opener: HTMLElement | null): void {
  elements.changelogVersion.textContent = version;
  // The bundled Markdown is rendered with raw HTML disabled and markdown-it's link validation intact.
  elements.changelogBody.innerHTML = html;
  for (const link of elements.changelogBody.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      // Only web and email links can launch an external handler.
      const href = link.getAttribute("href") ?? "";
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        void openUrl(href).catch(() => {
          elements.announcer.textContent = "The link could not be opened.";
        });
      }
    });
  }
  elements.changelogDialog.addEventListener(
    "close",
    () => {
      clearPendingChangelog();
      onDialogClosed();
      (opener ?? elements.draw).focus();
    },
    { once: true },
  );
  openDialog(elements.changelogDialog);
}

export function bindChangelogEvents(): void {
  elements.changelogDone.addEventListener("click", () => closeDialog(elements.changelogDialog));
  elements.changelogButton.addEventListener("click", async () => {
    try {
      const version = await getVersion();
      const html = renderReleaseNotes(changelog, version);
      if (!html) throw new Error("Missing release notes");
      if (!dialogs.some((dialog) => dialog.open)) openChangelog(version, html, elements.toolsMenuButton);
    } catch {
      elements.announcer.textContent = "Release notes could not be opened.";
    }
  });
}

export async function showPendingChangelog(): Promise<void> {
  let pending: string | null;
  let version: string;
  try {
    pending = localStorage.getItem(pendingChangelogKey);
    if (pending === null) return;
    version = await getVersion();
  } catch {
    return;
  }
  const html = pending === version ? renderReleaseNotes(changelog, version) : "";
  if (!html) {
    clearPendingChangelog();
    return;
  }

  let shown = false;
  const show = (): void => {
    if (shown || dialogs.some((dialog) => dialog.open)) return;
    shown = true;
    for (const dialog of dialogs) dialog.removeEventListener("close", afterClose);
    openChangelog(version, html, document.activeElement as HTMLElement | null);
  };
  // Existing close handlers finish restoring focus before the next startup dialog opens.
  const afterClose = (): void => queueMicrotask(show);
  for (const dialog of dialogs) dialog.addEventListener("close", afterClose);
  show();
}

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
      try {
        localStorage.setItem(pendingChangelogKey, update.version);
      } catch {
        // A successful update still restarts when release notes cannot be remembered.
      }
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

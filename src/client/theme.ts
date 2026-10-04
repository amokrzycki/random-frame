type Theme = "light" | "dark";
type Choice = Theme | "system";

const storageKey = "random-frame-theme";
const root = document.documentElement;
// Both surfaces use System / Light / Dark.
const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle");
const choices = [...(document.querySelectorAll?.<HTMLButtonElement>(".theme-picker [data-theme-choice]") ?? [])];
const options = document.querySelector?.<HTMLElement>(".theme-picker__options");
const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

function storedChoice(): Choice {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let choice = storedChoice();

function setTheme(theme: Theme): void {
  const dark = theme === "dark";
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeColor?.setAttribute("content", dark ? "#1c1d19" : "#ebe8e1");
}

function apply(): void {
  // Without a stored choice the inline head script already resolved the theme; keep it if matchMedia is missing.
  setTheme(choice === "system" ? (systemDark ? (systemDark.matches ? "dark" : "light") : currentTheme()) : choice);
  if (toggle) {
    const next = choice === "system" ? "light" : choice === "light" ? "dark" : "system";
    toggle.dataset.themeChoice = choice;
    const label = `Theme: ${choice}. Switch to ${next} mode`;
    toggle.setAttribute("aria-label", label);
    toggle.dataset.tip = label;
  }
  for (const button of choices) button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  options?.style?.setProperty(
    "--i",
    String(
      Math.max(
        0,
        choices.findIndex((button) => button.dataset.themeChoice === choice),
      ),
    ),
  );
}

function currentTheme(): Theme {
  return root.dataset.theme === "dark" ? "dark" : "light";
}

function choose(next: Choice): void {
  choice = next;
  apply();
  document.dispatchEvent(new CustomEvent("theme-choice", { detail: next }));
  try {
    if (next === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  } catch {
    // Theme still works for this page when storage is unavailable.
  }
}

apply();
// Enable the slide only after the first position is set, so first render doesn't animate.
globalThis.requestAnimationFrame?.(() => options?.classList?.add("is-ready"));

toggle?.addEventListener("click", () => choose(choice === "system" ? "light" : choice === "light" ? "dark" : "system"));
for (const button of choices) button.addEventListener("click", () => choose(button.dataset.themeChoice as Choice));
// Following the system means following it live.
systemDark?.addEventListener?.("change", () => choice === "system" && apply());

document.addEventListener("user-preferences", (event) => {
  const next = (event as CustomEvent).detail?.theme;
  if (next === "system" || next === "light" || next === "dark") {
    choice = next;
    apply();
  }
});

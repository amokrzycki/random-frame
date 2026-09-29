type Theme = "light" | "dark";
type Choice = Theme | "system";

const storageKey = "random-frame-theme";
const root = document.documentElement;
// The privacy page keeps a two-state toggle; the main window has a System / Light / Dark picker.
const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle");
const choices = [...(document.querySelectorAll?.<HTMLButtonElement>("[data-theme-choice]") ?? [])];
const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

// WebKitGTK treats script focus() as :focus-visible even right after a click, so rings would follow
// every mouse-closed dialog. Track the last input ourselves; the CSS hides rings until a real key press.
document.addEventListener(
  "keydown",
  (event) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) root.dataset.keyboardNavigation = "";
  },
  true,
);
document.addEventListener("pointerdown", () => delete root.dataset.keyboardNavigation, true);

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
  toggle?.setAttribute("aria-pressed", String(dark));
  toggle?.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  if (toggle) toggle.title = `Switch to ${dark ? "light" : "dark"} mode`;
}

function apply(): void {
  // Without a stored choice the inline head script already resolved the theme; keep it if matchMedia is missing.
  setTheme(choice === "system" ? (systemDark ? (systemDark.matches ? "dark" : "light") : currentTheme()) : choice);
  for (const button of choices) button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
}

function currentTheme(): Theme {
  return root.dataset.theme === "dark" ? "dark" : "light";
}

function choose(next: Choice): void {
  choice = next;
  apply();
  try {
    if (next === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  } catch {
    // Theme still works for this page when storage is unavailable.
  }
}

apply();

toggle?.addEventListener("click", () => choose(currentTheme() === "dark" ? "light" : "dark"));
for (const button of choices) button.addEventListener("click", () => choose(button.dataset.themeChoice as Choice));
// Following the system means following it live.
systemDark?.addEventListener?.("change", () => choice === "system" && apply());

type Theme = "light" | "dark";

const storageKey = "random-frame-theme";
const root = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle");
const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

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

function setTheme(theme: Theme): void {
  const dark = theme === "dark";
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeColor?.setAttribute("content", dark ? "#171815" : "#ebe8e1");
  toggle?.setAttribute("aria-pressed", String(dark));
  toggle?.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  if (toggle) toggle.title = `Switch to ${dark ? "light" : "dark"} mode`;
}

root.classList.add("theme-init");
setTheme(root.dataset.theme === "dark" ? "dark" : "light");
requestAnimationFrame(() => root.classList.remove("theme-init"));

toggle?.addEventListener("click", () => {
  const theme = root.dataset.theme === "dark" ? "light" : "dark";
  setTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Theme still works for this page when storage is unavailable.
  }
});

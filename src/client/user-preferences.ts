import { PAGE_SIZE_STORAGE_KEY, PAGE_SIZES } from "./history-pagination.js";
import { getUserPreferences, setUserPreferences, type UserPreferences } from "./persistence.js";

const themeKey = "random-frame-theme";
let mutationGeneration = 0;
let pendingMutations = 0;
let mutationQueue: Promise<unknown> = Promise.resolve();

export async function updateUserPreferences(
  preferences: Partial<UserPreferences>,
  legacyImport = false,
): Promise<void> {
  const generation = ++mutationGeneration;
  pendingMutations += 1;
  const result = mutationQueue.then(() => setUserPreferences(preferences, legacyImport));
  mutationQueue = result.catch(() => undefined);
  try {
    const saved = await result;
    if (generation === mutationGeneration) applyUserPreferences(saved);
  } finally {
    pendingMutations -= 1;
  }
}

export function applyUserPreferences(preferences: UserPreferences | null): void {
  if (!preferences) return;
  try {
    if (preferences.theme) localStorage.setItem(themeKey, preferences.theme);
    if (preferences.historyPageSize) localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(preferences.historyPageSize));
  } catch {
    // Rust remains authoritative when the early-render cache is unavailable.
  }
  document.dispatchEvent(new CustomEvent("user-preferences", { detail: preferences }));
}

export async function initializeUserPreferences(): Promise<void> {
  let theme: UserPreferences["theme"] = null;
  let historyPageSize: number | null = null;
  try {
    const storedTheme = localStorage.getItem(themeKey);
    if (storedTheme === "system" || storedTheme === "light" || storedTheme === "dark") theme = storedTheme;
    const storedSize = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    if (PAGE_SIZES.some((size) => size === storedSize)) historyPageSize = storedSize;
  } catch {
    // Missing cache values are absent preferences, never default-setting operations.
  }
  await updateUserPreferences({ theme, historyPageSize }, true);
}

export async function refreshUserPreferences(): Promise<void> {
  const generation = mutationGeneration;
  const preferences = await getUserPreferences();
  if (generation === mutationGeneration && pendingMutations === 0) applyUserPreferences(preferences);
}

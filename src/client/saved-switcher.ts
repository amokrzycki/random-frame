import { elements } from "./elements.js";

export interface SavedFilterChoice {
  value: string;
  label: string;
}
let choices: SavedFilterChoice[] = [];
let activeValue = "all";
let placement: "below" | "above" = "below";
let search = "";
let searchedAt = 0;
const isOpen = (): boolean => Boolean(elements.savedFilterMenu.matches?.(":popover-open"));

function position(opening = false): void {
  if (!opening && !isOpen()) return;
  const trigger = elements.savedFilter.getBoundingClientRect();
  const dialog = elements.historyDialog.getBoundingClientRect();
  const top = Math.max(8, dialog.top + 12);
  const bottom = Math.min(window.innerHeight - 8, dialog.bottom - 12);
  const below = bottom - trigger.bottom - 6;
  const above = trigger.top - 6 - top;
  if (opening || (placement === "below" ? below : above) < 44)
    placement = below >= Math.min(140, choices.length * 40 + 10) || below >= above ? "below" : "above";
  const available = Math.max(0, placement === "below" ? below : above);
  const menu = elements.savedFilterMenu;
  menu.dataset.placement = placement;
  menu.style.width = `${trigger.width}px`;
  menu.style.left = `${trigger.left}px`;
  menu.style.maxHeight = `${Math.min(300, available)}px`;
  menu.style.top = placement === "below" ? `${trigger.bottom + 6}px` : "auto";
  menu.style.bottom = placement === "above" ? `${window.innerHeight - trigger.top + 6}px` : "auto";
}

function activate(value: string, scroll = true): void {
  activeValue = value;
  const rows = [...elements.savedFilterMenu.children] as HTMLElement[];
  for (const row of rows) row.toggleAttribute("data-active", row.dataset.value === value);
  const active = rows.find((row) => row.dataset.value === value);
  if (active && isOpen()) {
    elements.savedFilter.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView?.({ block: "nearest" });
  }
}

function open(value = elements.savedFilter.value): void {
  if (elements.savedFilter.disabled || !choices.length) return;
  activeValue = value;
  if (!isOpen()) elements.savedFilterMenu.showPopover?.();
  activate(value);
}

export function closeSavedSwitcher(restoreFocus = true): boolean {
  if (!isOpen()) return false;
  elements.savedFilterMenu.hidePopover?.();
  elements.savedFilter.setAttribute("aria-expanded", "false");
  elements.savedFilter.removeAttribute("aria-activedescendant");
  search = "";
  if (restoreFocus) elements.savedFilter.focus({ preventScroll: true });
  return true;
}

function choose(value: string): void {
  if (!choices.some((choice) => choice.value === value)) return;
  closeSavedSwitcher();
  activeValue = value;
  if (value === elements.savedFilter.value) return;
  elements.savedFilter.value = value;
  elements.savedFilter.dispatchEvent(new Event("change"));
}

export function renderSavedSwitcher(next: SavedFilterChoice[], selected: string): void {
  choices = next;
  elements.savedFilter.value = selected;
  const label = choices.find((choice) => choice.value === selected)?.label ?? "All saved";
  elements.savedFilterValue.textContent = label;
  elements.savedFilter.title = label;
  elements.savedFilter.setAttribute("aria-label", `View: ${label}`);
  elements.savedFilterMenu.replaceChildren();
  for (const [index, choice] of choices.entries()) {
    const row = document.createElement("div");
    row.className = "saved-switcher__option";
    row.id = `saved-filter-option-${index}`;
    row.dataset.value = choice.value;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(choice.value === selected));
    const check = document.createElement("span");
    check.className = "saved-switcher__check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = '<svg viewBox="0 0 18 18"><path d="m4 9 3 3 7-7" /></svg>';
    const text = document.createElement("span");
    text.className = "saved-switcher__name";
    text.textContent = choice.label;
    row.append(check, text);
    row.addEventListener("click", () => choose(choice.value));
    elements.savedFilterMenu.append(row);
  }
  activate(isOpen() && choices.some((choice) => choice.value === activeValue) ? activeValue : selected);
  position();
}

export function bindSavedSwitcher(): void {
  elements.savedFilter.addEventListener("click", () => {
    if (!closeSavedSwitcher()) open();
  });
  // Options use aria-activedescendant: keep DOM focus on the combobox on pointer picks too.
  elements.savedFilterMenu.addEventListener("pointerdown", (event) => event.preventDefault());
  elements.savedFilterMenu.addEventListener("beforetoggle", (event) => {
    const opening = (event as ToggleEvent).newState === "open";
    elements.savedFilter.setAttribute("aria-expanded", String(opening));
    if (opening) position(true);
    else {
      elements.savedFilter.removeAttribute("aria-activedescendant");
      search = "";
    }
  });
  elements.savedFilter.addEventListener("blur", () => closeSavedSwitcher(false));
  elements.historyDialog.addEventListener("close", () => closeSavedSwitcher(false));
  elements.savedFilter.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey) return;
    const expanded = isOpen();
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      closeSavedSwitcher();
      return;
    }
    if (event.key === "Tab") {
      closeSavedSwitcher(false);
      return;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (expanded) choose(activeValue);
      else open();
      return;
    }
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      closeSavedSwitcher();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!expanded) {
        open(event.key === "Home" ? choices[0]?.value : event.key === "End" ? choices.at(-1)?.value : undefined);
        return;
      }
      const current = choices.findIndex((choice) => choice.value === activeValue);
      const step = event.key.startsWith("Page")
        ? Math.max(1, Math.floor(elements.savedFilterMenu.clientHeight / 40))
        : 1;
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? choices.length - 1
            : Math.max(
                0,
                Math.min(choices.length - 1, current + (["ArrowDown", "PageDown"].includes(event.key) ? step : -step)),
              );
      const next = choices[index];
      if (next) activate(next.value);
      return;
    }
    if (!event.altKey && event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      search = now - searchedAt > 700 ? event.key : search + event.key;
      searchedAt = now;
      // Repeated letters cycle matching names; a phrase searches by prefix.
      const query = [...search].every((letter) => letter === search[0]) ? (search[0] ?? "") : search;
      const current = choices.findIndex((choice) => choice.value === activeValue);
      const start = query.length === 1 ? current + 1 : current;
      const match = Array.from(
        { length: choices.length },
        (_, offset) => choices[(start + offset + choices.length) % choices.length],
      ).find((choice) => choice?.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()));
      if (match) {
        if (expanded) activate(match.value);
        else choose(match.value);
      }
    }
  });
  window.addEventListener?.("resize", () => position());
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => position()).observe(elements.savedFilter);
}

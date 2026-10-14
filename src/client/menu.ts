// Pinned to its button when it opens: the tools menu drops from the titlebar, the frame menu rises from the
// info line. Closing on pick, before the item's own handler runs, returns focus to the button so a dialog
// opened from the menu hands it back there. Items marked data-keep hold the menu open.
const menuItems = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>("button:not(:disabled):not([hidden]), a[href]")].filter(
    (item) => !item.closest("[hidden]"),
  );

export function bindMenu(menu: HTMLElement, button: HTMLElement, placement: "below" | "above"): void {
  menu.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    const rect = button.getBoundingClientRect();
    if (placement === "below") {
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    } else {
      menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      menu.style.left = window.innerWidth <= 480 ? "auto" : `${rect.left}px`;
      menu.style.right = window.innerWidth <= 480 ? "12px" : "auto";
    }
  });
  menu.addEventListener(
    "click",
    (event) => {
      const item = (event.target as Element).closest?.("button, a");
      if (item && !item.hasAttribute("data-keep")) menu.hidePopover?.();
    },
    true,
  );
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    menu.showPopover();
    const items = menuItems(menu);
    (event.key === "ArrowDown" ? items[0] : items[items.length - 1])?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (event.target as Element).tagName === "INPUT")
      return;
    const items = menuItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  });
}

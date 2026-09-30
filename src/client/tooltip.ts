// One shared tooltip for [data-tip]: shows at once on hover and on keyboard focus, which native title never does.
// It lives in the top layer, so no dialog, menu, or overflow clips it. Escape dismisses it.
const tip = document.createElement("div");
tip.className = "tooltip";
tip.popover = "manual";
tip.setAttribute("aria-hidden", "true");
document.body.append(tip);

let current: HTMLElement | null = null;

function hide(): void {
  current = null;
  if (tip.matches?.(":popover-open")) tip.hidePopover?.();
}

function show(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (!text) {
    hide();
    return;
  }
  current = target;
  tip.textContent = text;
  tip.showPopover?.();
  const anchor = target.getBoundingClientRect();
  const { width, height } = tip.getBoundingClientRect();
  const below = anchor.bottom + 8 + height <= window.innerHeight;
  tip.style.top = `${below ? anchor.bottom + 8 : anchor.top - 8 - height}px`;
  tip.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
}

const tipTarget = (node: EventTarget | null): HTMLElement | null =>
  node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null;

export function bindTooltipEvents(): void {
  document.addEventListener("pointerover", (event) => {
    const target = tipTarget(event.target);
    if (target && target !== current) show(target);
  });
  document.addEventListener("pointerout", (event) => {
    if (current && !current.contains(event.relatedTarget as Node | null)) hide();
  });
  document.addEventListener("focusin", (event) => {
    const target = tipTarget(event.target);
    if (target?.matches(":focus-visible")) show(target);
    else hide();
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
}

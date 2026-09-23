import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { blobKey, blobs, thumbnails } from "./frame-cache.js";
import { goTo } from "./frame-loader.js";
import { getExplorationStats, getViewingActivity, migrateViewingStats } from "./persistence.js";
import type { LedgerDay } from "./statistics.js";
import {
  drawStreak,
  formatExploredBreakdown,
  formatExploredPercent,
  formatLedgerCounts,
  LEDGER_PAGE_DAYS,
  LEDGER_STRIP_MAX,
  LEGACY_STATS_STORAGE_KEY,
  ledgerDateLabel,
  ledgerDays,
  localDayKey,
  parseLegacyStats,
} from "./statistics.js";
import { toast } from "./toast.js";
import { state } from "./viewer-state.js";

function ledgerThumbnail(itemIndex: number): HTMLButtonElement | null {
  const item = state.history[itemIndex];
  const key = item && blobKey(item.source, item.id);
  const src = key && (blobs.get(key)?.url ?? thumbnails.get(key));
  if (!item || !src) return null;
  const button = document.createElement("button");
  const image = document.createElement("img");
  button.type = "button";
  button.className = "ledger__thumb";
  button.title = item.id;
  button.setAttribute("aria-label", `Show frame ${itemIndex + 1}, ${item.id}`);
  if (itemIndex === state.index) button.setAttribute("aria-current", "true");
  image.src = src;
  image.alt = "";
  image.loading = "lazy";
  button.append(image);
  button.addEventListener("click", () => {
    closeDialog(elements.statsDialog);
    void goTo(itemIndex);
  });
  return button;
}

function ledgerRow(day: LedgerDay, todayIso: string, maxDrawn: number): HTMLLIElement {
  const row = document.createElement("li");
  const date = document.createElement("span");
  const counts = document.createElement("span");
  const strip = document.createElement("div");
  const label = ledgerDateLabel(day.date, todayIso);
  row.className = "ledger__row";
  // Focusable only for Show earlier days to land on; the thumbnails are the tab stops.
  row.tabIndex = -1;
  row.setAttribute("aria-label", `${label}: ${formatLedgerCounts(day.drawn, day.unavailable)}`);
  date.className = "ledger__date";
  date.textContent = label;
  counts.className = "ledger__counts";
  counts.textContent = formatLedgerCounts(day.drawn, day.unavailable);
  strip.className = "ledger__strip";
  const thumbs: HTMLButtonElement[] = [];
  for (const itemIndex of day.frames) {
    if (thumbs.length === LEDGER_STRIP_MAX) break;
    const thumb = ledgerThumbnail(itemIndex);
    if (thumb) thumbs.push(thumb);
  }
  strip.append(...thumbs);
  const overflow = Math.max(day.drawn, day.frames.length) - thumbs.length;
  if (thumbs.length && overflow > 0) {
    const more = document.createElement("span");
    more.className = "ledger__more-count";
    more.textContent = `+${overflow.toLocaleString("en-US")}`;
    strip.append(more);
  }
  if (!thumbs.length && day.drawn) {
    // No saved thumbnails for this day: a hairline sized to its share of the busiest day.
    const bar = document.createElement("span");
    bar.className = "ledger__bar";
    bar.setAttribute("aria-hidden", "true");
    bar.style.setProperty?.("--share", String(day.drawn / maxDrawn));
    strip.append(bar);
  }
  row.append(date, counts, strip);
  return row;
}

// Rows render in pages of LEDGER_PAGE_DAYS, so months of activity never build one long list up front.
function renderLedgerPage(): HTMLLIElement | undefined {
  const todayIso = localDayKey(Date.now());
  const maxDrawn = Math.max(1, ...state.ledger.map((day) => day.drawn));
  const rows = state.ledger
    .slice(state.ledgerShown, state.ledgerShown + LEDGER_PAGE_DAYS)
    .map((day) => ledgerRow(day, todayIso, maxDrawn));
  elements.ledgerList.append(...rows);
  state.ledgerShown += rows.length;
  elements.ledgerMore.hidden = state.ledgerShown >= state.ledger.length;
  return rows[0];
}

function renderLedger(days: LedgerDay[]): void {
  state.ledger = days;
  state.ledgerShown = 0;
  elements.ledgerList.replaceChildren();
  elements.ledgerEmpty.hidden = days.length > 0;
  elements.statsBody.scrollTop = 0;
  renderLedgerPage();
}

async function loadStats(): Promise<void> {
  try {
    const [exploration, activity] = await Promise.all([getExplorationStats(), getViewingActivity()]);
    elements.statsToday.textContent = String(activity.days.at(-1)?.viewed ?? 0);
    elements.statsTotal.textContent = activity.viewedTotal.toLocaleString("en-US");
    elements.statsStreak.textContent = drawStreak(activity.days).toLocaleString("en-US");
    elements.statsExplored.textContent = `${exploration.explored.toLocaleString("en-US")} / ${exploration.total.toLocaleString("en-US")}`;
    elements.statsExploredPercent.textContent = `${formatExploredPercent(exploration.explored, exploration.total)} of known legacy ID space`;
    elements.statsExploredBreakdown.textContent = formatExploredBreakdown(
      exploration.explored,
      exploration.viewable,
      exploration.unavailable,
    );
    renderLedger(
      ledgerDays(
        activity.days,
        state.history.map((item) => item.viewedAt),
      ),
    );
    delete elements.statsExplored.dataset.state;
    elements.statsError.hidden = true;
    elements.ledger.hidden = false;
  } catch {
    // Dashes, not zeros: the counts are unknown, not empty.
    elements.statsToday.textContent = "—";
    elements.statsTotal.textContent = "—";
    elements.statsStreak.textContent = "—";
    elements.statsExplored.textContent = "Unavailable";
    elements.statsExplored.dataset.state = "unavailable";
    elements.statsExploredPercent.textContent = "";
    elements.statsExploredBreakdown.textContent = "";
    elements.statsError.hidden = false;
    elements.ledger.hidden = true;
  }
}

export async function migrateLegacyStats(): Promise<void> {
  const legacy = parseLegacyStats(localStorage.getItem(LEGACY_STATS_STORAGE_KEY));
  if (!legacy) return;
  try {
    await migrateViewingStats(legacy.day, legacy.today, legacy.total);
    localStorage.removeItem(LEGACY_STATS_STORAGE_KEY);
  } catch {
    // Best-effort; retried on the next launch if it failed this time
  }
}

export function bindStatsDialogEvents(): void {
  elements.statsButton.addEventListener("click", async () => {
    await loadStats();
    openDialog(elements.statsDialog);
  });
  elements.statsRetry.addEventListener("click", async () => {
    await loadStats();
    if (elements.statsError.hidden) elements.statsClose.focus();
    // A fresh toast node each time, so repeat failures are announced again.
    else toast.error("Stats still couldn’t be read");
  });
  elements.ledgerMore.addEventListener("click", () => renderLedgerPage()?.focus());
  elements.statsClose.addEventListener("click", () => closeDialog(elements.statsDialog));
  elements.statsDialog.addEventListener("close", () => {
    onDialogClosed();
    elements.statsButton.focus();
  });
}

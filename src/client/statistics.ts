interface ViewingStats {
  day: string;
  today: number;
  total: number;
}

const storageKey = "random-frame-viewing-stats";

function currentDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readStats(getStorage: () => Storage): ViewingStats {
  const day = currentDay();
  try {
    const stored: unknown = JSON.parse(getStorage().getItem(storageKey) ?? "");
    if (
      typeof stored === "object" &&
      stored !== null &&
      "day" in stored &&
      "today" in stored &&
      "total" in stored &&
      typeof stored.day === "string" &&
      typeof stored.today === "number" &&
      Number.isInteger(stored.today) &&
      stored.today >= 0 &&
      typeof stored.total === "number" &&
      Number.isInteger(stored.total) &&
      stored.total >= stored.today
    )
      return { day, today: stored.day === day ? stored.today : 0, total: stored.total };
  } catch {
    // Use fresh in-memory statistics when browser storage is unavailable or invalid
  }
  return { day, today: 0, total: 0 };
}

export function createViewingStats(getStorage: () => Storage) {
  let stats = readStats(getStorage);

  function refreshDay(): void {
    if (stats.day !== currentDay()) stats = { ...stats, day: currentDay(), today: 0 };
  }

  return {
    recordView(): void {
      refreshDay();
      stats.today += 1;
      stats.total += 1;
      try {
        getStorage().setItem(storageKey, JSON.stringify(stats));
      } catch {
        // Keep counting in memory for this page view
      }
    },
    current(): Readonly<ViewingStats> {
      refreshDay();
      return stats;
    },
  };
}

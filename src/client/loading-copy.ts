import { archiveMessages } from "./loading-copy/archive.js";
import { easterEggMessages } from "./loading-copy/easter-egg.js";
import { neutralMessages } from "./loading-copy/neutral.js";
import { playfulMessages } from "./loading-copy/playful.js";

// Category weights stay independent of pool size, so adding jokes never makes them more frequent.
export const loadingMessages = [
  { category: "neutral", weight: 72, messages: neutralMessages },
  { category: "archive", weight: 23, messages: archiveMessages },
  { category: "playful", weight: 4, messages: playfulMessages },
  { category: "easterEgg", weight: 1, messages: easterEggMessages },
];

const recentMessages: string[] = [];
let previousCategory = "";

export function pickLoadingMessage(exclude: readonly string[]): string {
  const blocked = new Set([...exclude, ...recentMessages]);
  // A quiet caption separates jokes; neutral and archive can repeat their category.
  const afterJoke = previousCategory === "playful" || previousCategory === "easterEgg";
  const pools = loadingMessages.filter(
    (pool) => !afterJoke || pool.category === "neutral" || pool.category === "archive",
  );
  let available = pools
    .map((pool) => ({ ...pool, messages: pool.messages.filter((message) => !blocked.has(message)) }))
    .filter((pool) => pool.messages.length > 0);
  // If a caller excludes every eligible message, session history still prevents repeats.
  if (available.length === 0)
    available = pools
      .map((pool) => ({ ...pool, messages: pool.messages.filter((message) => !recentMessages.includes(message)) }))
      .filter((pool) => pool.messages.length > 0);

  let roll = Math.random() * available.reduce((total, pool) => total + pool.weight, 0);
  const group =
    available.find((pool) => {
      roll -= pool.weight;
      return roll < 0;
    }) ?? available[0];
  const messages = group?.messages ?? [];
  const message = messages[Math.floor(Math.random() * messages.length)] ?? "Drawing a frame…";
  recentMessages.push(message);
  if (recentMessages.length > 100) recentMessages.shift();
  previousCategory = group?.category ?? "neutral";
  return message;
}

import type { ServerResponse } from "node:http";
import { sendJson } from "./http.js";

let tokens = 8;
let updatedAt = Date.now();

export function takeApiToken(response: ServerResponse): boolean {
  const now = Date.now();
  tokens = Math.min(8, tokens + ((now - updatedAt) / 1000) * 3);
  updatedAt = now;
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }

  // ponytail: process-local by design; use shared state only if the app runs multiple instances.
  const retryAfter = Math.max(1, Math.ceil((1 - tokens) / 3));
  sendJson(
    response,
    429,
    { error: "Too many requests. Please try again shortly." },
    { "retry-after": String(retryAfter) },
  );
  return false;
}

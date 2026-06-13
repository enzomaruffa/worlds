import { LIMITS } from "./config";
import { WorldError } from "./errors";

// In-memory sliding windows. Single-pod for now; these protect cost, not security.
const windows = new Map<string, number[]>();
const DAY = 24 * 60 * 60 * 1000;

function take(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retry = Math.ceil((windowMs - (now - hits[0]!)) / 1000);
    throw new WorldError("rate_limited", "rate limit exceeded", retry);
  }
  hits.push(now);
  windows.set(key, hits);
}

const secondsToMidnightUTC = () => {
  const now = new Date();
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);
};

export const allowDeploy = (site: string) => take(`deploy:${site}`, LIMITS.deploysPerSitePerHour, 60 * 60 * 1000);

export function takeQuota(kind: "ai" | "ai_image" | "slack", user: string): void {
  const max =
    kind === "ai" ? LIMITS.aiCompletionsPerUserPerDay
    : kind === "ai_image" ? LIMITS.aiImagesPerUserPerDay
    : LIMITS.slackPerUserPerDay;
  const now = Date.now();
  const key = `${kind}:${user}`;
  const hits = (windows.get(key) ?? []).filter((t) => now - t < DAY);
  if (hits.length >= max) throw new WorldError("quota_exceeded", `daily ${kind} quota reached`, secondsToMidnightUTC());
  hits.push(now);
  windows.set(key, hits);
}

// Evict windows that have fully aged out so the map doesn't grow forever.
// Deploy keys are hourly; quota keys are daily — evict against each key's own window.
const HOUR = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of windows) {
    const windowMs = key.startsWith("deploy:") ? HOUR : DAY;
    if (hits.every((t) => now - t >= windowMs)) windows.delete(key);
  }
}, 10 * 60 * 1000).unref?.();

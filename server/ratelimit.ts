import { LIMITS } from "./config";
import { WorldsError } from "./errors";

// In-memory sliding windows. Single-pod for now; these protect cost, not security.
const windows = new Map<string, number[]>();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function take(key: string, max: number, windowMs: number, onFull: (oldestHit: number) => WorldsError): void {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw onFull(hits[0]!);
  hits.push(now);
  windows.set(key, hits);
}

const secondsToMidnightUTC = () => {
  const now = new Date();
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);
};

export const allowDeploy = (site: string) =>
  take(`deploy:${site}`, LIMITS.deploysPerSitePerHour, HOUR, (oldest) =>
    new WorldsError("rate_limited", "rate limit exceeded", Math.ceil((HOUR - (Date.now() - oldest)) / 1000)));

export const allowConnect = (site: string) =>
  take(`connect:${site}`, LIMITS.connectCallsPerSitePerHour, HOUR, (oldest) =>
    new WorldsError("rate_limited", "connector rate limit exceeded", Math.ceil((HOUR - (Date.now() - oldest)) / 1000)));

export function takeQuota(kind: "ai" | "ai_image" | "slack" | "connect", user: string): void {
  const max =
    kind === "ai" ? LIMITS.aiCompletionsPerUserPerDay
    : kind === "ai_image" ? LIMITS.aiImagesPerUserPerDay
    : kind === "connect" ? LIMITS.connectCallsPerUserPerDay
    : LIMITS.slackPerUserPerDay;
  // Daily quotas reset at midnight UTC, not one window after the first call.
  take(`${kind}:${user}`, max, DAY, () =>
    new WorldsError("quota_exceeded", `daily ${kind} quota reached`, secondsToMidnightUTC()));
}

// Evict windows that have fully aged out so the map doesn't grow forever.
// Deploy keys are hourly; quota keys are daily — evict against each key's own window.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of windows) {
    const windowMs = key.startsWith("deploy:") || key.startsWith("connect:") ? HOUR : DAY;
    if (hits.every((t) => now - t >= windowMs)) windows.delete(key);
  }
}, 10 * 60 * 1000).unref?.();

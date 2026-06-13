// worlds.js v1 — the SDK entry point. Built (bundled) into the single served
// /worlds.js artifact via `bun run build:sdk`. Frozen surface; see docs/sdk.md + /llms.txt.
import { WorldsError } from "./error";
import { call } from "./http";
import { collection } from "./db";
import { ai } from "./ai";
import { uploads } from "./uploads";
import { ws } from "./channels";
import { notify } from "./notify";

const worlds: any = {
  WorldsError,
  site: { name: null, url: null },
  me: () => call("GET", "/api/v1/me"),
  db: {
    collection,
    site: (name: string) => ({ collection: (c: string) => collection(c, name) }),
  },
  ai,
  uploads,
  ws,
  notify,
};

// Resolve this site's context once; sites can `await worlds.ready`.
worlds.ready = call("GET", "/api/v1/site").then((s: any) => { worlds.site = s; return s; }).catch(() => worlds.site);

// Visit beacon — feeds the universe's planet sizes. Never throws.
try {
  const site = location.hostname.split(".")[0];
  if (navigator.sendBeacon && site && site !== "worlds") {
    navigator.sendBeacon("/api/v1/beacon/visit", new Blob([JSON.stringify({ site })], { type: "application/json" }));
  }
} catch { /* beacons never break sites */ }

(globalThis as any).worlds = worlds;

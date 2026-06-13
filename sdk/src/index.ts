// world.js v1 — the SDK entry point. Built (bundled) into the single served
// /world.js artifact via `bun run build:sdk`. Frozen surface; see docs/sdk.md + /llms.txt.
import { WorldError } from "./error";
import { call } from "./http";
import { collection } from "./db";
import { ai } from "./ai";
import { uploads } from "./uploads";
import { ws } from "./channels";
import { notify } from "./notify";

const world: any = {
  WorldError,
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

// Resolve this site's context once; sites can `await world.ready`.
world.ready = call("GET", "/api/v1/site").then((s: any) => { world.site = s; return s; }).catch(() => world.site);

// Visit beacon — feeds the universe's planet sizes. Never throws.
try {
  const site = location.hostname.split(".")[0];
  if (navigator.sendBeacon && site && site !== "world") {
    navigator.sendBeacon("/api/v1/beacon/visit", new Blob([JSON.stringify({ site })], { type: "application/json" }));
  }
} catch { /* beacons never break sites */ }

(globalThis as any).world = world;

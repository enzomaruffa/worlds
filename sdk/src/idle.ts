import { call } from "./http";
import { collection } from "./db";

// worlds.idle(key, opts) — the offline/idle-progress battery. Every incremental
// or tend-it game re-implements the same three things: remember when the player
// was last here, credit the (capped) time they were away, and show a "while you
// were away" summary. This rolls that into one primitive.
//
// The SDK owns the GENERIC half — persisting `lastSeen`, computing capped elapsed
// time, a heartbeat (auto on tab-hide / unload), and a self-contained summary
// modal. The GAME owns the specific half — how its world advances over N seconds
// — which it does itself after reading `elapsed()`, then passes a report object
// to `summary()`.
//
//   const idle = worlds.idle("my-game", { cap: 8 * 3600 });
//   const secs = await idle.elapsed();             // capped seconds away, or null
//   if (secs) { const report = advanceMyWorld(secs); idle.summary(report); }
//   idle.beat();                                   // also auto-beats on hide/unload
//
// Persistence: store:"local" (default) keeps lastSeen in localStorage; "db" keeps
// it in a per-player worlds.db doc; "none" means the caller owns `lastSeen` (pass
// it in) — e.g. a game that already saves its own state + timestamp.

export interface IdleOptions {
  cap?: number;        // max credited offline seconds (default 8h)
  lastSeen?: number;   // caller-owned ms timestamp; when set, store defaults to "none"
  store?: "db" | "local" | "none";
  min?: number;        // ignore gaps under this many seconds (default 30)
}
export interface IdleSummaryOptions {
  title?: string;
  render?: (report: any) => string; // returns body HTML; default lists report entries
  onClose?: () => void;
}
export interface Idle {
  elapsed(): Promise<number | null>; // capped seconds since last visit (null if first/too-short)
  beat(): void;                      // stamp lastSeen = now (no-op when the caller owns lastSeen)
  summary(report: any, opts?: IdleSummaryOptions): void;
  stop(): void;
}

const HOUR = 3600;
const siteName = () => (typeof location !== "undefined" ? location.hostname.split(".")[0] : "site");
const esc = (s: any) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };

export function idle(key = "default", opts: IdleOptions = {}): Idle {
  const cap = Math.max(0, opts.cap ?? 8 * HOUR);
  const min = Math.max(0, opts.min ?? 30);
  const callerOwns = opts.lastSeen != null;
  const store = opts.store ?? (callerOwns ? "none" : "local");
  const lsKey = `worlds:idle:${siteName()}:${key}`;
  let handle: string | null = null, col: any = null, docId: string | null = null, dead = false;

  async function whoami(): Promise<string | null> {
    if (handle) return handle;
    try { const m: any = await call("GET", "/api/v1/me"); handle = m && m.handle; } catch {}
    return handle;
  }
  async function readLastSeen(): Promise<number | null> {
    if (callerOwns) return opts.lastSeen ?? null;
    if (store === "local") { try { const v = localStorage.getItem(lsKey); return v ? Number(v) : null; } catch { return null; } }
    if (store === "db") {
      try {
        col = col || collection("__idle");
        const h = await whoami();
        const page = await col.list({ filter: { _idle: key }, limit: 50 });
        const mine = (page.items || []).find((it: any) => it.created_by === h || (it.data && it.data.handle === h));
        if (mine) { docId = mine.id; return mine.data.lastSeen ?? null; }
      } catch {}
    }
    return null;
  }
  function writeLastSeen(ts: number): void {
    if (callerOwns || store === "none") return;
    if (store === "local") { try { localStorage.setItem(lsKey, String(ts)); } catch {} return; }
    if (store === "db") {
      col = col || collection("__idle");
      (async () => {
        try {
          if (docId) await col.update(docId, { lastSeen: ts });
          else { const h = await whoami(); const d = await col.create({ _idle: key, handle: h, lastSeen: ts }); docId = d.id; }
        } catch {}
      })();
    }
  }

  async function elapsed(): Promise<number | null> {
    const last = await readLastSeen();
    const now = Date.now();
    writeLastSeen(now); // consume the gap exactly once (no double-credit on a quick reload)
    if (last == null) return null;
    const secs = Math.min(cap, Math.max(0, (now - last) / 1000));
    return secs >= min ? secs : null;
  }
  function beat(): void { if (!dead) writeLastSeen(Date.now()); }

  // auto-heartbeat so a closed/backgrounded tab still records "last here"
  const onHide = () => { if (document.visibilityState === "hidden") beat(); };
  if (typeof document !== "undefined" && store !== "none") {
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", beat);
  }

  function summary(report: any, sopts: IdleSummaryOptions = {}): void {
    if (typeof document === "undefined" || !document.body) return;
    ensureCss();
    const body = sopts.render ? sopts.render(report) : defaultRender(report);
    const back = document.createElement("div");
    back.className = "worlds-idle-back";
    back.innerHTML = `<div class="worlds-idle-card" role="dialog" aria-modal="true">
      <div class="worlds-idle-title">${esc(sopts.title || "While you were away")}</div>
      <div class="worlds-idle-body">${body}</div>
      <button class="worlds-idle-x">collect</button></div>`;
    const close = () => { back.remove(); sopts.onClose && sopts.onClose(); };
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector(".worlds-idle-x")!.addEventListener("click", close);
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add("show"));
  }

  function stop(): void {
    dead = true;
    try { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("beforeunload", beat); } catch {}
  }

  return { elapsed, beat, summary, stop };
}

function defaultRender(report: any): string {
  if (report == null) return "";
  if (typeof report !== "object") return `<p>${esc(report)}</p>`;
  const rows = Object.entries(report).filter(([, v]) => typeof v !== "object").map(([k, v]) => `<div class="worlds-idle-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`);
  return rows.join("") || "<p>welcome back 🌱</p>";
}

let cssDone = false;
function ensureCss(): void {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const s = document.createElement("style");
  s.textContent =
    ".worlds-idle-back{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);opacity:0;transition:opacity .2s}" +
    ".worlds-idle-back.show{opacity:1}" +
    ".worlds-idle-card{background:#10161b;color:#e8efe8;border:1px solid #2f4636;border-radius:14px;padding:1.1rem 1.25rem;max-width:min(92vw,24rem);box-shadow:0 18px 60px rgba(0,0,0,.5);font:500 .9rem/1.4 ui-rounded,ui-sans-serif,system-ui,sans-serif;transform:translateY(8px);transition:transform .2s}" +
    ".worlds-idle-back.show .worlds-idle-card{transform:none}" +
    ".worlds-idle-title{font-size:1.1rem;font-weight:700;margin-bottom:.6rem}" +
    ".worlds-idle-row{display:flex;justify-content:space-between;gap:1rem;padding:.18rem 0}.worlds-idle-row b{color:#9fe06a}" +
    ".worlds-idle-x{margin-top:.9rem;width:100%;cursor:pointer;font:inherit;font-weight:700;padding:.5rem;border-radius:9px;border:1px solid #6cc24a;background:rgba(108,194,74,.16);color:#9fe06a}";
  document.head.appendChild(s);
}

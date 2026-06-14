// Every world gets an easy way out. The SDK drops a small "◐ Worlds" pill in the
// top-left that flies you back to the universe — so no site is a dead end, even
// ones whose author never thought about it. Skipped on the home/universe site and
// when a site opts out via `window.__worldsNoLeave = true` before worlds.js loads.

function leaveHref(): string {
  try {
    // Path-routed (`/app/<site>/`): the apex is the same host → go to root.
    if (location.pathname.startsWith("/app/")) return "/";
    // Subdomain-routed (`<site>.<base>`): strip the leading label to reach the apex.
    const parts = location.hostname.split(".");
    if (parts.length > 2) return `${location.protocol}//${parts.slice(1).join(".")}/`;
    return "/";
  } catch {
    return "/";
  }
}

export function mountLeave(site: { name?: string | null } | null): void {
  try {
    if (typeof document === "undefined") return;
    if ((globalThis as any).__worldsNoLeave) return;
    const name = site && site.name;
    if (name === "home" || name === "universe" || name === "worlds") return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => mountLeave(site), { once: true });
      return;
    }
    if (document.getElementById("__worlds_leave")) return;

    const style = document.createElement("style");
    style.textContent =
      "#__worlds_leave{position:fixed;top:12px;left:12px;z-index:2147483646;display:flex;align-items:center;" +
      "gap:.45rem;padding:.42rem .8rem .42rem .55rem;border-radius:999px;background:rgba(12,12,15,.72);" +
      "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid #27272a;color:#e4e4e7;" +
      "font:600 13px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.4);" +
      "opacity:.5;transition:opacity .15s ease,transform .15s ease}" +
      "#__worlds_leave:hover{opacity:1;transform:translateY(-1px);border-color:#f59e0b}" +
      "#__worlds_leave .wl-ring{width:15px;height:15px;border-radius:50%;border:2px solid #f59e0b;position:relative;flex:none}" +
      "#__worlds_leave .wl-ring::after{content:'';position:absolute;inset:3.5px;border-radius:50%;background:#fbbf24}" +
      "@media print{#__worlds_leave{display:none}}";
    document.head.appendChild(style);

    const a = document.createElement("a");
    a.id = "__worlds_leave";
    a.href = leaveHref();
    a.title = "Back to the Worlds universe";
    a.setAttribute("aria-label", "Back to Worlds");
    a.innerHTML = '<span class="wl-ring"></span><span>Worlds</span>';
    document.body.appendChild(a);
  } catch {
    /* a leave button must never break a site */
  }
}

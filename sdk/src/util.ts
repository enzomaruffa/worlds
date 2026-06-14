// Small building blocks every multiplayer/collab site re-implements. Tiny on
// their own, but they're copy-pasted into every app — so they live here once.

// A stable per-tab id. Attach as `cid` to ws messages to ignore your own echoes.
let _id: string | null = null;
export function id(): string {
  if (!_id) {
    _id =
      (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
        ? globalThis.crypto.randomUUID()
        : `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
  return _id;
}

// Deterministic, pleasant color from any string (a handle, a name). Same input
// → same color everywhere, so a player keeps their color across every surface.
export function colorFor(seed: string): string {
  let h = 0;
  const s = String(seed ?? "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 68% 56%)`;
}

// Dedup a presence/member list by handle, keeping the first name seen.
export function uniqByHandle(list: any[]): { handle: string; name: string }[] {
  const seen = new Set<string>();
  const out: { handle: string; name: string }[] = [];
  for (const m of list || []) {
    if (m && m.handle && !seen.has(m.handle)) {
      seen.add(m.handle);
      out.push({ handle: m.handle, name: m.name || m.handle });
    }
  }
  return out;
}

// HTML-escape untrusted text before putting it in innerHTML.
export function esc(s: any): string {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

export interface Countdown {
  stop(): void;
}
// Drive a countdown to an absolute timestamp. onTick gets ms remaining; onEnd
// fires once at zero. Returns a handle so you can stop it on teardown.
export function countdown(
  endsAt: number,
  opts: { onTick: (msLeft: number) => void; onEnd?: () => void; interval?: number },
): Countdown {
  const interval = opts.interval ?? 250;
  let h: ReturnType<typeof setInterval> | null = null;
  let ended = false;
  function stop(): void {
    if (h) {
      clearInterval(h);
      h = null;
    }
  }
  function tick(): void {
    const left = Math.max(0, endsAt - Date.now());
    opts.onTick(left);
    if (left <= 0 && !ended) {
      ended = true;
      stop();
      opts.onEnd?.();
    }
  }
  h = setInterval(tick, interval);
  tick();
  return { stop };
}

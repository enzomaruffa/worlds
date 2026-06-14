// A self-contained transient toast. No markup or CSS required in the site —
// the first call injects a styled element. Override via the `.worlds-toast`
// class if a site wants its own look.
let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function ensure(): HTMLDivElement | null {
  if (el) return el;
  if (typeof document === "undefined" || !document.body) return null;
  const style = document.createElement("style");
  style.textContent =
    ".worlds-toast{position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%) translateY(8px);" +
    "background:#0c0c0f;border:1px solid #27272a;color:#e4e4e7;padding:.6rem 1rem;border-radius:10px;" +
    "font:500 .85rem/1.4 ui-sans-serif,system-ui,sans-serif;z-index:2147483647;box-shadow:0 10px 30px rgba(0,0,0,.5);" +
    "opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;max-width:min(92vw,420px);text-align:center}" +
    ".worlds-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}";
  document.head.appendChild(style);
  el = document.createElement("div");
  el.className = "worlds-toast";
  document.body.appendChild(el);
  return el;
}

export function toast(text: string, ms = 2400): void {
  const t = ensure();
  if (!t) return;
  t.textContent = String(text ?? "");
  t.classList.add("show");
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove("show"), ms);
}

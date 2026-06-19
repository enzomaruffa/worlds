// ───────────────────────────────────────────────────────────────────────────
// guide.js — the first-run tutorial + reopenable "How to play". A friendly
// multi-page modal that explains the whole loop: clean → grow → evolve → expand
// → rewild, plus currencies, seasons, neighbours and the market. Auto-opens once
// for new players; the ❓ toolbar button reopens it anytime.
// ───────────────────────────────────────────────────────────────────────────

const PAGES = [
  {
    icon: "🌱", title: "Welcome to Sward",
    body: "This bare patch of land is <b>yours</b>. Bring it to life — clear the dirt, grow real 3D grass, and raise a tiny living ecosystem that changes with the sun and the seasons.<br><br>Here's everything you need to know in a few taps →",
  },
  {
    icon: "🧹", title: "Clean, then grow",
    body: "Tap the rocks, logs & stumps to <b>clear</b> them — each gives you <b>💧 Dew</b>.<br><br>Pick the <b>🌱 Seed</b> tool and tap the ground to plant grass. It spreads on its own and, once it's lush, earns Dew over time. <b>Dew is your main currency</b> — you'll spend it on everything.",
  },
  {
    icon: "🌳", title: "Plant a living world",
    body: "Features in the bar start <b>🔒 locked</b> — tap one to unlock it with Dew, then tap your land to place it.<br><br>Each feature <b>evolves through stages</b> and reacts to its neighbours: a mature <b>tree</b> casts shade so <b>mushrooms</b> appear, a <b>hive</b> pollinates nearby <b>flowers</b> into a meadow, a <b>pond</b> waters the ground downhill. <i>Arrange them well</i> to climb your <b>🌿 Ecosystem</b> level (it multiplies your Dew). Tap a feature to inspect it; drag to move it.",
  },
  {
    icon: "🪴", title: "Grow your land",
    body: "Open the <b>🛠 shed</b> to <b>expand your plot</b> (push the fence out for more room to grow), buy <b>upgrades</b> (auto-rake, sprinkler, fertilizer…), and spend <b>🍄 Spores</b> on permanent perks.<br><br>Everything gets pricier as you go — there's a long way to grow. 🌻",
  },
  {
    icon: "☀️", title: "A living, breathing plot",
    body: "Time flies here: watch <b>sunrises, sunsets</b> and <b>four seasons</b> roll past — they change how fast things grow. <b>Events</b> drift through (rain, migrations, festivals) and little critters fly by — <b>tap a bug</b> to catch it for a reward.<br><br>Your plot keeps growing <b>while you're away</b> — pop back for a “while you were away” haul.",
  },
  {
    icon: "🤝", title: "The neighbourhood",
    body: "You're one plot among many. <b>Visit</b> neighbours from the list, <b>💧 water</b> their plots to help them (and earn Dew), <b>trade goods</b> at the <b>🤝 market</b>, and climb the greenest-plot board.<br><br>When your plot reaches its peak, <b>🍄 rewild</b> it (in the shed) to bank Spores for permanent perks — then grow an even greater garden. Happy tending! 🌱",
  },
];

let el = null, page = 0, onDone = null;

function ensure() {
  if (el) return;
  el = document.createElement("div");
  el.id = "guide";
  el.style = "position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(6,12,8,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)";
  document.getElementById("app").appendChild(el);
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
}
function render() {
  const p = PAGES[page], last = page === PAGES.length - 1, first = page === 0;
  const dots = PAGES.map((_, i) => `<span style="width:.5rem;height:.5rem;border-radius:50%;background:${i === page ? "var(--leaf-bright)" : "var(--border)"}"></span>`).join("");
  el.innerHTML = `<div class="panel" style="width:min(94vw,30rem);max-height:88vh;overflow:auto;padding:1.4rem 1.5rem;text-align:center">
      <div style="font-size:3rem;line-height:1">${p.icon}</div>
      <h2 style="margin:.4rem 0 .6rem;font-size:1.3rem;color:var(--leaf-bright)">${p.title}</h2>
      <div style="font-size:.92rem;color:var(--ink);line-height:1.6;text-align:left">${p.body}</div>
      <div style="display:flex;justify-content:center;gap:.4rem;margin:1rem 0 .9rem">${dots}</div>
      <div style="display:flex;gap:.5rem;justify-content:space-between;align-items:center">
        <button id="gSkip" style="pointer-events:auto;cursor:pointer;font:inherit;font-size:.78rem;color:var(--dim);background:none;border:none">${last ? "" : "skip"}</button>
        <div style="display:flex;gap:.5rem">
          ${first ? "" : `<button id="gBack" style="pointer-events:auto;cursor:pointer;font:inherit;font-weight:600;font-size:.82rem;padding:.5rem .9rem;border-radius:.6rem;border:1px solid var(--border);background:rgba(11,18,13,.6);color:var(--ink)">back</button>`}
          <button id="gNext" style="pointer-events:auto;cursor:pointer;font:inherit;font-weight:700;font-size:.82rem;padding:.5rem 1.1rem;border-radius:.6rem;border:1px solid var(--leaf);background:rgba(108,194,74,.2);color:var(--leaf-bright)">${last ? "Let's grow 🌱" : "next"}</button>
        </div>
      </div>
    </div>`;
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener("click", fn); };
  on("#gSkip", close);
  on("#gBack", () => { page = Math.max(0, page - 1); render(); });
  on("#gNext", () => { if (last) close(); else { page++; render(); } });
}
function close() {
  if (el) el.style.display = "none";
  try { localStorage.setItem("sward:seenGuide", "1"); } catch (_) {}
  if (onDone) { const f = onDone; onDone = null; f(); }
}

export function open(p = 0, done) {
  ensure(); page = p; onDone = done || null; render(); el.style.display = "flex";
}
export function maybeAutoOpen(isNewPlayer, done) {
  let seen = false; try { seen = !!localStorage.getItem("sward:seenGuide"); } catch (_) {}
  if (isNewPlayer && !seen) open(0, done); else if (done) done();
}

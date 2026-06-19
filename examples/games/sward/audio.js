// ───────────────────────────────────────────────────────────────────────────
// audio.js — tiny procedural WebAudio palette (no files). Soft, gardeny cues:
// a rake snip, a seed pop, a water trickle, a place chime, a catch sparkle, a
// quest jingle, a rewild whoosh. Starts on first interaction (autoplay policy).
// ───────────────────────────────────────────────────────────────────────────
let ctx = null, master = null, muted = false;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.3; master.connect(ctx.destination);
  }
  return ctx;
}
export function resume() { const c = ac(); if (c && c.state === "suspended") c.resume(); }
export function setMuted(b) { muted = !!b; if (master) master.gain.value = muted ? 0 : 0.3; }
export const isMuted = () => muted;

function tone(freq, dur, { type = "sine", vol = 0.3, at = 0, slideTo = null } = {}) {
  const c = ac(); if (!c || muted) return;
  const t0 = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur, { vol = 0.2, lp = 1800, at = 0 } = {}) {
  const c = ac(); if (!c || muted) return;
  const t0 = c.currentTime + at;
  const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp;
  const g = c.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(master); src.start(t0);
}

export const sfx = {
  click() { tone(420, 0.05, { type: "triangle", vol: 0.12 }); },
  clean() { noise(0.18, { vol: 0.25, lp: 2600 }); tone(180, 0.12, { type: "sawtooth", vol: 0.08, slideTo: 90 }); },
  seed() { tone(520, 0.12, { type: "sine", vol: 0.18, slideTo: 720 }); },
  water() { noise(0.4, { vol: 0.16, lp: 1200 }); },
  place() { tone(440, 0.14, { type: "triangle", vol: 0.2 }); tone(660, 0.18, { type: "triangle", vol: 0.16, at: 0.06 }); },
  stage() { tone(523, 0.12, { vol: 0.14 }); tone(784, 0.16, { vol: 0.12, at: 0.08 }); },
  catch() { [660, 880, 1175].forEach((f, i) => tone(f, 0.1, { type: "sine", vol: 0.16, at: i * 0.05 })); },
  quest() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { type: "triangle", vol: 0.16, at: i * 0.09 })); },
  rewild() { tone(300, 0.5, { type: "sine", vol: 0.2, slideTo: 120 }); noise(0.5, { vol: 0.12, lp: 900 }); tone(440, 0.4, { type: "sine", vol: 0.14, at: 0.25, slideTo: 880 }); },
  chime() { tone(880, 0.5, { type: "sine", vol: 0.12, slideTo: 990 }); },
};

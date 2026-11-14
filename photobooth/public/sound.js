// Booth sound effects WITHOUT Web Audio.
//
// On iOS, starting the Web Audio engine while the camera is live made Safari ask
// for the microphone — mid-countdown, in front of the kids. Instead, each
// effect is synthesized once into a small WAV (PCM) Blob and played through
// plain <audio> elements, which never need a capture permission.
//
// iOS only lets an <audio> element play programmatically after it has been
// played inside a user gesture, so `unlockSounds()` (called on the first
// pointerdown anywhere) primes every element silently.

const RATE = 22050;

/** tones: [{ f, dur, type, vol, at, slide }] → mono 16-bit WAV Blob. */
export function renderWav(tones) {
  const end = Math.max(...tones.map((t) => (t.at ?? 0) + t.dur)) + 0.02;
  const n = Math.ceil(end * RATE), pcm = new Float32Array(n);
  for (const t of tones) {
    const at = t.at ?? 0, vol = t.vol ?? 0.25, type = t.type ?? "sine";
    const i0 = Math.floor(at * RATE), len = Math.floor(t.dur * RATE);
    let phase = 0;
    for (let i = 0; i < len && i0 + i < n; i++) {
      const k = i / len;
      const f = t.slide ? t.f * Math.pow(t.slide / t.f, k) : t.f;   // exponential slide
      phase += f / RATE;
      const p = phase % 1;
      const w = type === "square" ? (p < 0.5 ? 1 : -1)
        : type === "sawtooth" ? 2 * p - 1
        : type === "triangle" ? 1 - 4 * Math.abs(p - 0.5)
        : Math.sin(2 * Math.PI * p);
      const env = Math.min(1, i / (0.004 * RATE)) * Math.pow(0.001, k);  // click-free attack, exp decay
      pcm[i0 + i] += w * vol * env;
    }
  }
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) buf.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); buf.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, RATE, true); buf.setUint32(28, RATE * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, "data"); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf.buffer], { type: "audio/wav" });
}

const SOUNDS = {
  tick1: [{ f: 770, dur: 0.12, type: "square", vol: 0.12 }],
  tick2: [{ f: 660, dur: 0.12, type: "square", vol: 0.12 }],
  tick3: [{ f: 550, dur: 0.12, type: "square", vol: 0.12 }],
  tickN: [{ f: 440, dur: 0.12, type: "square", vol: 0.12 }],
  snap: [{ f: 1800, dur: 0.04, type: "square", vol: 0.2 }, { f: 700, dur: 0.15, type: "triangle", vol: 0.25, at: 0.03, slide: 200 }],
  tap: [{ f: 600, dur: 0.07, vol: 0.18, slide: 900 }],
  boop: [{ f: 300, dur: 0.12, type: "triangle", vol: 0.2, slide: 520 }],
  whirr: Array.from({ length: 10 }, (_, i) => ({ f: 180 + (i % 2) * 40, dur: 0.12, type: "sawtooth", vol: 0.05, at: i * 0.13 })),
  yay: [523, 659, 784, 1047, 1319].map((f, i) => ({ f, dur: 0.22, type: "triangle", vol: 0.2, at: i * 0.09 })),
  boo: [{ f: 400, dur: 0.5, vol: 0.2, slide: 180 }],
};

const POOL = 2;   // elements per sound, so quick repeats can overlap
const players = {};
let unlocked = false;

function build() {
  if (Object.keys(players).length) return;
  for (const [name, tones] of Object.entries(SOUNDS)) {
    const url = URL.createObjectURL(renderWav(tones));
    players[name] = { i: 0, els: Array.from({ length: POOL }, () => { const a = new Audio(url); a.preload = "auto"; return a; }) };
  }
}

/** Call from inside a user gesture (first pointerdown): primes every element. */
export function unlockSounds() {
  if (unlocked) return;
  unlocked = true;
  build();
  for (const p of Object.values(players)) for (const a of p.els) {
    a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
  }
}

export function play(name) {
  build();
  const p = players[name];
  if (!p) return;
  const a = p.els[p.i++ % p.els.length];
  try { a.currentTime = 0; a.play().catch(() => {}); } catch {}
}

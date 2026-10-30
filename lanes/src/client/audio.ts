// Small synthesized sound effects; no audio files needed.
let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let muted = localStorage.getItem("lanes.muted") === "1";
/** Last time (audio clock) each throttled sound played, so big fights don't turn into noise. */
const lastPlayed = new Map<string, number>();

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    ctx = new AudioContext();
    // A compressor keeps many overlapping hits from clipping.
    const comp = ctx.createDynamicsCompressor();
    const master = ctx.createGain();
    master.gain.value = 0.6;
    comp.connect(master).connect(ctx.destination);
    out = comp;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  localStorage.setItem("lanes.muted", muted ? "1" : "0");
  return muted;
}

/** True if `key` may play now; it then blocks for `gap` seconds. */
function throttle(key: string, gap: number): boolean {
  const a = audio();
  if (!a) return false;
  if (a.currentTime - (lastPlayed.get(key) ?? -Infinity) < gap) return false;
  lastPlayed.set(key, a.currentTime);
  return true;
}

function tone(freq: number, duration: number, volume: number, type: OscillatorType = "sine", delay = 0, slideTo?: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(out!);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function noise(duration: number, volume: number, filterFreq: number, q = 1, delay = 0, type: BiquadFilterType = "bandpass") {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * duration), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buffer;
  const filter = a.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = filterFreq;
  filter.Q.value = q;
  const gain = a.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(out!);
  src.start(t);
}

/** Small random pitch spread so repeated sounds don't sound identical. */
const vary = (freq: number) => freq * (0.92 + Math.random() * 0.16);

export const sfx = {
  melee() {
    if (!throttle("melee", 0.07)) return;
    noise(0.05, 0.35, vary(1800), 1.2);
    tone(vary(160), 0.06, 0.12, "triangle", 0, 90);
  },
  shot() {
    if (!throttle("shot", 0.08)) return;
    tone(vary(900), 0.07, 0.07, "square", 0, 400);
  },
  splash() {
    if (!throttle("splash", 0.12)) return;
    noise(0.22, 0.4, 500, 0.7);
    tone(vary(120), 0.2, 0.15, "sine", 0, 50);
  },
  turret() {
    if (!throttle("turret", 0.1)) return;
    tone(260, 0.1, 0.12, "sawtooth", 0, 130);
  },
  heal() {
    if (!throttle("heal", 0.25)) return;
    tone(vary(880), 0.14, 0.05, "sine", 0, 1320);
  },
  death(mine: boolean) {
    if (!throttle("death", 0.06)) return;
    tone(vary(mine ? 300 : 420), 0.18, 0.1, "triangle", 0, mine ? 90 : 150);
    noise(0.1, 0.2, 900, 0.8);
  },
  /** `hurtMe` is true when the local player's base was hit. */
  breach(hurtMe: boolean) {
    if (!throttle("breach", 0.15)) return;
    noise(0.4, 0.7, 220, 0.6, 0, "lowpass");
    tone(hurtMe ? 90 : 140, 0.35, 0.3, "sine", 0, 40);
  },
  spell(card: string) {
    if (card === "lightning") {
      noise(0.35, 0.8, 3000, 0.5, 0, "highpass");
      tone(1200, 0.25, 0.1, "sawtooth", 0, 80);
    } else if (card === "frost") {
      for (let i = 0; i < 4; i++) tone(1600 + i * 300, 0.25, 0.05, "sine", i * 0.05);
      noise(0.4, 0.2, 5000, 2);
    } else if (card === "mend") {
      [523, 659, 784].forEach((f, i) => tone(f, 0.3, 0.08, "sine", i * 0.07));
    } else {
      // rally and anything new: a short rising horn.
      tone(330, 0.12, 0.12, "sawtooth", 0);
      tone(440, 0.25, 0.12, "sawtooth", 0.1);
    }
  },
  shrine(gained: boolean) {
    if (gained) [587, 880].forEach((f, i) => tone(f, 0.22, 0.12, "triangle", i * 0.1));
    else [440, 330].forEach((f, i) => tone(f, 0.22, 0.1, "triangle", i * 0.1));
  },
  wave() {
    tone(196, 0.3, 0.14, "triangle");
    tone(294, 0.4, 0.12, "triangle", 0.12);
  },
  /** Last seconds before a wave. */
  tick() {
    tone(1000, 0.04, 0.04, "sine");
  },
  place() {
    tone(330, 0.08, 0.14, "triangle", 0, 520);
    noise(0.05, 0.2, 1500, 1);
  },
  invest() {
    tone(1320, 0.08, 0.08, "sine");
    tone(1760, 0.14, 0.08, "sine", 0.06);
  },
  click() {
    tone(700, 0.03, 0.05, "sine");
  },
  error() {
    tone(180, 0.15, 0.1, "square");
  },
  win() {
    [392, 523, 659, 784].forEach((f, i) => tone(f, 0.35, 0.14, "triangle", i * 0.13));
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone(f, 0.45, 0.12, "triangle", i * 0.18));
  },
};

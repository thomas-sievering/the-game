// Small synthesized sound effects; no audio files needed.
let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let muted = localStorage.getItem("lanes.muted") === "1";
/** Last time (in AudioContext seconds) each throttled sound played. */
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

/** A big fight sends many events per tick; plays a sound at most once per `gap` seconds. */
function throttle(key: string, gap: number): boolean {
  const a = audio();
  if (!a) return false;
  const last = lastPlayed.get(key) ?? -Infinity;
  if (a.currentTime - last < gap) return false;
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

function noise(duration: number, volume: number, filterFreq: number, q = 1, type: BiquadFilterType = "bandpass", delay = 0) {
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

/** Slight random detune so repeated sounds don't feel mechanical. */
const vary = (freq: number) => freq * (0.94 + Math.random() * 0.12);

export const sfx = {
  melee() {
    if (!throttle("melee", 0.07)) return;
    noise(0.05, 0.25, vary(1800), 1.2);
    tone(vary(180), 0.06, 0.08, "square", 0, 110);
  },
  shot() {
    if (!throttle("shot", 0.08)) return;
    tone(vary(900), 0.08, 0.05, "triangle", 0, 1400);
  },
  turret() {
    if (!throttle("turret", 0.15)) return;
    tone(vary(260), 0.12, 0.1, "sawtooth", 0, 140);
  },
  blast() {
    if (!throttle("blast", 0.12)) return;
    noise(0.3, 0.45, 400, 0.7, "lowpass");
    tone(120, 0.25, 0.12, "sine", 0, 50);
  },
  heal() {
    if (!throttle("heal", 0.25)) return;
    tone(vary(880), 0.12, 0.04, "sine", 0, 1320);
  },
  /** `mine` is true when one of the local player's units died. */
  death(mine: boolean) {
    if (!throttle("death", 0.1)) return;
    noise(0.12, 0.25, vary(700), 0.9);
    tone(vary(mine ? 320 : 420), 0.14, 0.06, "triangle", 0, mine ? 90 : 150);
  },
  /** `mine` is true when the local player's base was hit. */
  breach(mine: boolean) {
    if (!throttle("breach", 0.12)) return;
    noise(0.45, mine ? 0.7 : 0.4, 220, 0.6, "lowpass");
    tone(mine ? 90 : 140, 0.4, mine ? 0.22 : 0.12, "sine", 0, 40);
  },
  spell(card: string) {
    if (card === "lightning") {
      noise(0.35, 0.6, 3000, 0.5, "highpass");
      tone(1200, 0.2, 0.08, "sawtooth", 0, 200);
    } else if (card === "frost") {
      for (let i = 0; i < 4; i++) tone(1600 + i * 300, 0.25, 0.05, "sine", i * 0.05);
      noise(0.4, 0.15, 5000, 2);
    } else if (card === "mend") {
      tone(523, 0.25, 0.08, "sine");
      tone(659, 0.25, 0.08, "sine", 0.08);
      tone(784, 0.35, 0.08, "sine", 0.16);
    } else if (card === "meteor") {
      tone(1400, 0.35, 0.06, "sine", 0, 200);
      noise(0.6, 0.9, 260, 0.5, "lowpass", 0.3);
      tone(80, 0.5, 0.35, "sine", 0.3, 35);
    } else if (card === "fury") {
      tone(110, 0.4, 0.14, "sawtooth", 0, 220);
      tone(165, 0.4, 0.1, "sawtooth", 0.05, 330);
    } else {
      tone(392, 0.12, 0.1, "square", 0, 520);
      tone(523, 0.18, 0.1, "square", 0.1, 784);
    }
  },
  /** `mine` is true when the local player took the shrine, false when the opponent did. */
  shrine(mine: boolean) {
    if (mine) {
      tone(587, 0.15, 0.1, "triangle");
      tone(880, 0.3, 0.1, "triangle", 0.1);
    } else {
      tone(440, 0.15, 0.1, "triangle");
      tone(330, 0.3, 0.1, "triangle", 0.1);
    }
  },
  wave() {
    tone(196, 0.18, 0.1, "sawtooth");
    tone(294, 0.25, 0.1, "sawtooth", 0.12);
  },
  /** Last seconds before a wave. */
  tick() {
    tone(1000, 0.04, 0.04, "sine");
  },
  place() {
    tone(330, 0.07, 0.12, "square", 0, 220);
    noise(0.06, 0.2, 900, 1);
  },
  sell() {
    tone(1047, 0.08, 0.08, "square");
    tone(1319, 0.14, 0.08, "square", 0.07);
  },
  /** A unit on the grid went up a level; higher levels ring higher. */
  levelUp(level: number) {
    const base = level >= 3 ? 660 : 523;
    [base, base * 1.25, base * 1.5].forEach((f, i) => tone(f, 0.18, 0.1, "triangle", i * 0.06));
  },
  invest() {
    tone(784, 0.08, 0.08, "triangle");
    tone(1175, 0.16, 0.08, "triangle", 0.06);
  },
  select() {
    tone(660, 0.04, 0.05, "sine");
  },
  error() {
    tone(180, 0.15, 0.1, "square", 0, 140);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 0.12, "triangle", i * 0.12));
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone(f, 0.4, 0.12, "triangle", i * 0.18));
  },
};

// Synthesized engine, effects and one music loop per track; no audio files needed.
import type { TrackId } from "../shared/tracks";

let ctx: AudioContext | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let muted = localStorage.getItem("racer.muted") === "1";
let musicVolume = Number(localStorage.getItem("racer.music") ?? "0.5");
if (!(musicVolume >= 0 && musicVolume <= 1)) musicVolume = 0.5;

function context(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = muted ? 0 : 1;
    sfxBus.connect(comp);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 5200;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicLevel();
    musicBus.connect(filter).connect(comp);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function audio(): AudioContext | null {
  return muted ? null : context();
}

/** Music level after the mute toggle; the bus peaks below the effects. */
function musicLevel(): number {
  return muted ? 0 : musicVolume * musicVolume * 0.45;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  localStorage.setItem("racer.muted", muted ? "1" : "0");
  if (ctx && sfxBus && musicBus) {
    sfxBus.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.1);
  }
  return muted;
}

export function getMusicVolume(): number {
  return musicVolume;
}

export function setMusicVolume(volume: number): void {
  musicVolume = Math.min(1, Math.max(0, volume));
  localStorage.setItem("racer.music", String(musicVolume));
  if (ctx && musicBus) musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.1);
}

/** Call from a user gesture so the browser allows audio. */
export function unlockAudio(): void {
  context();
  if (!musicTimer) {
    stepTime = ctx!.currentTime + 0.1;
    musicTimer = window.setInterval(scheduleMusic, 50);
  }
}

// ---------------------------------------------------------------- effects

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
  osc.connect(gain).connect(sfxBus!);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;
function noiseSource(a: AudioContext): AudioBufferSourceNode {
  if (!noiseBuffer) {
    noiseBuffer = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

function noise(duration: number, volume: number, filterFreq: number, q = 1, type: BiquadFilterType = "bandpass", delay = 0, out?: AudioNode) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const src = noiseSource(a);
  const filter = a.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = filterFreq;
  filter.Q.value = q;
  const gain = a.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter).connect(gain).connect(out ?? sfxBus!);
  src.start(t, Math.random());
  src.stop(t + duration + 0.02);
}

export const sfx = {
  /** Countdown light: n = 3, 2, 1, then 0 for go. */
  light(n: number) {
    if (n > 0) tone(440, 0.22, 0.25, "square");
    else {
      tone(880, 0.6, 0.25, "square");
      tone(1320, 0.6, 0.1, "sine");
    }
  },
  lap(best: boolean) {
    tone(784, 0.12, 0.18, "triangle");
    tone(1047, 0.2, 0.18, "triangle", 0.1);
    if (best) tone(1319, 0.3, 0.16, "triangle", 0.2);
  },
  finalLap() {
    for (const [i, f] of [523, 659, 784, 1047, 784, 1047].entries()) tone(f, 0.14, 0.16, "square", i * 0.09);
  },
  finish(place: number) {
    const notes = place === 1 ? [523, 659, 784, 1047, 1319, 1568] : [523, 659, 784, 1047];
    for (const [i, f] of notes.entries()) tone(f, 0.35, 0.16, "triangle", i * 0.11);
    if (place === 1) for (const [i, f] of [262, 330, 392].entries()) tone(f, 0.9, 0.08, "sawtooth", 0.55 + i * 0.01);
  },
  bump(strength: number) {
    const v = Math.min(0.6, strength / 600);
    noise(0.18, v, 180, 0.7, "lowpass");
    tone(90, 0.15, v * 0.6, "sine", 0, 50);
    if (strength > 250) noise(0.08, v * 0.4, 2400, 2);
  },
  boost() {
    noise(0.5, 0.25, 800, 0.8, "bandpass");
    tone(220, 0.45, 0.12, "sawtooth", 0, 880);
  },
  click() {
    tone(1200, 0.04, 0.06, "square");
  },
  error() {
    tone(160, 0.12, 0.12, "square");
  },
};

// ---------------------------------------------------------------- engine

interface Engine {
  osc: OscillatorNode;
  sub: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  skid: GainNode;
  rumble: GainNode;
}
let engine: Engine | null = null;

/** Starts (or keeps) the engine loop. */
export function startEngine(): void {
  const a = audio();
  if (!a || engine) return;
  const osc = a.createOscillator();
  osc.type = "sawtooth";
  const sub = a.createOscillator();
  sub.type = "square";
  const filter = a.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 4;
  const gain = a.createGain();
  gain.gain.value = 0;
  osc.connect(filter);
  sub.connect(filter);
  filter.connect(gain).connect(sfxBus!);
  osc.start();
  sub.start();

  const skidSrc = noiseSource(a);
  skidSrc.loop = true;
  const skidFilter = a.createBiquadFilter();
  skidFilter.type = "bandpass";
  skidFilter.frequency.value = 1500;
  skidFilter.Q.value = 3;
  const skid = a.createGain();
  skid.gain.value = 0;
  skidSrc.connect(skidFilter).connect(skid).connect(sfxBus!);
  skidSrc.start();

  const rumbleSrc = noiseSource(a);
  rumbleSrc.loop = true;
  const rumbleFilter = a.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 260;
  const rumble = a.createGain();
  rumble.gain.value = 0;
  rumbleSrc.connect(rumbleFilter).connect(rumble).connect(sfxBus!);
  rumbleSrc.start();
  engine = { osc, sub, filter, gain, skid, rumble };
}

export function stopEngine(): void {
  if (!engine || !ctx) return;
  const e = engine;
  engine = null;
  const t = ctx.currentTime;
  for (const g of [e.gain, e.skid, e.rumble]) g.gain.setTargetAtTime(0, t, 0.05);
  setTimeout(() => {
    e.osc.stop();
    e.sub.stop();
    e.gain.disconnect();
    e.skid.disconnect();
    e.rumble.disconnect();
  }, 400);
}

/** speed 0..1+, throttle on/off, slip 0..1, offroad, boost. */
export function updateEngine(speed: number, throttle: boolean, slip: number, offroad: boolean, boost: boolean): void {
  if (!engine || !ctx) return;
  const t = ctx.currentTime;
  // A fake gearbox: pitch climbs through each gear, then drops when it shifts up.
  const gears = 4;
  const g = Math.min(gears - 1, Math.floor(speed * gears));
  const inGear = speed * gears - g;
  const rpm = 0.25 + inGear * 0.75 * (0.7 + g * 0.1);
  const freq = 38 + rpm * 90 + g * 6 + (boost ? 18 : 0);
  engine.osc.frequency.setTargetAtTime(freq, t, 0.03);
  engine.sub.frequency.setTargetAtTime(freq / 2, t, 0.03);
  engine.filter.frequency.setTargetAtTime(300 + rpm * 1400 + (throttle ? 600 : 0), t, 0.05);
  engine.gain.gain.setTargetAtTime(0.05 + (throttle ? 0.05 : 0) + speed * 0.03, t, 0.05);
  engine.skid.gain.setTargetAtTime(offroad ? 0 : Math.min(0.12, slip * 0.14), t, 0.04);
  engine.rumble.gain.setTargetAtTime(offroad ? 0.08 + speed * 0.3 : 0, t, 0.05);
}

// ---------------------------------------------------------------- music

interface Song {
  bpm: number;
  /** Bass root per bar (MIDI), and the chord tones played above it. */
  bars: { root: number; chord: number[] }[];
  /** 16 steps; "k" kick, "s" snare, "h" hat, "t" tom, "x" kick + hat, combined freely. */
  drums: string[];
  /** Bass rhythm: step -> octave offset (0 root, 12 octave, 7 fifth). */
  bass: Record<number, number>;
  bassWave: OscillatorType;
  /** Arpeggio steps and wave. */
  arp: number[];
  arpWave: OscillatorType;
  arpVolume: number;
  /** Scale for the lead's random walk. */
  scale: number[];
  leadWave: OscillatorType;
  leadChance: number;
  pad: boolean;
}

const SONGS: Record<TrackId, Song> = {
  // Bright, bouncy major-key pop at 140 bpm.
  meadow: {
    bpm: 140,
    bars: [
      { root: 38, chord: [62, 66, 69] }, // D
      { root: 45, chord: [61, 64, 69] }, // A
      { root: 47, chord: [62, 66, 71] }, // Bm
      { root: 43, chord: [62, 67, 71] }, // G
    ],
    drums: ["k", "", "h", "", "s", "", "h", "k", "k", "", "h", "", "s", "", "h", "h"],
    bass: { 0: 0, 2: 12, 4: 0, 6: 12, 8: 0, 10: 12, 12: 0, 14: 7 },
    bassWave: "triangle",
    arp: [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 0, 2, 1, 2],
    arpWave: "square",
    arpVolume: 0.025,
    scale: [74, 76, 78, 81, 83, 86, 88],
    leadWave: "triangle",
    leadChance: 0.45,
    pad: false,
  },
  // Twangy desert surf in E Phrygian dominant at 112 bpm, with toms.
  canyon: {
    bpm: 112,
    bars: [
      { root: 40, chord: [64, 68, 71] }, // E
      { root: 41, chord: [65, 69, 72] }, // F
      { root: 40, chord: [64, 68, 71] }, // E
      { root: 38, chord: [62, 65, 69] }, // Dm
    ],
    drums: ["k", "", "h", "t", "s", "", "h", "", "k", "t", "h", "", "s", "", "t", "t"],
    bass: { 0: 0, 3: 0, 6: 7, 8: 0, 11: 12, 14: 7 },
    bassWave: "sawtooth",
    arp: [0, 2, 1, 2, 0, 2, 1, 2, 0, 2, 1, 2, 2, 1, 0, 1],
    arpWave: "sawtooth",
    arpVolume: 0.03,
    scale: [64, 65, 68, 69, 71, 72, 74, 76],
    leadWave: "sawtooth",
    leadChance: 0.3,
    pad: false,
  },
  // Moody synthwave in A minor at 100 bpm: wide pads, pulsing octave bass, gated arp.
  neon: {
    bpm: 100,
    bars: [
      { root: 45, chord: [57, 60, 64, 69] }, // Am
      { root: 41, chord: [57, 60, 65, 69] }, // F
      { root: 36, chord: [55, 60, 64, 67] }, // C
      { root: 43, chord: [55, 59, 62, 67] }, // G
    ],
    drums: ["x", "", "h", "", "s", "", "h", "", "x", "", "h", "k", "s", "", "h", "h"],
    bass: { 0: 0, 1: 12, 2: 0, 3: 12, 4: 0, 5: 12, 6: 0, 7: 12, 8: 0, 9: 12, 10: 0, 11: 12, 12: 0, 13: 12, 14: 0, 15: 12 },
    bassWave: "sawtooth",
    arp: [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 3, 2, 1],
    arpWave: "square",
    arpVolume: 0.022,
    scale: [69, 72, 74, 76, 79, 81, 84],
    leadWave: "sawtooth",
    leadChance: 0.25,
    pad: true,
  },
};

const LOOKAHEAD = 0.25;
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
let song: TrackId | null = null;
let musicTimer = 0;
let nextStep = 0;
let stepTime = 0;
let leadIndex = 3;

/** Picks the loop that plays; null for silence. */
export function playSong(id: TrackId | null): void {
  if (song === id) return;
  song = id;
  nextStep = 0;
  if (ctx) stepTime = ctx.currentTime + 0.1;
}

function scheduleMusic() {
  if (!ctx || !musicBus || !song) return;
  const s = SONGS[song];
  const step = 60 / s.bpm / 4;
  // Skip ahead after a throttled background tab instead of playing a burst of late notes.
  if (stepTime < ctx.currentTime) stepTime = ctx.currentTime + 0.05;
  while (stepTime < ctx.currentTime + LOOKAHEAD) {
    if (musicLevel() > 0) playStep(s, nextStep, stepTime, step);
    nextStep = (nextStep + 1) % (s.bars.length * 16);
    stepTime += step;
  }
}

function playStep(s: Song, i: number, t: number, step: number) {
  const bar = s.bars[Math.floor(i / 16)];
  const beat = i % 16;
  const drum = s.drums[beat];
  if (drum.includes("k") || drum.includes("x")) kick(t);
  if (drum.includes("s")) snare(t);
  if (drum.includes("h") || drum.includes("x")) hat(t, beat % 4 === 2 ? 0.05 : 0.03);
  if (drum.includes("t")) tom(t, beat > 12 ? 110 : 150);
  if (beat in s.bass) note(midi(bar.root + s.bass[beat]), t, step * 1.6, 0.13, s.bassWave, 0.005, 600);
  const arp = bar.chord[s.arp[beat] % bar.chord.length];
  note(midi(arp + 12), t, step * 0.9, s.arpVolume, s.arpWave, 0.003, 3000);
  if (s.pad && beat === 0) for (const n of bar.chord) note(midi(n), t, step * 16, 0.035, "sawtooth", 0.4, 1400, 6);
  if (!s.pad && beat === 0) for (const n of bar.chord) note(midi(n), t, step * 6, 0.025, "triangle", 0.02);
  // The lead wanders the scale on eighths and leans on chord tones at the start of a bar.
  if (beat % 2 === 0 && Math.random() < s.leadChance) {
    leadIndex = Math.min(s.scale.length - 1, Math.max(0, leadIndex + Math.floor(Math.random() * 5) - 2));
    let n = s.scale[leadIndex];
    if (beat === 0) n = bar.chord[bar.chord.length - 1] + 12;
    note(midi(n), t, step * (Math.random() < 0.3 ? 4 : 2), 0.045, s.leadWave, 0.01, 2600, 4);
  }
}

function note(freq: number, t: number, duration: number, volume: number, type: OscillatorType, attack: number, cutoff = 8000, detune = 0) {
  const a = ctx!;
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  const filter = a.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  filter.connect(gain).connect(musicBus!);
  for (const d of detune ? [-detune, detune] : [0]) {
    const osc = a.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = d;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }
}

function kick(t: number) {
  const a = ctx!;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  gain.gain.setValueAtTime(0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc.connect(gain).connect(musicBus!);
  osc.start(t);
  osc.stop(t + 0.32);
}

function snare(t: number) {
  const a = ctx!;
  const src = noiseSource(a);
  const filter = a.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1500;
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.22, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  src.connect(filter).connect(gain).connect(musicBus!);
  src.start(t, Math.random());
  src.stop(t + 0.2);
  const body = a.createOscillator();
  const bg = a.createGain();
  body.frequency.setValueAtTime(200, t);
  body.frequency.exponentialRampToValueAtTime(120, t + 0.08);
  bg.gain.setValueAtTime(0.15, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  body.connect(bg).connect(musicBus!);
  body.start(t);
  body.stop(t + 0.12);
}

function hat(t: number, volume: number) {
  const a = ctx!;
  const src = noiseSource(a);
  const filter = a.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 7000;
  const gain = a.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  src.connect(filter).connect(gain).connect(musicBus!);
  src.start(t, Math.random());
  src.stop(t + 0.06);
}

function tom(t: number, freq: number) {
  const a = ctx!;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.25);
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc.connect(gain).connect(musicBus!);
  osc.start(t);
  osc.stop(t + 0.32);
}

// Small synthesized sound effects and background music; no audio files needed.
let ctx: AudioContext | null = null;
let musicBus: GainNode | null = null;
let muted = localStorage.getItem("golf.muted") === "1";
let musicVolume = Number(localStorage.getItem("golf.music") ?? "0.5");
if (!(musicVolume >= 0 && musicVolume <= 1)) musicVolume = 0.5;

function context(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function audio(): AudioContext | null {
  return muted ? null : context();
}

/** Music level after the mute toggle; the bus peaks well below the sound effects. */
function musicLevel(): number {
  return muted ? 0 : musicVolume * musicVolume * 0.35;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  localStorage.setItem("golf.muted", muted ? "1" : "0");
  applyMusicLevel();
  return muted;
}

export function getMusicVolume(): number {
  return musicVolume;
}

export function setMusicVolume(volume: number): void {
  musicVolume = Math.min(1, Math.max(0, volume));
  localStorage.setItem("golf.music", String(musicVolume));
  applyMusicLevel();
}

function applyMusicLevel() {
  if (!ctx || !musicBus) return;
  musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.1);
}

// Background music: a slow, soft loop of pad chords, a bass line and a wandering pentatonic melody,
// scheduled a little ahead of time on the audio clock.
const BEAT = 60 / 80 / 2; // eighth notes at 80 bpm
const LOOKAHEAD = 0.3;
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
// Cmaj7, Am7, Fmaj7, G6: one bar (8 eighths) each.
const CHORDS = [
  [48, 60, 64, 67, 71],
  [45, 57, 60, 64, 67],
  [41, 57, 60, 64, 69],
  [43, 59, 62, 64, 67],
];
const MELODY = [67, 69, 72, 74, 76, 79, 81];
let musicStarted = false;
let nextStep = 0;
let stepTime = 0;
let melodyIndex = 3;

/** Starts the music loop; call from a user gesture so the browser allows audio. */
export function startMusic(): void {
  if (musicStarted) return;
  musicStarted = true;
  const a = context();
  const filter = a.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2200;
  musicBus = a.createGain();
  musicBus.gain.value = musicLevel();
  musicBus.connect(filter).connect(a.destination);
  stepTime = a.currentTime + 0.1;
  setInterval(scheduleMusic, 100);
}

function scheduleMusic() {
  if (!ctx || !musicBus) return;
  // Skip ahead after a throttled background tab instead of playing a burst of late notes.
  if (stepTime < ctx.currentTime) stepTime = ctx.currentTime + 0.05;
  while (stepTime < ctx.currentTime + LOOKAHEAD) {
    if (musicLevel() > 0) playStep(nextStep, stepTime);
    nextStep = (nextStep + 1) % (CHORDS.length * 8);
    stepTime += BEAT;
  }
}

function playStep(step: number, t: number) {
  const chord = CHORDS[Math.floor(step / 8)];
  const beat = step % 8;
  if (beat === 0) {
    for (const n of chord.slice(1)) note(midi(n), t, BEAT * 8, 0.05, "triangle", 0.6);
  }
  if (beat === 0 || beat === 4) note(midi(chord[0]), t, BEAT * 3, 0.22, "sine", 0.02);
  if (beat === 6) note(midi(chord[0] + 7), t, BEAT * 1.5, 0.12, "sine", 0.02);
  // The melody plays on most eighths, stepping around the scale and leaning on chord tones.
  if (Math.random() < (beat % 2 === 0 ? 0.75 : 0.3)) {
    melodyIndex = Math.min(MELODY.length - 1, Math.max(0, melodyIndex + Math.floor(Math.random() * 5) - 2));
    let n = MELODY[melodyIndex];
    if (beat === 0 && !chord.some((c) => (c - n) % 12 === 0)) n = chord[2] + 12;
    note(midi(n), t, BEAT * 1.8, 0.07, "triangle", 0.01);
  }
}

function note(freq: number, t: number, duration: number, volume: number, type: OscillatorType, attack: number) {
  const a = ctx!;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(musicBus!);
  osc.start(t);
  osc.stop(t + duration + 0.05);
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
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function noise(duration: number, volume: number, filterFreq: number, q = 1) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * duration), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buffer;
  const filter = a.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = filterFreq;
  filter.Q.value = q;
  const gain = a.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(a.destination);
  src.start(t);
}

export const sfx = {
  hit(power: number) {
    noise(0.06, 0.5 + power * 0.5, 2400, 0.8);
    tone(220 + power * 120, 0.08, 0.25, "triangle");
  },
  wall(speed: number) {
    const v = Math.min(1, speed / 600);
    tone(520 + v * 200, 0.05, 0.05 + v * 0.18, "square", 0, 380);
  },
  ball(speed: number) {
    const v = Math.min(1, speed / 600);
    tone(1500, 0.04, 0.08 + v * 0.25, "sine", 0, 900);
  },
  cup() {
    tone(392, 0.18, 0.2, "triangle");
    tone(523, 0.18, 0.2, "triangle", 0.1);
    tone(784, 0.35, 0.18, "triangle", 0.2);
  },
  bumper(speed: number) {
    const v = Math.min(1, speed / 700);
    tone(260 + v * 120, 0.16, 0.16 + v * 0.1, "sine", 0, 640 + v * 260);
    tone(980, 0.05, 0.06, "triangle");
  },
  mover(speed: number) {
    const v = Math.min(1, speed / 600);
    tone(180 + v * 60, 0.09, 0.08 + v * 0.2, "triangle", 0, 110);
    noise(0.04, 0.1 + v * 0.25, 900, 1.2);
  },
  splash() {
    noise(0.45, 0.6, 700, 0.6);
    tone(300, 0.25, 0.08, "sine", 0, 120);
  },
  yourTurn() {
    tone(660, 0.1, 0.12, "sine");
    tone(880, 0.14, 0.12, "sine", 0.09);
  },
};

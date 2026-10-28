// Small synthesized sound effects; no audio files needed.
let ctx: AudioContext | null = null;
let muted = localStorage.getItem("golf.muted") === "1";

function audio(): AudioContext | null {
  if (muted) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  localStorage.setItem("golf.muted", muted ? "1" : "0");
  return muted;
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
  splash() {
    noise(0.45, 0.6, 700, 0.6);
    tone(300, 0.25, 0.08, "sine", 0, 120);
  },
  yourTurn() {
    tone(660, 0.1, 0.12, "sine");
    tone(880, 0.14, 0.12, "sine", 0.09);
  },
};

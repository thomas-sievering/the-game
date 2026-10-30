// Small synthesized sound effects; no audio files needed.
let ctx: AudioContext | null = null;
let muted = localStorage.getItem("farm.muted") === "1";

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
  localStorage.setItem("farm.muted", muted ? "1" : "0");
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
  harvest() {
    tone(520, 0.08, 0.15, "triangle", 0, 780);
  },
  sell(count: number) {
    for (let i = 0; i < Math.min(4, count); i++) tone(1320, 0.07, 0.1, "square", i * 0.05, 1760);
  },
  buy() {
    noise(0.12, 0.4, 300, 0.8);
    tone(180, 0.12, 0.15, "triangle");
  },
  buyout() {
    tone(330, 0.14, 0.18, "sawtooth", 0, 220);
    tone(247, 0.2, 0.15, "sawtooth", 0.12, 165);
  },
  contract() {
    tone(523, 0.12, 0.18, "triangle");
    tone(659, 0.12, 0.18, "triangle", 0.09);
    tone(784, 0.25, 0.16, "triangle", 0.18);
  },
  crows() {
    for (let i = 0; i < 3; i++) {
      noise(0.12, 0.35, 1400, 3);
      tone(700, 0.12, 0.08, "sawtooth", i * 0.18, 450);
    }
  },
  weeds() {
    noise(0.3, 0.3, 500, 0.5);
  },
  dump() {
    tone(440, 0.4, 0.15, "square", 0, 110);
  },
  research() {
    for (const [i, freq] of [392, 494, 587, 784].entries()) tone(freq, 0.18, 0.12, "sine", i * 0.07);
  },
  error() {
    tone(160, 0.12, 0.12, "square");
  },
};

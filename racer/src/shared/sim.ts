// Deterministic race simulation shared by the server and the client. The client runs `stepCar` for its
// own car to predict input instantly, so it must give bit-identical results on both sides: use only
// + - * /, Math.sqrt, Math.min/max/floor and stable iteration order (no trig, Math.hypot or Math.pow).
import { type Track, TRACKS, type TrackId, segmentDistance } from "./tracks";

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const MAX_CARS = 8;
export const COUNTDOWN_TICKS = 3 * TICK_RATE;
/** After the first car finishes, the rest have this long to cross the line. */
export const FINISH_GRACE_TICKS = 30 * TICK_RATE;
/** A race ends anyway after this long per lap. */
export const LAP_LIMIT_TICKS = 150 * TICK_RATE;
export const LAP_OPTIONS = [1, 2, 3, 5];
/** Bots are named after their car colour's slot. */
export const BOT_NAMES = ["Turbo", "Nitro", "Drift", "Piston", "Sprocket", "Comet", "Blitz", "Rusty"];

export const KEY = { up: 1, down: 2, left: 4, right: 8 } as const;

export const CAR = {
  radius: 13,
  length: 36,
  width: 19,
  maxSpeed: 560,
  offroadMaxSpeed: 230,
  accel: 520,
  brake: 1000,
  reverseMax: 160,
  reverseAccel: 300,
  /** Speed kept per tick while coasting. */
  coast: 0.992,
  /** Speed lost per second when coasting, on top of `coast`. */
  rolling: 60,
  /** Lateral (sideways) speed kept per tick: lower grips harder. */
  grip: 0.8,
  offroadGrip: 0.9,
  /** Turn rate in radians per second at low speed; falls off a little at top speed. */
  steer: 3.1,
  boostTicks: 40,
  boostSpeed: 1.35,
  boostKick: 140,
  /** Share of the normal speed kept when hitting something. */
  bounce: 0.35,
};

export type CarStatus = "racing" | "finished" | "retired";

export interface Car {
  id: string;
  name: string;
  color: number;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Heading as a unit vector. */
  hx: number;
  hy: number;
  /** Nearest centre-line point, kept up to date by `stepCar`. */
  seg: number;
  /** Ticks of boost left. */
  boost: number;
  offroad: boolean;
  /** Last input applied, for brake lights and engine sound. */
  input: number;
  /** Checkpoints passed in total; a lap is one full set. */
  cp: number;
  lapStart: number;
  lastLap: number;
  bestLap: number;
  status: CarStatus;
  finishTick: number;
  /** Away players' cars don't collide and don't block the race from ending. */
  ghost: boolean;
}

export type RaceEvent =
  | { type: "lap"; car: string; lap: number; ticks: number; best: boolean }
  | { type: "finish"; car: string; place: number; ticks: number }
  | { type: "bump"; car: string; x: number; y: number; strength: number }
  | { type: "boost"; car: string };

export interface Race {
  track: Track;
  laps: number;
  tick: number;
  /** Tick at which the lights go green. */
  startTick: number;
  /** Tick at which the race is called after the first finish; 0 until someone finishes. */
  endTick: number;
  cars: Car[];
  over: boolean;
  events: RaceEvent[];
}

export interface Entrant {
  id: string;
  name: string;
  color: number;
  bot: boolean;
}

export function createRace(trackId: TrackId, laps: number, entrants: Entrant[]): Race {
  const track = TRACKS[trackId];
  const cars = entrants.slice(0, MAX_CARS).map((e, i): Car => {
    const slot = track.grid[i];
    return {
      ...e,
      x: slot.x,
      y: slot.y,
      vx: 0,
      vy: 0,
      hx: slot.hx,
      hy: slot.hy,
      seg: nearestSeg(track, slot.x, slot.y, -1),
      boost: 0,
      offroad: false,
      input: 0,
      cp: 0,
      lapStart: COUNTDOWN_TICKS,
      lastLap: 0,
      bestLap: 0,
      status: "racing",
      finishTick: 0,
      ghost: false,
    };
  });
  return { track, laps, tick: 0, startTick: COUNTDOWN_TICKS, endTick: 0, cars, over: false, events: [] };
}

/** Nearest centre-line point to (x, y), searching near `hint` first (or everywhere when hint < 0). */
export function nearestSeg(track: Track, x: number, y: number, hint: number): number {
  const n = track.path.length;
  const p = { x, y };
  let best = -1;
  let bestD = Infinity;
  if (hint >= 0) {
    for (let k = -24; k <= 24; k++) {
      const i = (hint + k + n) % n;
      const d = segmentDistance(p, track.path[i], track.path[(i + 1) % n]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < track.half * 3) return best;
  }
  for (let i = 0; i < n; i++) {
    const d = segmentDistance(p, track.path[i], track.path[(i + 1) % n]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** How far the car is from the centre line. */
export function offCentre(track: Track, car: Pick<Car, "x" | "y" | "seg">): number {
  const n = track.path.length;
  return segmentDistance(car, track.path[car.seg], track.path[(car.seg + 1) % n]);
}

export interface StepResult {
  /** Speed into whatever the car hit, or 0. */
  hit: number;
  /** Drove onto a boost pad this tick. */
  boosted: boolean;
}

/** One tick of driving physics for one car: input, grip, obstacles and walls. No other cars. */
export function stepCar(track: Track, car: Car, input: number, frozen: boolean): StepResult {
  car.input = input;
  const result: StepResult = { hit: 0, boosted: false };
  if (frozen) {
    car.vx = 0;
    car.vy = 0;
    return result;
  }
  const up = (input & KEY.up) !== 0;
  const down = (input & KEY.down) !== 0;
  const steer = ((input & KEY.right) !== 0 ? 1 : 0) - ((input & KEY.left) !== 0 ? 1 : 0);

  // Split velocity into forward and sideways parts.
  const nx = -car.hy;
  const ny = car.hx;
  let f = car.vx * car.hx + car.vy * car.hy;
  let l = car.vx * nx + car.vy * ny;

  const boosting = car.boost > 0;
  const top = (car.offroad ? CAR.offroadMaxSpeed : CAR.maxSpeed) * (boosting ? CAR.boostSpeed : 1);
  if (up) {
    if (f < 0) f += CAR.brake * DT;
    else if (f < top) f += CAR.accel * DT * (1 - f / top) * (boosting ? 2 : 1) + (f < 40 ? 6 : 0);
  } else if (down) {
    if (f > 0) f = Math.max(0, f - CAR.brake * DT);
    else f = Math.max(-CAR.reverseMax, f - CAR.reverseAccel * DT);
  }
  f *= CAR.coast;
  // Running off the road scrubs speed quickly down to its lower top speed.
  if (f > top) f = top + (f - top) * (car.offroad ? 0.9 : 0.97);
  // Rolling resistance brings a coasting car to rest.
  if (!up && !down) f = f > 0 ? Math.max(0, f - CAR.rolling * DT) : Math.min(0, f + CAR.rolling * DT);
  l *= car.offroad ? CAR.offroadGrip : CAR.grip;
  // Settle fully so a parked car stops changing (and stops being re-sent).
  if (l > -0.5 && l < 0.5) l = 0;

  // Steering grows with speed up to a walking pace and eases off near top speed; reversing turns the other way.
  const speed = f < 0 ? -f : f;
  const rate = CAR.steer * Math.min(1, speed / 110) * (1 - (0.3 * Math.min(speed, CAR.maxSpeed)) / CAR.maxSpeed);
  const a = steer * rate * DT * (f < 0 ? -1 : 1);
  if (a !== 0) {
    const hx = car.hx - a * car.hy;
    const hy = car.hy + a * car.hx;
    const len = Math.sqrt(hx * hx + hy * hy);
    car.hx = hx / len;
    car.hy = hy / len;
  }
  car.vx = car.hx * f + -car.hy * l;
  car.vy = car.hy * f + car.hx * l;
  car.x += car.vx * DT;
  car.y += car.vy * DT;
  if (car.boost > 0) car.boost--;

  result.hit = collideWorld(track, car);
  car.seg = nearestSeg(track, car.x, car.y, car.seg);
  car.offroad = offCentre(track, car) > track.half + 8;
  for (const pad of track.boosts) {
    const n = track.path.length;
    const gap = Math.min((car.seg - pad.seg + n) % n, (pad.seg - car.seg + n) % n);
    if (gap > 2) continue;
    const side = (car.x - pad.x) * -pad.dy + (car.y - pad.y) * pad.dx;
    if (side > -34 && side < 34) {
      if (car.boost < CAR.boostTicks - 5) {
        const kick = CAR.boostKick;
        car.vx += car.hx * kick;
        car.vy += car.hy * kick;
        result.boosted = true;
      }
      car.boost = CAR.boostTicks;
    }
  }
  return result;
}

/** Speed lost on impact; returns the normal speed so callers can report bumps. */
function bounceOff(car: Car, nx: number, ny: number): number {
  const vn = car.vx * nx + car.vy * ny;
  if (vn >= 0) return 0;
  car.vx -= (1 + CAR.bounce) * vn * nx;
  car.vy -= (1 + CAR.bounce) * vn * ny;
  car.vx *= 0.9;
  car.vy *= 0.9;
  return -vn;
}

/** Pushes the car out of obstacles and the world edge, bouncing it off. */
export function collideWorld(track: Track, car: Car): number {
  const r = CAR.radius;
  let hit = 0;
  for (const c of track.circles) {
    const dx = car.x - c.x;
    const dy = car.y - c.y;
    const min = c.r + r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 1;
    const nx = dx / d;
    const ny = dy / d;
    car.x = c.x + nx * min;
    car.y = c.y + ny * min;
    hit = Math.max(hit, bounceOff(car, nx, ny));
  }
  for (const b of track.rects) {
    const px = Math.max(b.x, Math.min(car.x, b.x + b.w));
    const py = Math.max(b.y, Math.min(car.y, b.y + b.h));
    const dx = car.x - px;
    const dy = car.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    let nx: number;
    let ny: number;
    if (d2 === 0) {
      // The centre is inside the block: leave by the nearest side.
      const left = car.x - b.x;
      const right = b.x + b.w - car.x;
      const top = car.y - b.y;
      const bottom = b.y + b.h - car.y;
      const m = Math.min(left, right, top, bottom);
      nx = m === left ? -1 : m === right ? 1 : 0;
      ny = m === top ? -1 : m === bottom ? 1 : 0;
      car.x = nx < 0 ? b.x - r : nx > 0 ? b.x + b.w + r : car.x;
      car.y = ny < 0 ? b.y - r : ny > 0 ? b.y + b.h + r : car.y;
    } else {
      const d = Math.sqrt(d2);
      nx = dx / d;
      ny = dy / d;
      car.x = px + nx * r;
      car.y = py + ny * r;
    }
    hit = Math.max(hit, bounceOff(car, nx, ny));
  }
  if (car.x < r) {
    car.x = r;
    hit = Math.max(hit, bounceOff(car, 1, 0));
  }
  if (car.y < r) {
    car.y = r;
    hit = Math.max(hit, bounceOff(car, 0, 1));
  }
  if (car.x > track.width - r) {
    car.x = track.width - r;
    hit = Math.max(hit, bounceOff(car, -1, 0));
  }
  if (car.y > track.height - r) {
    car.y = track.height - r;
    hit = Math.max(hit, bounceOff(car, 0, -1));
  }
  return hit;
}

/** Cars bump each other like equal-mass discs. */
export function collideCars(race: Race): void {
  const cars = race.cars.filter((c) => !c.ghost && c.status !== "retired");
  const min = CAR.radius * 2;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1;
      const nx = d2 === 0 ? 1 : dx / d;
      const ny = d2 === 0 ? 0 : dy / d;
      const push = (min - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel >= 0) continue;
      const impulse = (-(1 + 0.5) * rel) / 2;
      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
      if (-rel > 60) race.events.push({ type: "bump", car: a.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, strength: -rel });
    }
  }
}

/** Index of the checkpoint the car must pass next. */
function nextCheckpoint(race: Race, car: Car): number {
  return race.track.checkpoints[(car.cp + 1) % race.track.checkpoints.length];
}

/** Moves the car's checkpoint count on when it reaches the next checkpoint in order. */
function updateProgress(race: Race, car: Car): void {
  const track = race.track;
  const n = track.path.length;
  const target = nextCheckpoint(race, car);
  const ahead = (car.seg - target + n) % n;
  // Reached when just past the checkpoint, but not from far ahead (which means driving backwards).
  if (ahead > n / track.checkpoints.length / 2) return;
  car.cp++;
  if (car.cp % track.checkpoints.length !== 0) return;
  const lap = car.cp / track.checkpoints.length;
  const ticks = race.tick - car.lapStart;
  const best = car.bestLap === 0 || ticks < car.bestLap;
  car.lastLap = ticks;
  if (best) car.bestLap = ticks;
  car.lapStart = race.tick;
  race.events.push({ type: "lap", car: car.id, lap, ticks, best });
  if (lap >= race.laps) {
    car.status = "finished";
    car.finishTick = race.tick;
    const place = race.cars.filter((c) => c.status === "finished").length;
    race.events.push({ type: "finish", car: car.id, place, ticks: race.tick - race.startTick });
    if (race.endTick === 0) race.endTick = race.tick + FINISH_GRACE_TICKS;
  }
}

/** Race distance covered, for the standings: checkpoints passed plus the way to the next one. */
export function progress(race: Race, car: Car): number {
  const track = race.track;
  const n = track.path.length;
  const per = n / track.checkpoints.length;
  const last = track.checkpoints[car.cp % track.checkpoints.length];
  const along = Math.min(per * 1.5, (car.seg - last + n) % n);
  return car.cp * per + along;
}

/** Cars in race order: finishers by finish time, then by distance, retired cars last. */
export function standings(race: Race): Car[] {
  const rank = (c: Car) => (c.status === "finished" ? 0 : c.status === "racing" ? 1 : 2);
  return [...race.cars].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.status === "finished" ? a.finishTick - b.finishTick : progress(race, b) - progress(race, a)) ||
      race.cars.indexOf(a) - race.cars.indexOf(b),
  );
}

/** A simple driver: aims at a point ahead on the centre line and lifts off for sharp bends. */
export function botInput(race: Race, car: Car): number {
  const track = race.track;
  const n = track.path.length;
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
  const skill = (car.color % 4) / 3; // bots differ a little
  const look = 6 + Math.floor(speed / 40);
  const target = track.path[(car.seg + look) % n];
  const far = track.dir[(car.seg + look * 2) % n];
  const dx = target.x - car.x;
  const dy = target.y - car.y;
  const cross = car.hx * dy - car.hy * dx;
  const dot = car.hx * dx + car.hy * dy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // How sharp the road bends ahead compared to where the car points.
  const ahead = car.hx * far.x + car.hy * far.y;
  let input = 0;
  if (cross > len * 0.08) input |= KEY.right;
  else if (cross < -len * 0.08) input |= KEY.left;
  const limit = CAR.maxSpeed * (0.82 + skill * 0.12);
  const brakeAt = 260 + ahead * 260 + skill * 40;
  if (dot < 0 && speed < 60) input = (input & ~(KEY.left | KEY.right)) | KEY.down | (cross > 0 ? KEY.left : KEY.right);
  else if (speed > brakeAt && ahead < 0.75) input |= KEY.down;
  else if (speed < limit) input |= KEY.up;
  return input;
}

/** One tick of the whole race. `inputs` maps car ids to their input for this tick. */
export function stepRace(race: Race, inputs: Map<string, number>): void {
  if (race.over) return;
  race.tick++;
  const frozen = race.tick < race.startTick;
  for (const car of race.cars) {
    const done = car.status !== "racing";
    const input = done || car.ghost ? 0 : car.bot ? botInput(race, car) : (inputs.get(car.id) ?? 0);
    const { hit, boosted } = stepCar(race.track, car, input, frozen);
    if (hit > 120) race.events.push({ type: "bump", car: car.id, x: car.x, y: car.y, strength: hit });
    if (boosted) race.events.push({ type: "boost", car: car.id });
  }
  collideCars(race);
  for (const car of race.cars) {
    collideWorld(race.track, car);
    if (car.status === "racing" && !frozen) updateProgress(race, car);
  }
  // Away players still count until the server retires them.
  const waiting = race.cars.some((c) => c.status === "racing" && !c.bot);
  const humans = race.cars.some((c) => !c.bot);
  if (
    (humans && !waiting) ||
    (!humans && race.cars.every((c) => c.status !== "racing")) ||
    (race.endTick > 0 && race.tick >= race.endTick) ||
    race.tick >= race.startTick + race.laps * LAP_LIMIT_TICKS
  ) {
    race.over = true;
  }
}

export function retire(race: Race, id: string): string | null {
  const car = race.cars.find((c) => c.id === id);
  if (!car) return "You're not racing";
  if (car.status !== "racing") return "You're already done";
  car.status = "retired";
  car.vx = 0;
  car.vy = 0;
  return null;
}

/** Formats a tick count as m:ss.cc. */
export function lapTime(ticks: number): string {
  const total = Math.max(0, Math.round((ticks * 100) / TICK_RATE));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

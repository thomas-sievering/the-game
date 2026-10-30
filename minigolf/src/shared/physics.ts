// Deterministic shot simulation shared by server and client.
// Only + - * / and Math.sqrt are used, so results are bit-identical across JS engines.
// Integer ops on whole substep counts (%, Math.round) are exact too.
import { type Hole, type Mover, type Point, type Segment, holeSegments, pointInPolygon } from "./hole";

export const TICK_RATE = 120;
export const SUBSTEPS = 2;
const DT = 1 / TICK_RATE / SUBSTEPS;
const MAX_TICKS = TICK_RATE * 25;

export const BALL_RADIUS = 7;
export const CUP_RADIUS = 11;
export const MAX_AIM_DISTANCE = 220;
export const MAX_SPEED = 900;

const ROLL_DECEL = 130;
const DRAG = 0.5;
const SAND_ROLL_DECEL = 900;
const SAND_DRAG = 2.5;
const WALL_RESTITUTION = 0.78;
const WALL_TANGENT_KEEP = 0.98;
const BALL_RESTITUTION = 0.92;
const CUP_CAPTURE_SPEED = 380;
const STOP_SPEED = 6;
const BUMPER_RESTITUTION = 0.85;
const BUMPER_KICK = 230;
const MOVER_RESTITUTION = 0.6;
const PI = 3.141592653589793;
const SOUND_SPEED = 25;

export interface SimBall {
  id: string;
  x: number;
  y: number;
}

export type SimEvent =
  | { tick: number; type: "wall"; id: string; speed: number }
  | { tick: number; type: "ball"; id: string; other: string; speed: number }
  | { tick: number; type: "cup"; id: string }
  | { tick: number; type: "splash"; id: string; x: number; y: number }
  | { tick: number; type: "bumper"; id: string; index: number; speed: number }
  | { tick: number; type: "mover"; id: string; speed: number };

export interface BallResult {
  id: string;
  x: number;
  y: number;
  holed: boolean;
  /** Fell into water; x/y are reset to where the ball started this shot. */
  splashed: boolean;
}

export interface ShotResult {
  /** Ticks the shot lasted; the course clock advances by this much. */
  ticks: number;
  events: SimEvent[];
  balls: BallResult[];
  /** When recorded: per tick since the shot began, [x, y] of every ball in input order (NaN once removed). */
  frames?: Float64Array[];
}

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  startX: number;
  startY: number;
  active: boolean;
  holed: boolean;
  splashed: boolean;
}

interface World {
  segments: Segment[];
  hole: Hole;
  movers: Mover[];
}

const worlds = new WeakMap<Hole, World>();

function worldFor(hole: Hole): World {
  let world = worlds.get(hole);
  if (!world) {
    world = { segments: holeSegments(hole), hole, movers: hole.movers ?? [] };
    worlds.set(hole, world);
  }
  return world;
}

export function aimToVelocity(aim: Point): Point {
  const [dx, dy] = aim;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 1e-6)) return [0, 0];
  const speed = (Math.min(length, MAX_AIM_DISTANCE) / MAX_AIM_DISTANCE) * MAX_SPEED;
  return [(dx / length) * speed, (dy / length) * speed];
}

function surfaceAt(hole: Hole, x: number, y: number): { sand: boolean; water: boolean; fx: number; fy: number } {
  let sand = false;
  let water = false;
  let fx = 0;
  let fy = 0;
  for (const zone of hole.zones) {
    if (!pointInPolygon(x, y, zone.points)) continue;
    if (zone.type === "sand") sand = true;
    else if (zone.type === "water") water = true;
    else {
      fx += zone.force[0];
      fy += zone.force[1];
    }
  }
  return { sand, water, fx, fy };
}

// ── Moving obstacles ──
// A mover's pose depends only on the course clock, counted in whole substeps since the hole began.
// The clock runs only while balls roll, so between shots the course stands still.

/** Fraction (0..1) of the way through a cycle of `period` seconds at substep `n`. */
function cycle(period: number, phase: number | undefined, n: number): number {
  const length = Math.max(1, Math.round(Math.abs(period) * TICK_RATE * SUBSTEPS));
  return ((n + Math.round((phase ?? 0) * length)) % length) / length;
}

/** [cos, sin] of an angle given in whole turns, by polynomial so it stays deterministic. */
export function turnCosSin(turns: number): Point {
  let x = turns % 1;
  if (x >= 0.5) x -= 1;
  else if (x < -0.5) x += 1;
  const q = Math.round(x * 4);
  const r = (x - q / 4) * 2 * PI;
  const r2 = r * r;
  const sin = r * (1 - (r2 / 6) * (1 - (r2 / 20) * (1 - (r2 / 42) * (1 - r2 / 72))));
  const cos = 1 - (r2 / 2) * (1 - (r2 / 12) * (1 - (r2 / 30) * (1 - (r2 / 56) * (1 - r2 / 90))));
  if (q === 1) return [-sin, cos];
  if (q === -1) return [sin, -cos];
  if (q === 2 || q === -2) return [-cos, -sin];
  return [cos, sin];
}

export type MoverPose =
  | { type: "slider"; dx: number; dy: number; vx: number; vy: number }
  /** `arms` are unit directions; `omega` is in radians per second. */
  | { type: "spinner"; arms: Point[]; omega: number };

/** Where a mover is at substep `n` of the course clock. */
export function moverPose(mover: Mover, n: number): MoverPose {
  const u = cycle(mover.period, mover.phase, n);
  if (mover.type === "slider") {
    // Out and back with eased ends, so the block lingers at each end.
    const out = u < 0.5;
    const tri = out ? u * 2 : 2 - u * 2;
    const ease = tri * tri * (3 - 2 * tri);
    const rate = ((out ? 2 : -2) / mover.period) * 6 * tri * (1 - tri);
    return { type: "slider", dx: mover.path[0] * ease, dy: mover.path[1] * ease, vx: mover.path[0] * rate, vy: mover.path[1] * rate };
  }
  const turn = mover.period < 0 ? 1 - u : u;
  const arms: Point[] = [];
  for (let k = 0; k < mover.arms; k++) arms.push(turnCosSin(turn + k / mover.arms));
  return { type: "spinner", arms, omega: (2 * PI) / mover.period };
}

/** Course-clock substep at the start of a tick. */
export function clockSubstep(tick: number): number {
  return tick * SUBSTEPS;
}

/**
 * Simulates one shot: the shooter's ball gets the aim velocity, every other ball starts at rest.
 * Balls collide with walls and with each other.
 */
export function simulateShot(
  hole: Hole,
  balls: SimBall[],
  shooterId: string,
  aim: Point,
  options: { record?: boolean; startTick?: number } = {},
): ShotResult {
  const startTick = options.startTick ?? 0;
  const world = worldFor(hole);
  const [vx, vy] = aimToVelocity(aim);
  const bodies: Body[] = balls.map((b) => ({
    id: b.id,
    x: b.x,
    y: b.y,
    vx: b.id === shooterId ? vx : 0,
    vy: b.id === shooterId ? vy : 0,
    startX: b.x,
    startY: b.y,
    active: true,
    holed: false,
    splashed: false,
  }));
  const events: SimEvent[] = [];
  const frames: Float64Array[] | undefined = options.record ? [] : undefined;
  let tick = 0;

  const record = () => {
    if (!frames) return;
    const frame = new Float64Array(bodies.length * 2);
    bodies.forEach((b, i) => {
      frame[i * 2] = b.active ? b.x : NaN;
      frame[i * 2 + 1] = b.active ? b.y : NaN;
    });
    frames.push(frame);
  };
  record();

  while (tick < MAX_TICKS) {
    tick++;
    for (let s = 0; s < SUBSTEPS; s++) step(world, bodies, events, tick, clockSubstep(startTick + tick - 1) + s);
    record();
    if (bodies.every((b) => !b.active || (b.vx === 0 && b.vy === 0))) break;
  }

  return {
    ticks: tick,
    events,
    frames,
    balls: bodies.map((b) => ({
      id: b.id,
      x: b.splashed ? b.startX : b.x,
      y: b.splashed ? b.startY : b.y,
      holed: b.holed,
      splashed: b.splashed,
    })),
  };
}

function step(world: World, bodies: Body[], events: SimEvent[], tick: number, substep: number): void {
  const { hole, segments, movers } = world;
  const poses = movers.map((m) => moverPose(m, substep));
  const bumpers = hole.bumpers ?? [];

  for (const b of bodies) {
    if (!b.active) continue;
    const surface = surfaceAt(hole, b.x, b.y);
    const roll = surface.sand ? SAND_ROLL_DECEL : ROLL_DECEL;
    const drag = surface.sand ? SAND_DRAG : DRAG;

    let speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    const slope = Math.sqrt(surface.fx * surface.fx + surface.fy * surface.fy);
    if (speed < STOP_SPEED && slope <= roll) {
      b.vx = 0;
      b.vy = 0;
      // A resting ball only needs attention when something can move into it.
      if (movers.length === 0) continue;
    } else {
      b.vx += surface.fx * DT;
      b.vy += surface.fy * DT;
      speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (speed > 0) {
        const next = Math.max(0, speed - (roll + drag * speed) * DT);
        b.vx = (b.vx / speed) * next;
        b.vy = (b.vy / speed) * next;
      }
      b.x += b.vx * DT;
      b.y += b.vy * DT;
    }

    for (let i = 0; i < movers.length; i++) collideMover(b, movers[i], poses[i], events, tick);
    for (const seg of segments) collideSegment(b, seg, events, tick);
    for (let i = 0; i < bumpers.length; i++) collideBumper(b, bumpers[i].center, bumpers[i].radius, i, events, tick);

    const after = surfaceAt(hole, b.x, b.y);
    if (after.water) {
      b.active = false;
      b.splashed = true;
      events.push({ tick, type: "splash", id: b.id, x: b.x, y: b.y });
      continue;
    }

    const cx = b.x - hole.cup[0];
    const cy = b.y - hole.cup[1];
    const ballSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (cx * cx + cy * cy < CUP_RADIUS * CUP_RADIUS && ballSpeed < CUP_CAPTURE_SPEED) {
      b.active = false;
      b.holed = true;
      b.x = hole.cup[0];
      b.y = hole.cup[1];
      b.vx = 0;
      b.vy = 0;
      events.push({ tick, type: "cup", id: b.id });
    }
  }

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) collideBalls(bodies[i], bodies[j], events, tick);
  }
}

/** Closest point to the ball on the segment a→b. */
function closestOnSegment(b: Body, ax: number, ay: number, bx: number, by: number): Point {
  const ex = bx - ax;
  const ey = by - ay;
  const lengthSq = ex * ex + ey * ey;
  let t = lengthSq > 0 ? ((b.x - ax) * ex + (b.y - ay) * ey) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + ex * t, ay + ey * t];
}

/** Pushes the ball out to `reach` from point p; returns the contact normal, or null if not touching. */
function separate(b: Body, px: number, py: number, reach: number): Point | null {
  const dx = b.x - px;
  const dy = b.y - py;
  const distSq = dx * dx + dy * dy;
  if (distSq >= reach * reach || distSq === 0) return null;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  b.x = px + nx * reach;
  b.y = py + ny * reach;
  return [nx, ny];
}

/** Bounces the ball off a surface moving at (wx, wy); returns the closing speed, or 0 if they separate. */
function bounceMoving(b: Body, nx: number, ny: number, wx: number, wy: number): number {
  const rx = b.vx - wx;
  const ry = b.vy - wy;
  const vn = rx * nx + ry * ny;
  if (vn >= 0) return 0;
  b.vx = wx + rx - vn * (1 + MOVER_RESTITUTION) * nx;
  b.vy = wy + ry - vn * (1 + MOVER_RESTITUTION) * ny;
  return -vn;
}

function collideMover(b: Body, mover: Mover, pose: MoverPose, events: SimEvent[], tick: number): void {
  let hit = 0;
  if (mover.type === "slider" && pose.type === "slider") {
    const pts = mover.points;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const [px, py] = closestOnSegment(b, ax + pose.dx, ay + pose.dy, bx + pose.dx, by + pose.dy);
      const n = separate(b, px, py, BALL_RADIUS);
      if (n) hit = Math.max(hit, bounceMoving(b, n[0], n[1], pose.vx, pose.vy));
    }
  } else if (mover.type === "spinner" && pose.type === "spinner") {
    const [cx, cy] = mover.center;
    for (const [ux, uy] of pose.arms) {
      const [px, py] = closestOnSegment(b, cx, cy, cx + ux * mover.length, cy + uy * mover.length);
      const n = separate(b, px, py, BALL_RADIUS + mover.width / 2);
      // Surface velocity of the turning bar at the contact point.
      if (n) hit = Math.max(hit, bounceMoving(b, n[0], n[1], -pose.omega * (py - cy), pose.omega * (px - cx)));
    }
  }
  if (hit > SOUND_SPEED) events.push({ tick, type: "mover", id: b.id, speed: hit });
}

function collideBumper(b: Body, center: Point, radius: number, index: number, events: SimEvent[], tick: number): void {
  const n = separate(b, center[0], center[1], BALL_RADIUS + radius);
  if (!n) return;
  const [nx, ny] = n;
  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;
  const tx = b.vx - vn * nx;
  const ty = b.vy - vn * ny;
  let out = -vn * BUMPER_RESTITUTION + BUMPER_KICK;
  const speed = Math.sqrt(out * out + tx * tx + ty * ty);
  if (speed > MAX_SPEED) out = out * (MAX_SPEED / speed);
  b.vx = tx + out * nx;
  b.vy = ty + out * ny;
  events.push({ tick, type: "bumper", id: b.id, index, speed: out });
}

function collideSegment(b: Body, seg: Segment, events: SimEvent[], tick: number): void {
  const [px, py] = closestOnSegment(b, seg.ax, seg.ay, seg.bx, seg.by);
  const n = separate(b, px, py, BALL_RADIUS);
  if (!n) return;
  const [nx, ny] = n;

  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;
  const tx = b.vx - vn * nx;
  const ty = b.vy - vn * ny;
  b.vx = tx * WALL_TANGENT_KEEP - vn * WALL_RESTITUTION * nx;
  b.vy = ty * WALL_TANGENT_KEEP - vn * WALL_RESTITUTION * ny;
  if (-vn > SOUND_SPEED) events.push({ tick, type: "wall", id: b.id, speed: -vn });
}

function collideBalls(a: Body, b: Body, events: SimEvent[], tick: number): void {
  if (!a.active || !b.active) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;
  const minDist = BALL_RADIUS * 2;
  if (distSq >= minDist * minDist) return;

  let nx = 1;
  let ny = 0;
  let dist = 0;
  if (distSq > 0) {
    dist = Math.sqrt(distSq);
    nx = dx / dist;
    ny = dy / dist;
  }
  const push = (minDist - dist) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;

  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (approach <= 0) return;
  const impulse = ((1 + BALL_RESTITUTION) / 2) * approach;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
  if (approach > SOUND_SPEED) events.push({ tick, type: "ball", id: a.id, other: b.id, speed: approach });
}

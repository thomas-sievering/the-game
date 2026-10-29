// Deterministic shot simulation shared by server and client.
// Only + - * / and Math.sqrt are used, so results are bit-identical across JS engines.
import { type Hole, type Point, type Segment, holeSegments, pointInPolygon } from "./hole";

export const TICK_RATE = 120;
const SUBSTEPS = 2;
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
  | { tick: number; type: "splash"; id: string; x: number; y: number };

export interface BallResult {
  id: string;
  x: number;
  y: number;
  holed: boolean;
  /** Fell into water; x/y are reset to where the ball started this shot. */
  splashed: boolean;
}

export interface ShotResult {
  ticks: number;
  events: SimEvent[];
  balls: BallResult[];
  /** When recorded: per tick, [x, y] of every ball in input order (NaN once removed). */
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
}

const worlds = new WeakMap<Hole, World>();

function worldFor(hole: Hole): World {
  let world = worlds.get(hole);
  if (!world) {
    world = { segments: holeSegments(hole), hole };
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

/**
 * Simulates one shot: the shooter's ball gets the aim velocity, every other ball starts at rest.
 * Balls collide with walls and with each other.
 */
export function simulateShot(
  hole: Hole,
  balls: SimBall[],
  shooterId: string,
  aim: Point,
  options: { record?: boolean } = {},
): ShotResult {
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
    for (let s = 0; s < SUBSTEPS; s++) step(world, bodies, events, tick);
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

function step(world: World, bodies: Body[], events: SimEvent[], tick: number): void {
  const { hole, segments } = world;

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
      continue;
    }

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

    for (const seg of segments) collideSegment(b, seg, events, tick);

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

function collideSegment(b: Body, seg: Segment, events: SimEvent[], tick: number): void {
  const ex = seg.bx - seg.ax;
  const ey = seg.by - seg.ay;
  const lengthSq = ex * ex + ey * ey;
  let t = lengthSq > 0 ? ((b.x - seg.ax) * ex + (b.y - seg.ay) * ey) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.ax + ex * t;
  const py = seg.ay + ey * t;
  const dx = b.x - px;
  const dy = b.y - py;
  const distSq = dx * dx + dy * dy;
  if (distSq >= BALL_RADIUS * BALL_RADIUS || distSq === 0) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  b.x = px + nx * BALL_RADIUS;
  b.y = py + ny * BALL_RADIUS;

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

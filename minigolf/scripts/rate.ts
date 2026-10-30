// Estimates how hard each hole is by letting a slightly inaccurate bot play it.
// Usage: npm run rate [-- <hole-file-substring>]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hole, Point } from "../src/shared/hole";
import { MAX_STROKES } from "../src/shared/rules";
import { MAX_AIM_DISTANCE, simulateShot } from "../src/shared/physics";
import { distanceField } from "./field";

const HOLES_DIR = join(import.meta.dirname, "../src/shared/holes");
const RUNS = 16;
const ANGLES = 72;
const POWERS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const ANGLE_NOISE = 0.05; // radians, standard deviation
const POWER_NOISE = 0.08; // fraction of the aim length, standard deviation

let seed = 1;
function random(): number {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

function rotate([x, y]: Point, angle: number, scale: number): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [(x * c - y * s) * scale, (x * s + y * c) * scale];
}

/** `tick` is the course clock, so moving obstacles are where a real round would have them. */
function shoot(hole: Hole, pos: Point, aim: Point, tick: number) {
  const result = simulateShot(hole, [{ id: "p", x: pos[0], y: pos[1] }], "p", aim, { startTick: tick });
  return { ...result.balls[0], ticks: result.ticks };
}

function rate(hole: Hole): { mean: number; min: number; max: number } {
  const field = distanceField(hole);
  const aims: Point[] = [];
  for (let a = 0; a < ANGLES; a++) {
    for (const p of POWERS) aims.push(rotate([p * MAX_AIM_DISTANCE, 0], (a / ANGLES) * Math.PI * 2, 1));
  }
  const value = (pos: Point, aim: Point, tick: number) => {
    const ball = shoot(hole, pos, aim, tick);
    if (ball.holed) return -1000;
    if (ball.splashed) return field(...pos) + 400;
    return field(ball.x, ball.y);
  };
  // The bot prefers shots that still work when slightly off.
  const choose = (pos: Point, tick: number) => {
    let best = aims[0];
    let bestScore = Infinity;
    for (const aim of aims) {
      const score = value(pos, aim, tick) + value(pos, rotate(aim, ANGLE_NOISE, 1), tick) + value(pos, rotate(aim, -ANGLE_NOISE, 1), tick);
      if (score < bestScore) [best, bestScore] = [aim, score];
    }
    return best;
  };

  const totals: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    let pos: Point = hole.tee;
    let strokes = 0;
    let tick = 0;
    while (strokes < MAX_STROKES) {
      const aim = rotate(choose(pos, tick), gaussian() * ANGLE_NOISE, 1 + gaussian() * POWER_NOISE);
      const ball = shoot(hole, pos, aim, tick);
      tick += ball.ticks;
      strokes += ball.splashed ? 2 : 1;
      if (ball.holed) break;
      pos = [ball.x, ball.y];
    }
    totals.push(Math.min(strokes, MAX_STROKES));
  }
  return { mean: totals.reduce((a, b) => a + b, 0) / RUNS, min: Math.min(...totals), max: Math.max(...totals) };
}

const filter = process.argv[2] ?? "";
for (const file of readdirSync(HOLES_DIR).filter((f) => f.endsWith(".json") && f.includes(filter))) {
  const hole = JSON.parse(readFileSync(join(HOLES_DIR, file), "utf8")) as Hole;
  const { mean, min, max } = rate(hole);
  console.log(`${file.padEnd(24)} par ${hole.par}  solution ${hole.solution.length}  bot ${mean.toFixed(2)} (${min}-${max})`);
}

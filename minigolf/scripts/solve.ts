// Finds a short solo shot sequence for each hole and writes it into the hole's "solution".
// Usage: npm run solve [-- <hole-file-substring>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hole, Point } from "../src/shared/hole";
import { distanceField } from "./field";
import { MAX_AIM_DISTANCE, simulateShot } from "../src/shared/physics";

const HOLES_DIR = join(import.meta.dirname, "../src/shared/holes");
const BEAM = 6;
const ANGLES = 120;
const POWERS = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1];

interface Node {
  pos: Point;
  /** Course clock, so moving obstacles are where a real round would have them. */
  tick: number;
  shots: Point[];
  score: number;
}

function solve(hole: Hole): Point[] | null {
  const field = distanceField(hole);
  const aims: Point[] = [];
  for (let a = 0; a < ANGLES; a++) {
    const angle = (a / ANGLES) * Math.PI * 2;
    for (const p of POWERS) {
      const r = p * MAX_AIM_DISTANCE;
      aims.push([Math.round(Math.cos(angle) * r * 100) / 100, Math.round(Math.sin(angle) * r * 100) / 100]);
    }
  }

  let beam: Node[] = [{ pos: hole.tee, tick: 0, shots: [], score: field(...hole.tee) }];
  for (let depth = 1; depth <= hole.par + 1; depth++) {
    const next: Node[] = [];
    for (const node of beam) {
      for (const aim of aims) {
        const result = simulateShot(hole, [{ id: "p", x: node.pos[0], y: node.pos[1] }], "p", aim, { startTick: node.tick });
        const ball = result.balls[0];
        const shots = [...node.shots, aim];
        if (ball.holed) return shots;
        if (ball.splashed) continue;
        next.push({ pos: [ball.x, ball.y], tick: node.tick + result.ticks, shots, score: field(ball.x, ball.y) });
      }
    }
    next.sort((a, b) => a.score - b.score);
    // Keep the beam spread out so it does not collapse onto one spot.
    beam = [];
    for (const n of next) {
      if (beam.every((b) => Math.abs(b.pos[0] - n.pos[0]) + Math.abs(b.pos[1] - n.pos[1]) > 40)) beam.push(n);
      if (beam.length >= BEAM) break;
    }
    console.log(`  depth ${depth}: best remaining ${beam[0]?.score.toFixed(0)}`);
  }
  return null;
}

const filter = process.argv[2] ?? "";
for (const file of readdirSync(HOLES_DIR).filter((f) => f.endsWith(".json") && f.includes(filter))) {
  const path = join(HOLES_DIR, file);
  const hole = JSON.parse(readFileSync(path, "utf8")) as Hole;
  console.log(`${file} (par ${hole.par})`);
  const solution = solve(hole);
  if (!solution) {
    console.log("  NO SOLUTION FOUND");
    process.exitCode = 1;
    continue;
  }
  console.log(`  solved in ${solution.length}`);
  const text = readFileSync(path, "utf8").replace(/"solution": \[(\s*\[[^\]]*\],?)*\s*\]/, `"solution": ${JSON.stringify(solution)}`);
  writeFileSync(path, text);
}

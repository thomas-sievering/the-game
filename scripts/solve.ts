// Finds a short solo shot sequence for each hole and writes it into the hole's "solution".
// Usage: npm run solve [-- <hole-file-substring>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hole, type Point, holeExtent, pointInPolygon } from "../src/shared/hole";
import { MAX_AIM_DISTANCE, simulateShot } from "../src/shared/physics";

const HOLES_DIR = join(import.meta.dirname, "../src/shared/holes");
const CELL = 8;
const BEAM = 6;
const ANGLES = 120;
const POWERS = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1];

function distanceField(hole: Hole): (x: number, y: number) => number {
  const { minX, minY, maxX, maxY } = holeExtent(hole);
  const w = Math.ceil((maxX - minX) / CELL) + 1;
  const h = Math.ceil((maxY - minY) / CELL) + 1;
  const dist = new Float64Array(w * h).fill(Infinity);
  const open = (cx: number, cy: number) => {
    const x = minX + cx * CELL;
    const y = minY + cy * CELL;
    if (!pointInPolygon(x, y, hole.bounds)) return false;
    if (hole.obstacles.some((o) => pointInPolygon(x, y, o))) return false;
    return !hole.zones.some((z) => z.type === "water" && pointInPolygon(x, y, z.points));
  };
  const passable = new Uint8Array(w * h);
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) passable[cy * w + cx] = open(cx, cy) ? 1 : 0;

  // Dijkstra on the grid, seeded from the cup.
  const start = Math.round((hole.cup[1] - minY) / CELL) * w + Math.round((hole.cup[0] - minX) / CELL);
  dist[start] = 0;
  const queue = [start];
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (dist[queue[i]] < dist[queue[best]]) best = i;
    const cur = queue.splice(best, 1)[0];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy, cost] of [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!passable[n]) continue;
      const d = dist[cur] + cost * CELL;
      if (d < dist[n]) {
        if (dist[n] === Infinity) queue.push(n);
        dist[n] = d;
      }
    }
  }
  return (x, y) => {
    const cx = Math.round((x - minX) / CELL);
    const cy = Math.round((y - minY) / CELL);
    const v = dist[cy * w + cx];
    return v === undefined ? 1e9 : v;
  };
}

interface Node {
  pos: Point;
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

  let beam: Node[] = [{ pos: hole.tee, shots: [], score: field(...hole.tee) }];
  for (let depth = 1; depth <= hole.par + 1; depth++) {
    const next: Node[] = [];
    for (const node of beam) {
      for (const aim of aims) {
        const result = simulateShot(hole, [{ id: "p", x: node.pos[0], y: node.pos[1] }], "p", aim);
        const ball = result.balls[0];
        const shots = [...node.shots, aim];
        if (ball.holed) return shots;
        if (ball.splashed) continue;
        next.push({ pos: [ball.x, ball.y], shots, score: field(ball.x, ball.y) });
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
  const text = readFileSync(path, "utf8").replace(/"solution": \[[^\]]*(\[[^\]]*\][^\]]*)*\]/, `"solution": ${JSON.stringify(solution)}`);
  writeFileSync(path, text);
}

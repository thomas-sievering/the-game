// Walking distance to the cup for every point of a hole, ignoring water.
import { type Hole, holeExtent, pointInPolygon } from "../src/shared/hole";

const CELL = 8;

export function distanceField(hole: Hole): (x: number, y: number) => number {
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

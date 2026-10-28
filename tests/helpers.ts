import type { Hole } from "../src/shared/hole";
import { MAX_AIM_DISTANCE, simulateShot } from "../src/shared/physics";

const EMPTY: Hole = {
  id: "empty",
  name: "Empty",
  par: 1,
  bounds: [[-5000, -5000], [5000, -5000], [5000, 5000], [-5000, 5000]],
  obstacles: [],
  zones: [],
  tee: [0, 0],
  cup: [99999, 99999],
  solution: [],
};

/** Horizontal aim length that makes a lone ball on flat grass stop `distance` px away. */
export function aimForDistance(distance: number): number {
  let lo = 0;
  let hi = MAX_AIM_DISTANCE;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const travelled = simulateShot(EMPTY, [{ id: "a", x: 0, y: 0 }], "a", [mid, 0]).balls[0].x;
    if (travelled < distance) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

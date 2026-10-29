export type Point = [number, number];

export type Zone =
  | { type: "sand"; points: Point[] }
  | { type: "water"; points: Point[] }
  | { type: "slope"; points: Point[]; force: Point };

export interface Hole {
  id: string;
  name: string;
  par: number;
  /** Closed polygon of the playable fairway; its edges are walls. */
  bounds: Point[];
  /** Closed polygons of solid blocks inside the fairway. */
  obstacles: Point[][];
  zones: Zone[];
  tee: Point;
  cup: Point;
  /** Aim vectors (target minus ball position) that hole out when played solo. */
  solution: Point[];
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export function polygonSegments(points: Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    segments.push({ ax, ay, bx, by });
  }
  return segments;
}

export function holeSegments(hole: Hole): Segment[] {
  return [hole.bounds, ...hole.obstacles].flatMap(polygonSegments);
}

export function pointInPolygon(x: number, y: number, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function holeExtent(hole: Hole): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of hole.bounds) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

// Track geometry shared by the server and the client. Everything here is built from + - * / and
// Math.sqrt with a seeded integer RNG, so both sides derive exactly the same track and obstacles.

export type Theme = "meadow" | "desert" | "city";
export type TrackId = "meadow" | "canyon" | "neon";
export const TRACK_IDS: TrackId[] = ["meadow", "canyon", "neon"];

export interface Point {
  x: number;
  y: number;
}

export interface Circle {
  kind: "tree" | "rock" | "cactus" | "tyres" | "lamp" | "bush";
  x: number;
  y: number;
  r: number;
}

export interface Rect {
  kind: "building" | "stand";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Building height for the client's fake 3D roof; no effect on driving. */
  floors: number;
}

export interface BoostPad {
  /** Path index of the pad's centre. */
  seg: number;
  x: number;
  y: number;
  /** Unit direction of travel at the pad. */
  dx: number;
  dy: number;
}

export interface Track {
  id: TrackId;
  name: string;
  blurb: string;
  theme: Theme;
  width: number;
  height: number;
  /** Half the road width. */
  half: number;
  /** Centre line, evenly spaced and closed (the last point joins the first). Index 0 is the start line. */
  path: Point[];
  /** Unit direction of travel at each path point. */
  dir: Point[];
  /** Distance between path points. */
  spacing: number;
  /** Path index of each checkpoint; checkpoint 0 is the start/finish line. */
  checkpoints: number[];
  circles: Circle[];
  rects: Rect[];
  boosts: BoostPad[];
  /** Starting grid slots, pole position first. */
  grid: { x: number; y: number; hx: number; hy: number }[];
}

interface TrackDef {
  id: TrackId;
  name: string;
  blurb: string;
  theme: Theme;
  width: number;
  height: number;
  roadWidth: number;
  seed: number;
  /** Control points of the closed centre line, in driving order. The start line sits at the first. */
  points: [number, number][];
}

const DEFS: TrackDef[] = [
  {
    id: "meadow",
    name: "Meadow Ring",
    blurb: "Sunny country loop with fast sweepers",
    theme: "meadow",
    width: 3300,
    height: 2400,
    roadWidth: 170,
    seed: 11,
    points: [
      [700, 1500],
      [560, 1050],
      [720, 560],
      [1250, 380],
      [1750, 640],
      [2250, 420],
      [2780, 560],
      [2900, 1150],
      [2560, 1560],
      [2080, 1380],
      [1660, 1580],
      [1460, 1960],
      [950, 2020],
    ],
  },
  {
    id: "canyon",
    name: "Dune Canyon",
    blurb: "Sunset desert with tight hairpins",
    theme: "desert",
    width: 3400,
    height: 2500,
    roadWidth: 150,
    seed: 23,
    points: [
      [520, 1500],
      [430, 820],
      [720, 380],
      [1110, 520],
      [1160, 1180],
      [1460, 1360],
      [1680, 640],
      [2040, 330],
      [2640, 380],
      [2960, 800],
      [2540, 1120],
      [2960, 1520],
      [2760, 2040],
      [1820, 2080],
      [1180, 1900],
      [700, 2050],
    ],
  },
  {
    id: "neon",
    name: "Neon City",
    blurb: "Night streets with square corners",
    theme: "city",
    width: 3400,
    height: 2400,
    roadWidth: 150,
    seed: 37,
    points: [
      [460, 1420],
      [460, 1020],
      [620, 860],
      [1100, 860],
      [1260, 700],
      [1260, 460],
      [1420, 300],
      [2000, 300],
      [2160, 460],
      [2160, 1000],
      [2320, 1160],
      [2760, 1160],
      [2920, 1320],
      [2920, 1820],
      [2760, 1980],
      [1920, 1980],
      [1760, 1820],
      [1760, 1580],
      [1600, 1420],
      [1160, 1420],
      [1000, 1580],
      [1000, 1820],
      [840, 1980],
      [620, 1980],
      [460, 1820],
    ],
  },
];

const SPACING = 16;
const CHECKPOINTS = 8;

/** A small deterministic RNG (mulberry32) returning integers in [0, 2^32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Closed centripetal Catmull–Rom spline through the control points, resampled at even spacing. */
function smooth(points: [number, number][]): Point[] {
  const n = points.length;
  const dense: Point[] = [];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [points[(i - 1 + n) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]].map(([x, y]) => ({ x, y }));
    const knot = (a: Point, b: Point) => Math.sqrt(Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const lerp = (a: Point, b: Point, ta: number, tb: number, t: number) => ({
      x: ((tb - t) / (tb - ta)) * a.x + ((t - ta) / (tb - ta)) * b.x,
      y: ((tb - t) / (tb - ta)) * a.y + ((t - ta) / (tb - ta)) * b.y,
    });
    const steps = 40;
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      dense.push(lerp(b1, b2, t1, t2, t));
    }
  }
  // Walk the dense polyline and drop a point every SPACING pixels.
  let total = 0;
  for (let i = 0; i < dense.length; i++) total += dist(dense[i], dense[(i + 1) % dense.length]);
  const count = Math.round(total / SPACING);
  const step = total / count;
  const out: Point[] = [{ ...dense[0] }];
  let walked = 0;
  let next = step;
  for (let i = 0; i < dense.length && out.length < count; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    const len = dist(a, b);
    while (walked + len >= next && out.length < count) {
      const f = (next - walked) / len;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      next += step;
    }
    walked += len;
  }
  return out;
}

export function dist(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
}

/** Distance from p to the segment ab. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + abx * t - p.x;
  const y = a.y + aby * t - p.y;
  return Math.sqrt(x * x + y * y);
}

/** Distance from p to the closest point of the centre line. */
export function roadDistance(track: Track, p: Point): number {
  let best = Infinity;
  const n = track.path.length;
  for (let i = 0; i < n; i++) best = Math.min(best, segmentDistance(p, track.path[i], track.path[(i + 1) % n]));
  return best;
}

function rectDistance(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.sqrt(dx * dx + dy * dy);
}

function build(def: TrackDef): Track {
  const path = smooth(def.points);
  const n = path.length;
  const dir = path.map((p, i) => {
    const a = path[(i - 1 + n) % n];
    const b = path[(i + 1) % n];
    const len = dist(a, b);
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  });
  const half = def.roadWidth / 2;
  const track: Track = {
    id: def.id,
    name: def.name,
    blurb: def.blurb,
    theme: def.theme,
    width: def.width,
    height: def.height,
    half,
    path,
    dir,
    spacing: SPACING,
    checkpoints: Array.from({ length: CHECKPOINTS }, (_, i) => Math.floor((i * n) / CHECKPOINTS)),
    circles: [],
    rects: [],
    boosts: [],
    grid: [],
  };
  const random = rng(def.seed);
  const unit = () => random() / 4294967296;
  const clearOf = (p: Point, r: number, gap: number) =>
    roadDistance(track, p) > half + r + gap &&
    track.circles.every((c) => dist(c, p) > c.r + r + 12) &&
    track.rects.every((b) => rectDistance(p, b) > r + 12);

  // A grandstand beside the start straight, on whichever side has room.
  const start = path[0];
  const vertical = dir[0].y * dir[0].y > dir[0].x * dir[0].x;
  stands: for (const away of [110, 150, 200]) for (const side of [1, -1]) {
    const cx = start.x - dir[0].y * side * (half + away);
    const cy = start.y + dir[0].x * side * (half + away);
    const stand: Rect = vertical
      ? { kind: "stand", x: Math.round(cx - 40), y: Math.round(cy - 160), w: 80, h: 320, floors: 0 }
      : { kind: "stand", x: Math.round(cx - 160), y: Math.round(cy - 40), w: 320, h: 80, floors: 0 };
    const inside = stand.x > 40 && stand.y > 40 && stand.x + stand.w < def.width - 40 && stand.y + stand.h < def.height - 40;
    if (inside && path.every((q) => rectDistance(q, stand) > half + 40)) {
      track.rects.push(stand);
      break stands;
    }
  }

  // Tyre stacks guard the outside of the sharpest corners.
  const bend = (i: number) => {
    const a = dir[(i - 6 + n) % n];
    const b = dir[(i + 6) % n];
    return a.x * b.y - a.y * b.x;
  };
  for (let i = 0; i < n; i += 4) {
    const turn = bend(i);
    if (turn * turn < 0.36) continue;
    const side = turn > 0 ? -1 : 1; // outside of the bend
    const p = { x: path[i].x - dir[i].y * side * (half + 70), y: path[i].y + dir[i].x * side * (half + 70) };
    if (clearOf(p, 16, 40)) track.circles.push({ kind: "tyres", x: p.x, y: p.y, r: 16 });
  }

  if (def.theme === "city") {
    // City blocks on a grid; street lamps line the road.
    const block = 230;
    for (let gx = 40; gx < def.width - 100; gx += block) {
      for (let gy = 40; gy < def.height - 100; gy += block) {
        if (unit() < 0.12) continue;
        const w = 120 + Math.floor(unit() * 70);
        const h = 120 + Math.floor(unit() * 70);
        const rect: Rect = { kind: "building", x: gx + Math.floor(unit() * (block - w - 20)), y: gy + Math.floor(unit() * (block - h - 20)), w, h, floors: 2 + Math.floor(unit() * 6) };
        const corners = [
          { x: rect.x, y: rect.y },
          { x: rect.x + w, y: rect.y },
          { x: rect.x, y: rect.y + h },
          { x: rect.x + w, y: rect.y + h },
          { x: rect.x + w / 2, y: rect.y + h / 2 },
        ];
        const nearRoad = path.some((p) => rectDistance(p, rect) < half + 60);
        const overlaps = track.rects.some((o) => rect.x < o.x + o.w + 30 && o.x < rect.x + w + 30 && rect.y < o.y + o.h + 30 && o.y < rect.y + h + 30);
        if (!nearRoad && !overlaps && corners.every((c) => c.x > 0 && c.y > 0 && c.x < def.width && c.y < def.height)) track.rects.push(rect);
      }
    }
    for (let i = 10; i < n; i += 22) {
      for (const side of [-1, 1]) {
        const p = { x: path[i].x - dir[i].y * side * (half + 34), y: path[i].y + dir[i].x * side * (half + 34) };
        if (clearOf(p, 6, 20)) track.circles.push({ kind: "lamp", x: p.x, y: p.y, r: 6 });
      }
    }
  }

  const scatter: { kind: Circle["kind"]; min: number; max: number; count: number; gap: number }[] =
    def.theme === "meadow"
      ? [
          { kind: "tree", min: 26, max: 40, count: 70, gap: 60 },
          { kind: "bush", min: 14, max: 20, count: 30, gap: 50 },
        ]
      : def.theme === "desert"
        ? [
            { kind: "rock", min: 22, max: 52, count: 45, gap: 55 },
            { kind: "cactus", min: 10, max: 14, count: 50, gap: 45 },
          ]
        : [{ kind: "tree", min: 18, max: 24, count: 18, gap: 50 }];
  for (const s of scatter) {
    let placed = 0;
    for (let tries = 0; tries < s.count * 30 && placed < s.count; tries++) {
      const r = s.min + Math.floor(unit() * (s.max - s.min));
      const p = { x: 60 + unit() * (def.width - 120), y: 60 + unit() * (def.height - 120) };
      if (!clearOf(p, r, s.gap)) continue;
      track.circles.push({ kind: s.kind, x: Math.round(p.x), y: Math.round(p.y), r });
      placed++;
    }
  }

  // Boost pads on the three straightest stretches, away from the start and from each other.
  const straightness = path.map((_, i) => {
    let sum = 0;
    for (let k = -10; k <= 10; k += 2) {
      const t = bend((i + k + n) % n);
      sum += t * t;
    }
    return sum;
  });
  const order = path.map((_, i) => i).sort((a, b) => straightness[a] - straightness[b] || a - b);
  const gapTo = (a: number, b: number) => Math.min(Math.abs(a - b), n - Math.abs(a - b));
  for (const i of order) {
    if (track.boosts.length === 3) break;
    if (gapTo(i, 0) < n / 8 || track.boosts.some((b) => gapTo(b.seg, i) < n / 5)) continue;
    track.boosts.push({ seg: i, x: path[i].x, y: path[i].y, dx: dir[i].x, dy: dir[i].y });
  }
  track.boosts.sort((a, b) => a.seg - b.seg);

  // Grid: two columns, staggered, behind the start line facing along the road.
  for (let slot = 0; slot < 8; slot++) {
    const back = 3 + slot * 3;
    const i = (n - back) % n;
    const side = slot % 2 === 0 ? -1 : 1;
    const p = path[i];
    track.grid.push({ x: p.x - dir[i].y * side * half * 0.45, y: p.y + dir[i].x * side * half * 0.45, hx: dir[i].x, hy: dir[i].y });
  }
  return track;
}

export const TRACKS: Record<TrackId, Track> = Object.fromEntries(DEFS.map((d) => [d.id, build(d)])) as Record<TrackId, Track>;

export function isTrackId(id: unknown): id is TrackId {
  return typeof id === "string" && (TRACK_IDS as string[]).includes(id);
}

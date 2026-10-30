import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { type Hole, type Point, holeExtent, pointInPolygon } from "../shared/hole";
import { BALL_RADIUS, CUP_RADIUS, MAX_AIM_DISTANCE, PORTAL_RADIUS, moverPose } from "../shared/physics";

/** A garden minigolf park: a raised carpet course with wooden rails, set in a lawn with trees and flower beds. */
export const PALETTE = {
  lawn: 0x76a35f,
  lawnLight: 0x7fac67,
  lawnDark: 0x648f4f,
  tuft: 0x557f43,
  path: 0xe7dcc2,
  pathDark: 0xcbbd9b,
  fairway: 0x7cc46f,
  stripe: 0x88cc7b,
  speckLight: 0x9ad68d,
  speckDark: 0x6bb05f,
  wood: 0xd09a62,
  woodDark: 0x9a6438,
  woodLight: 0xe9c08f,
  woodEdge: 0x6b4426,
  sand: 0xf0dca8,
  sandDark: 0xd8bd7c,
  water: 0x6fb7d4,
  waterDeep: 0x4b97ba,
  waterLight: 0xd4f0f7,
  tee: 0x5fa553,
  teeLine: 0xe8f5df,
  cup: 0x2c3a2a,
  flag: 0xe8615a,
  flagDark: 0xc4463f,
  ink: 0x2f3b2c,
  bumper: 0xec7fb6,
  bumperDark: 0xc65690,
  bumperRim: 0xfff6fb,
  spinner: 0xe8615a,
  spinnerDark: 0xb8433d,
  slider: 0xf4bd3c,
  sliderDark: 0xc98f1c,
  sliderLight: 0xffe08a,
  ice: 0xd6eef7,
  iceDark: 0x9fcde0,
  boost: 0xf08a3a,
  boostDark: 0xc4612a,
  boostLight: 0xffe08a,
  shadow: 0x1f3a1a,
  metal: 0xdfe3e6,
  gold: 0xf2b632,
};

/** Rim colour of each portal pair, so linked ends match. */
const PORTAL_COLORS = [0x9b6bea, 0x2fb8a8, 0xe8615a, 0x3f8fd2];

const FLOWERS = [0xffffff, 0xf7d046, 0xf29bc0, 0xe8615a, 0xb9a3f0, 0xffb36b];
const TREES = [0x4f8a43, 0x5b9a4b, 0x467d3d];

/** Visible width of the rail outside the fairway, and how high it stands. */
const RAIL = 16;
const RAIL_HEIGHT = 7;
/** Width of the gravel path around the rail. */
const PATH = 22;
/** How far block tops are lifted above their footprint. */
const BLOCK_HEIGHT = 6;

export interface BallView {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
  isTurn: boolean;
  isMe: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  size: number;
  spin: number;
  angle: number;
}

interface Ring {
  x: number;
  y: number;
  t: number;
}

interface Glint {
  x: number;
  y: number;
  phase: number;
}

const HUD_LEFT = 230;
const HUD_TOP = 70;
const HUD_BOTTOM = 60;
/** World area framed when no hole is shown, e.g. behind the home screen. */
const DEFAULT_EXTENT = { minX: 60, minY: 60, maxX: 1160, maxY: 540 };

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
}

function shifted(points: Point[], dx: number, dy: number): number[] {
  return points.flatMap(([x, y]) => [x + dx, y + dy]);
}

function bbox(points: Point[]): [number, number, number, number] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function distToPolygon(x: number, y: number, points: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [dx, dy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/**
 * Pieces of the polygon's edges that don't border one of `others`, so zones laid side by side
 * (e.g. a moat built from several rectangles) read as one area without seams.
 */
function openEdges(points: Point[], others: Point[][]): Point[][] {
  const runs: Point[][] = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const [nx, ny] = [(by - ay) / len, -(bx - ax) / len];
    const pieces = Math.max(1, Math.ceil(len / 6));
    let run: Point[] | null = null;
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      const [mx, my] = [ax + (bx - ax) * t, ay + (by - ay) * t];
      const shared = others.some((o) => pointInPolygon(mx + nx * 3, my + ny * 3, o) || pointInPolygon(mx - nx * 3, my - ny * 3, o));
      if (shared) {
        run = null;
        continue;
      }
      if (!run) {
        run = [[ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces]];
        runs.push(run);
      }
      run.push([ax + ((bx - ax) * (k + 1)) / pieces, ay + ((by - ay) * (k + 1)) / pieces]);
    }
  }
  return runs;
}

function strokeEdges(g: Graphics, runs: Point[][], style: { width: number; color: number; alpha: number }): void {
  for (const run of runs) {
    g.moveTo(...run[0]);
    for (const p of run.slice(1)) g.lineTo(...p);
    g.stroke({ ...style, cap: "round", join: "round" });
  }
}

function dashedCircle(g: Graphics, x: number, y: number, r: number, style: { width: number; color: number; alpha: number }): void {
  const dashes = Math.max(8, Math.round(r / 7));
  for (let i = 0; i < dashes; i++) {
    const a0 = (i / dashes) * Math.PI * 2;
    const a1 = a0 + (Math.PI / dashes) * 1.1;
    g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r)
      .arc(x, y, r, a0, a1)
      .stroke({ ...style, cap: "round" });
  }
}

export class Renderer {
  readonly app = new Application();
  /**
   * The lawn, scenery and course never change during a hole, so they are rendered into a plain canvas behind
   * the transparent Pixi canvas and redrawn only on resize or a new hole. Software WebGL (CI, laptops without
   * a GPU) can't afford redrawing them every frame.
   */
  private still = new Container();
  private stillCanvas: HTMLCanvasElement | null = null;
  private parent: HTMLElement | null = null;
  private lawn = new Graphics();
  /** Scenery and course in world coordinates; follows the world's scale and origin. */
  private backdrop = new Container();
  private scenery = new Graphics();
  private course = new Container();
  private world = new Container();
  /** Water shimmer, bumpers and moving obstacles, redrawn every frame. */
  private props = new Graphics();
  private dynamic = new Graphics();
  private flag = new Graphics();
  private labels = new Container();
  private labelCache = new Map<string, Text>();
  private hole: Hole | null = null;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private glints: Glint[] = [];
  private trails = new Map<string, Point[]>();
  private time = 0;
  /** Seconds left on each bumper's hit flash. */
  private bumperFlash: number[] = [];
  /** Seconds left on each portal's flash after a ball goes through. */
  private portalFlash: number[] = [];

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    this.parent = parent;
    Object.assign(this.app.canvas.style, { position: "absolute", left: "0", top: "0" });
    parent.appendChild(this.app.canvas);
    this.backdrop.addChild(this.scenery, this.course);
    this.still.addChild(this.lawn, this.backdrop);
    this.world.addChild(this.props, this.dynamic, this.flag, this.labels);
    this.app.stage.addChild(this.world);
    this.app.renderer.on("resize", () => this.fit());
    this.fit();
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  setHole(hole: Hole | null): void {
    if (hole === this.hole) return;
    this.hole = hole;
    this.course.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.flag.clear();
    this.props.clear();
    this.dynamic.clear();
    this.trails.clear();
    this.particles = [];
    this.rings = [];
    this.bumperFlash = [];
    this.portalFlash = [];
    this.glints = [];
    for (const label of this.labelCache.values()) label.visible = false;
    if (hole) {
      this.drawCourse(hole);
      this.glints = this.waterGlints(hole);
    }
    this.fit();
  }

  private fit(): void {
    const { minX, minY, maxX, maxY } = this.hole ? holeExtent(this.hole) : DEFAULT_EXTENT;
    const pad = 30;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const left = w > 900 ? HUD_LEFT : 16;
    const availW = w - left - 16;
    const availH = h - HUD_TOP - HUD_BOTTOM;
    const scale = Math.min(availW / (maxX - minX + pad * 2), availH / (maxY - minY + pad * 2));
    this.world.scale.set(scale);
    this.world.position.set(
      left + (availW - (maxX - minX) * scale) / 2 - minX * scale,
      HUD_TOP + (availH - (maxY - minY) * scale) / 2 - minY * scale,
    );
    this.backdrop.scale.set(scale);
    this.backdrop.position.copyFrom(this.world.position);
    this.lawn.clear().rect(0, 0, w, h).fill(PALETTE.lawn);
    const { x: ox, y: oy } = this.world.position;
    this.drawScenery((0 - ox) / scale, (0 - oy) / scale, (w - ox) / scale, (h - oy) / scale);
    this.renderStill();
  }

  /** Renders the lawn, scenery and course into the canvas behind the Pixi canvas. */
  private renderStill(): void {
    if (!this.parent) return;
    const { width, height } = this.app.screen;
    const canvas = this.app.renderer.extract.canvas({
      target: this.still,
      frame: new Rectangle(0, 0, width, height),
      resolution: this.app.renderer.resolution,
      antialias: true,
    }) as HTMLCanvasElement;
    Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: `${width}px`, height: `${height}px` });
    if (this.stillCanvas) this.stillCanvas.replaceWith(canvas);
    else this.parent.insertBefore(canvas, this.app.canvas);
    this.stillCanvas = canvas;
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const rect = this.app.canvas.getBoundingClientRect();
    const s = this.world.scale.x;
    return [(clientX - rect.left - this.world.position.x) / s, (clientY - rect.top - this.world.position.y) / s];
  }

  // ── Scenery ──

  /** Mown lawn with trees, bushes, flowers and stones over the visible world rect, kept clear of the course. */
  private drawScenery(x0: number, y0: number, x1: number, y1: number): void {
    const g = this.scenery.clear();
    const band = 90;
    for (let x = Math.floor(x0 / band) * band; x < x1; x += band * 2) {
      g.rect(x, y0, band, y1 - y0).fill({ color: PALETTE.lawnLight, alpha: 0.35 });
    }
    const bounds = this.hole?.bounds;
    const clearance = (x: number, y: number) =>
      bounds ? (pointInPolygon(x, y, bounds) ? -1 : distToPolygon(x, y, bounds)) : Infinity;
    const step = 48;
    const trees: [number, number, number, number][] = [];
    for (let gx = Math.floor(x0 / step) - 1; gx * step < x1 + step; gx++) {
      for (let gy = Math.floor(y0 / step) - 1; gy * step < y1 + step; gy++) {
        const seed = gx * 7919 + gy * 104729;
        const r = hash(seed);
        const x = (gx + hash(seed + 1)) * step;
        const y = (gy + hash(seed + 2)) * step;
        const free = clearance(x, y);
        const edge = RAIL + PATH;
        if (r < 0.04) {
          const size = 28 + hash(seed + 3) * 18;
          if (free > size + edge + 6) trees.push([x, y, size, seed]);
        } else if (r < 0.08) {
          if (free > edge + 24) this.drawBush(g, x, y, seed);
        } else if (r < 0.15) {
          if (free > edge + 18) this.drawFlowers(g, x, y, seed);
        } else if (r < 0.42) {
          if (free > edge + 8) this.drawTuft(g, x, y, seed);
        } else if (r < 0.44) {
          if (free > edge + 12) {
            const s = 5 + hash(seed + 3) * 6;
            g.ellipse(x + 2, y + 3, s * 1.3, s).fill({ color: PALETTE.shadow, alpha: 0.2 });
            g.ellipse(x, y, s * 1.3, s).fill(0xc9c6bb).stroke({ width: 1.5, color: 0x9e9a8c });
            g.ellipse(x - s * 0.3, y - s * 0.3, s * 0.6, s * 0.35).fill({ color: 0xffffff, alpha: 0.35 });
          }
        }
      }
    }
    // Tree shadows go down first so no canopy is darkened by its neighbour's shadow.
    for (const [x, y, size] of trees) g.ellipse(x + size * 0.35, y + size * 0.45, size * 1.05, size * 0.85).fill({ color: PALETTE.shadow, alpha: 0.22 });
    for (const [x, y, size, seed] of trees) this.drawTree(g, x, y, size, seed);
  }

  private drawTuft(g: Graphics, x: number, y: number, seed: number): void {
    const color = hash(seed + 5) < 0.5 ? PALETTE.tuft : PALETTE.lawnDark;
    for (let i = -1; i <= 1; i++) {
      const h = 6 + hash(seed + 6 + i) * 4;
      g.moveTo(x + i * 3, y).lineTo(x + i * 4.5, y - h).stroke({ width: 1.6, color, cap: "round" });
    }
  }

  private drawFlowers(g: Graphics, x: number, y: number, seed: number): void {
    const color = FLOWERS[Math.floor(hash(seed + 4) * FLOWERS.length)];
    const count = 3 + Math.floor(hash(seed + 5) * 4);
    for (let i = 0; i < count; i++) {
      const fx = x + (hash(seed + 10 + i) - 0.5) * 26;
      const fy = y + (hash(seed + 20 + i) - 0.5) * 20;
      g.moveTo(fx, fy + 2).lineTo(fx - 1, fy + 7).stroke({ width: 1.4, color: PALETTE.tuft, cap: "round" });
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2 + i;
        g.circle(fx + Math.cos(a) * 2.6, fy + Math.sin(a) * 2.6, 2.2).fill(color);
      }
      g.circle(fx, fy, 1.6).fill(color === PALETTE.gold || color === 0xf7d046 ? 0xe07b39 : 0xf7d046);
    }
  }

  private drawBush(g: Graphics, x: number, y: number, seed: number): void {
    const blobs = 3 + Math.floor(hash(seed + 4) * 2);
    const pts = Array.from({ length: blobs }, (_, i) => [x + (hash(seed + 10 + i) - 0.5) * 22, y + (hash(seed + 20 + i) - 0.5) * 12, 9 + hash(seed + 30 + i) * 5] as const);
    for (const [bx, by, r] of pts) g.circle(bx + 3, by + 5, r).fill({ color: PALETTE.shadow, alpha: 0.2 });
    for (const [bx, by, r] of pts) g.circle(bx, by, r).fill(0x5b9a4b).stroke({ width: 1.5, color: 0x3f7335 });
    for (const [bx, by, r] of pts) g.circle(bx - r * 0.3, by - r * 0.35, r * 0.45).fill({ color: 0x8cc475, alpha: 0.6 });
    if (hash(seed + 7) < 0.5) {
      const berry = hash(seed + 8) < 0.5 ? 0xe8615a : 0xffffff;
      for (let i = 0; i < 5; i++) g.circle(x + (hash(seed + 40 + i) - 0.5) * 24, y + (hash(seed + 50 + i) - 0.5) * 12, 1.8).fill(berry);
    }
  }

  private drawTree(g: Graphics, x: number, y: number, size: number, seed: number): void {
    const color = TREES[Math.floor(hash(seed + 9) * TREES.length)];
    const lobes = 6;
    g.circle(x, y, size * 0.72).fill(mix(color, 0x000000, 0.25));
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + hash(seed + 11);
      g.circle(x + Math.cos(a) * size * 0.45, y + Math.sin(a) * size * 0.45, size * 0.48).fill(mix(color, 0x000000, 0.18));
    }
    g.circle(x - size * 0.08, y - size * 0.1, size * 0.68).fill(color);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + hash(seed + 12);
      g.circle(x - size * 0.2 + Math.cos(a) * size * 0.25, y - size * 0.25 + Math.sin(a) * size * 0.25, size * 0.28).fill({ color: mix(color, 0xffffff, 0.25), alpha: 0.7 });
    }
    g.circle(x - size * 0.32, y - size * 0.36, size * 0.14).fill({ color: 0xffffff, alpha: 0.18 });
  }

  // ── Course ──

  private drawCourse(hole: Hole): void {
    const flat = (pts: Point[]) => pts.flat();
    const bounds = hole.bounds;
    const g = new Graphics();

    // Gravel path around the course.
    const path = new Graphics();
    path.poly(flat(bounds)).stroke({ width: (RAIL + PATH) * 2 + 4, color: PALETTE.pathDark, join: "round" });
    path.poly(flat(bounds)).stroke({ width: (RAIL + PATH) * 2, color: PALETTE.path, join: "round" });
    const [px0, py0, px1, py1] = bbox(bounds);
    const gravel = new Graphics();
    for (let y = py0 - RAIL - PATH; y < py1 + RAIL + PATH; y += 6) {
      for (let x = px0 - RAIL - PATH; x < px1 + RAIL + PATH; x += 6) {
        const r = hash(x * 19 + y * 23);
        if (r < 0.3) gravel.circle(x + r * 10, y + hash(x - y * 3) * 5, 0.8 + r * 2).fill({ color: r < 0.15 ? PALETTE.pathDark : 0xffffff, alpha: 0.7 });
      }
    }
    const gravelMask = new Graphics().poly(flat(bounds)).stroke({ width: (RAIL + PATH) * 2 - 2, color: 0xffffff, join: "round" });
    gravel.mask = gravelMask;
    this.course.addChild(path, gravelMask, gravel);

    // Shadow on the path, then the rail's side face and top. The fairway, drawn over it, hides the inner half.
    g.poly(shifted(bounds, 6, 10)).fill({ color: PALETTE.shadow, alpha: 0.2 }).stroke({ width: RAIL * 2 + 4, color: PALETTE.shadow, alpha: 0.2, join: "round" });
    g.poly(shifted(bounds, 0, RAIL_HEIGHT)).stroke({ width: RAIL * 2 + 3, color: PALETTE.woodEdge, join: "round" });
    g.poly(shifted(bounds, 0, RAIL_HEIGHT)).stroke({ width: RAIL * 2, color: PALETTE.woodDark, join: "round" });
    g.poly(flat(bounds)).stroke({ width: RAIL * 2 + 3, color: PALETTE.woodEdge, join: "round" });
    g.poly(flat(bounds)).stroke({ width: RAIL * 2, color: PALETTE.wood, join: "round" });
    g.poly(flat(bounds)).stroke({ width: RAIL + 6, color: PALETTE.woodLight, alpha: 0.45, join: "round" });
    g.poly(flat(bounds)).stroke({ width: RAIL - 2, color: PALETTE.wood, join: "round" });
    g.poly(flat(bounds)).fill(PALETTE.fairway);
    this.course.addChild(g);
    this.course.addChild(this.railPosts(bounds));

    // Carpet: mowing stripes and a fine speckle, clipped to the fairway.
    const [minX, minY, maxX, maxY] = bbox(bounds);
    const carpet = new Graphics();
    const span = maxY - minY;
    for (let x = minX - span; x < maxX; x += 64) {
      carpet.poly([x, maxY, x + 32, maxY, x + 32 + span, minY, x + span, minY]).fill(PALETTE.stripe);
    }
    for (let y = minY + 4; y < maxY; y += 9) {
      for (let x = minX + 4; x < maxX; x += 9) {
        const r = hash(x * 31 + y * 17);
        if (r < 0.2) carpet.rect(x + r * 30, y + hash(x + y) * 6, 1.6, 1.6).fill({ color: r < 0.1 ? PALETTE.speckLight : PALETTE.speckDark, alpha: 0.8 });
      }
    }
    this.course.addChild(this.clipped(carpet, bounds));

    // Zones may run under the rail, so they are clipped to the fairway along with the rails' shadow.
    const surface = new Container();
    for (const zone of hole.zones) {
      if (zone.type === "slope") surface.addChild(this.slope(zone.points, zone.force));
    }
    for (const zone of hole.zones) {
      const others = hole.zones.filter((z) => z !== zone && z.type === zone.type).map((z) => z.points);
      if (zone.type === "ice") surface.addChild(this.ice(zone.points, others));
      else if (zone.type === "boost") surface.addChild(this.boostPad(zone.points));
      else if (zone.type === "sand") surface.addChild(this.sand(zone.points, others));
      else if (zone.type === "water") surface.addChild(this.water(zone.points, others));
    }
    const inner = new Graphics();
    inner.poly(flat(bounds)).stroke({ width: 22, color: PALETTE.shadow, alpha: 0.07, join: "round" });
    inner.poly(flat(bounds)).stroke({ width: 10, color: PALETTE.shadow, alpha: 0.1, join: "round" });
    surface.addChild(inner);
    const surfaceMask = new Graphics().poly(flat(bounds)).fill(0xffffff);
    surface.mask = surfaceMask;
    this.course.addChild(surfaceMask, surface);

    // Tracks showing where moving obstacles go.
    const tracks = new Graphics();
    for (const mover of hole.movers ?? []) {
      if (mover.type === "spinner") {
        const r = mover.length + mover.width / 2;
        tracks.circle(...mover.center, r).fill({ color: PALETTE.shadow, alpha: 0.08 });
        dashedCircle(tracks, ...mover.center, r - 2, { width: 2, color: 0xffffff, alpha: 0.45 });
      } else {
        const [ax0, ay0, ax1, ay1] = bbox([...mover.points, ...mover.points.map(([x, y]) => [x + mover.path[0], y + mover.path[1]] as Point)]);
        tracks.roundRect(ax0 - 2, ay0 - 2, ax1 - ax0 + 4, ay1 - ay0 + 4, 6).fill({ color: PALETTE.shadow, alpha: 0.12 });
        const [bx0, by0, bx1, by1] = bbox(mover.points);
        const [cx, cy] = [(bx0 + bx1) / 2, (by0 + by1) / 2];
        tracks.moveTo(cx, cy).lineTo(cx + mover.path[0], cy + mover.path[1]).stroke({ width: 3, color: PALETTE.shadow, alpha: 0.18, cap: "round" });
      }
    }
    this.course.addChild(tracks);

    const blocks = new Graphics();
    for (const obstacle of hole.obstacles) blocks.poly(shifted(obstacle, 6, 9)).fill({ color: PALETTE.shadow, alpha: 0.25 });
    for (const obstacle of hole.obstacles) this.block(blocks, obstacle, PALETTE.wood, PALETTE.woodDark, PALETTE.woodLight);
    this.course.addChild(blocks);
    hole.obstacles.forEach((obstacle, i) => {
      const [x0, y0, x1, y1] = bbox(obstacle);
      if (Math.min(x1 - x0, y1 - y0) >= 70) this.course.addChild(this.planter(obstacle, i));
    });

    const marks = new Graphics();
    (hole.portals ?? []).forEach((portal, i) => {
      const color = PORTAL_COLORS[i % PORTAL_COLORS.length];
      for (const [x, y] of [portal.a, portal.b]) {
        const r = PORTAL_RADIUS + 4;
        marks.circle(x, y, r + 3).fill({ color: 0xffffff, alpha: 0.18 });
        marks.circle(x, y, r).fill(mix(color, 0xffffff, 0.35));
        marks.circle(x, y, r - 3).fill(color);
        marks.circle(x, y, r - 6).fill(mix(color, 0x000000, 0.55));
        marks.circle(x + 1.5, y + 2, r - 8).fill({ color: 0x000000, alpha: 0.35 });
      }
    });
    const [tx, ty] = hole.tee;
    marks.roundRect(tx - 18, ty - 18, 36, 36, 7).fill({ color: PALETTE.tee }).stroke({ width: 2, color: PALETTE.teeLine, alpha: 0.8 });
    marks.roundRect(tx - 13, ty - 13, 26, 26, 4).stroke({ width: 1.2, color: PALETTE.teeLine, alpha: 0.35 });
    const [cx, cy] = hole.cup;
    marks.circle(cx, cy, CUP_RADIUS + 6).fill({ color: 0xffffff, alpha: 0.18 });
    marks.circle(cx, cy, CUP_RADIUS + 2).fill({ color: PALETTE.speckLight });
    marks.circle(cx, cy, CUP_RADIUS).fill(0xf4f4ef);
    marks.circle(cx, cy, CUP_RADIUS - 1.6).fill(PALETTE.cup);
    marks.circle(cx + 1.5, cy + 2, CUP_RADIUS - 3.5).fill({ color: 0x000000, alpha: 0.35 });
    this.course.addChild(marks);
  }

  private clipped(content: Graphics, points: Point[]): Container {
    const c = new Container();
    const mask = new Graphics().poly(points.flat()).fill(0xffffff);
    content.mask = mask;
    c.addChild(mask, content);
    return c;
  }

  /** Round caps on the rail's corners, pushed outward so they never cover the playing surface. */
  private railPosts(points: Point[]): Graphics {
    const g = new Graphics();
    let area = 0;
    points.forEach(([x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length];
      area += x * ny - nx * y;
    });
    const out = area > 0 ? 1 : -1;
    const normal = (a: Point, b: Point): Point => {
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dx, dy) || 1;
      return [(dy / len) * out, (-dx / len) * out];
    };
    points.forEach((p, i) => {
      const prev = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      const [n1x, n1y] = normal(prev, p);
      const [n2x, n2y] = normal(p, next);
      // Only outward-pointing corners get a post; on inner corners it would sit on the carpet.
      const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
      if (cross * out < 0) return;
      const [bx, by] = [n1x + n2x, n1y + n2y];
      const blen = Math.hypot(bx, by) || 1;
      const k = RAIL / 2 / Math.max(0.5, (bx / blen) * n1x + (by / blen) * n1y);
      const [x, y] = [p[0] + (bx / blen) * k, p[1] + (by / blen) * k];
      const r = RAIL / 2 + 3;
      g.circle(x, y + RAIL_HEIGHT, r).fill(PALETTE.woodEdge);
      g.rect(x - r, y, r * 2, RAIL_HEIGHT).fill(PALETTE.woodDark);
      g.circle(x, y, r).fill(PALETTE.woodLight).stroke({ width: 1.5, color: PALETTE.woodEdge });
      g.circle(x, y, r * 0.45).fill(PALETTE.wood);
      g.circle(x - 1, y - 1, r * 0.2).fill({ color: 0xffffff, alpha: 0.5 });
    });
    return g;
  }

  /** A raised block whose footprint is `points`; its top is lifted by `BLOCK_HEIGHT`. */
  private block(g: Graphics, points: Point[], top: number, side: number, light: number, dx = 0, dy = 0): void {
    for (let k = 0; k < BLOCK_HEIGHT; k += 1.5) g.poly(shifted(points, dx, dy - k)).fill(side);
    g.poly(shifted(points, dx, dy)).stroke({ width: 1.5, color: PALETTE.woodEdge, alpha: 0.6, join: "round" });
    g.poly(shifted(points, dx, dy - BLOCK_HEIGHT)).fill(top).stroke({ width: 1.5, color: mix(side, 0x000000, 0.3), join: "round" });
    const [x0, y0, x1, y1] = bbox(points);
    if (points.length === 4 && Math.min(x1 - x0, y1 - y0) < 70) {
      // Grain along the plank's length.
      const along = x1 - x0 > y1 - y0;
      const top = y0 + dy - BLOCK_HEIGHT;
      for (const f of [0.33, 0.66]) {
        if (along) g.moveTo(x0 + dx + 5, top + (y1 - y0) * f).lineTo(x1 + dx - 5, top + (y1 - y0) * f);
        else g.moveTo(x0 + dx + (x1 - x0) * f, top + 5).lineTo(x0 + dx + (x1 - x0) * f, top + y1 - y0 - 5);
        g.stroke({ width: 1, color: side, alpha: 0.35 });
      }
    }
    if (x1 - x0 > 8 && y1 - y0 > 8) {
      g.poly(shifted(points, dx, dy - BLOCK_HEIGHT))
        .stroke({ width: 3, color: light, alpha: 0.55, join: "round", alignment: 1 });
    }
  }

  /** Large blocks are planted: a bed of hedge and flowers inside the wooden top. */
  private planter(points: Point[], seed: number): Container {
    const top = points.map(([x, y]) => [x, y - BLOCK_HEIGHT] as Point);
    const g = new Graphics();
    g.poly(top.flat()).fill(0x4f8a43);
    const [x0, y0, x1, y1] = bbox(top);
    for (let y = y0; y < y1; y += 5) {
      for (let x = x0; x < x1; x += 5) {
        const r = hash(x * 11 + y * 29 + seed);
        if (r < 0.35) g.circle(x + r * 8, y + hash(x + y) * 4, 1.4).fill({ color: r < 0.18 ? 0x3f7335 : 0x67a457, alpha: 0.9 });
      }
    }
    const step = 30;
    for (let y = y0 + step / 2; y < y1; y += step) {
      for (let x = x0 + step / 2; x < x1; x += step) {
        const s = seed * 977 + Math.round(x) * 13 + Math.round(y) * 7;
        if (!pointInPolygon(x, y, top) || distToPolygon(x, y, top) < 18) continue;
        if (hash(s) < 0.4) this.drawBush(g, x, y, s);
        else if (hash(s) < 0.8) this.drawFlowers(g, x, y, s);
      }
    }
    g.poly(top.flat()).stroke({ width: 18, color: PALETTE.shadow, alpha: 0.2, join: "round" });
    const c = this.clipped(g, top);
    // Wooden edging around the bed.
    c.addChild(new Graphics().poly(top.flat()).stroke({ width: 8, color: PALETTE.wood, join: "round", alignment: 1 }).poly(top.flat()).stroke({ width: 1.5, color: PALETTE.woodEdge, join: "round" }));
    return c;
  }

  private slope(points: Point[], force: Point): Container {
    const g = new Graphics();
    const len = Math.hypot(force[0], force[1]) || 1;
    const [ux, uy] = [force[0] / len, force[1] / len];
    const [px, py] = [-uy, ux];
    const [x0, y0, x1, y1] = bbox(points);
    const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + 4;
    // Lit on the high side, shaded toward the low side the ball rolls to.
    const bands = 24;
    for (let i = 0; i < bands; i++) {
      const [t0, t1] = [-reach + (2 * reach * i) / bands, -reach + (2 * reach * (i + 1)) / bands];
      const k = i / (bands - 1);
      const quad = [t0, t1, t1, t0].flatMap((t, j) => {
        const s = j === 0 || j === 1 ? -reach : reach;
        return [mx + ux * t + px * s, my + uy * t + py * s];
      });
      g.poly(quad).fill(k < 0.5 ? { color: 0xffffff, alpha: (0.5 - k) * 0.22 } : { color: PALETTE.shadow, alpha: (k - 0.5) * 0.22 });
    }
    for (let y = y0 + 22; y < y1; y += 44) {
      for (let x = x0 + 22; x < x1; x += 44) {
        const s = 8;
        const chevron = (ox: number, oy: number, color: number, alpha: number) =>
          g
            .moveTo(x + ox - ux * s + px * s, y + oy - uy * s + py * s)
            .lineTo(x + ox + ux * s * 0.4, y + oy + uy * s * 0.4)
            .lineTo(x + ox - ux * s - px * s, y + oy - uy * s - py * s)
            .stroke({ width: 3, color, alpha, cap: "round", join: "round" });
        chevron(1, 2, PALETTE.shadow, 0.18);
        chevron(0, 0, 0xffffff, 0.45);
      }
    }
    const c = this.clipped(g, points);
    const edge = new Graphics().poly(points.flat()).stroke({ width: 1.5, color: 0xffffff, alpha: 0.25 });
    c.addChild(edge);
    return c;
  }

  private ice(points: Point[], others: Point[][]): Container {
    const base = new Graphics().poly(points.flat()).fill(PALETTE.ice);
    const g = new Graphics();
    const [x0, y0, x1, y1] = bbox(points);
    // Polished streaks, frosty specks and a cold rim where it meets the carpet.
    for (let x = x0 - (y1 - y0); x < x1; x += 46) {
      const k = hash(x);
      g.moveTo(x, y1).lineTo(x + (y1 - y0), y0).stroke({ width: 6 + k * 10, color: 0xffffff, alpha: 0.25 + k * 0.2 });
    }
    for (let y = y0 + 4; y < y1; y += 9) {
      for (let x = x0 + 4; x < x1; x += 9) {
        const r = hash(x * 29 + y * 11);
        if (r < 0.12) g.circle(x + r * 30, y + hash(x + y * 5) * 6, 0.8 + r * 6).fill({ color: r < 0.06 ? 0xffffff : PALETTE.iceDark, alpha: 0.8 });
      }
    }
    const edges = openEdges(points, others);
    strokeEdges(g, edges, { width: 10, color: PALETTE.iceDark, alpha: 0.45 });
    strokeEdges(g, edges, { width: 3, color: 0xffffff, alpha: 0.8 });
    const c = new Container();
    c.addChild(base, this.clipped(g, points));
    return c;
  }

  private boostPad(points: Point[]): Container {
    const g = new Graphics();
    g.poly(points.flat()).fill(PALETTE.boost);
    g.poly(points.flat()).stroke({ width: 8, color: PALETTE.boostDark, alpha: 0.6, join: "round" });
    g.poly(points.flat()).stroke({ width: 2, color: PALETTE.boostLight, alpha: 0.9, join: "round" });
    return this.clipped(g, points);
  }

  private sand(points: Point[], others: Point[][]): Container {
    const base = new Graphics().poly(points.flat()).fill(PALETTE.sand);
    const g = new Graphics();
    const [x0, y0, x1, y1] = bbox(points);
    // Raked lines, a lip shaded where the carpet drops into the bunker, and grains.
    for (let y = y0 + 7; y < y1; y += 8) {
      g.moveTo(x0, y);
      for (let x = x0; x <= x1 + 12; x += 12) g.lineTo(x, y + Math.sin(x * 0.05 + y * 0.3) * 1.6);
      g.stroke({ width: 1.2, color: PALETTE.sandDark, alpha: 0.55 });
    }
    for (let y = y0 + 3; y < y1; y += 7) {
      for (let x = x0 + 3; x < x1; x += 7) {
        const r = hash(x * 13 + y * 7);
        if (r < 0.25) g.circle(x + r * 12, y + hash(x - y) * 5, 0.9).fill({ color: r < 0.12 ? 0xffffff : PALETTE.sandDark, alpha: 0.8 });
      }
    }
    const edges = openEdges(points, others);
    strokeEdges(g, edges, { width: 12, color: PALETTE.sandDark, alpha: 0.35 });
    strokeEdges(g, edges, { width: 5, color: PALETTE.shadow, alpha: 0.12 });
    const c = new Container();
    c.addChild(base, this.clipped(g, points));
    return c;
  }

  private water(points: Point[], others: Point[][]): Container {
    const base = new Graphics().poly(points.flat()).fill(PALETTE.water);
    const g = new Graphics();
    const [x0, y0, x1, y1] = bbox(points);
    // Deeper toward the middle; foam where it meets the carpet.
    const edges = openEdges(points, others);
    strokeEdges(g, edges, { width: 26, color: 0xffffff, alpha: 0.12 });
    const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
    g.ellipse(mx, my, (x1 - x0) * 0.32, (y1 - y0) * 0.32).fill({ color: PALETTE.waterDeep, alpha: 0.35 });
    for (let y = y0 + 14; y < y1; y += 22) {
      for (let x = x0 + ((y / 22) % 2) * 18 + 6; x < x1 - 10; x += 36) {
        g.moveTo(x, y).quadraticCurveTo(x + 6, y - 4, x + 12, y).stroke({ width: 1.6, color: PALETTE.waterLight, alpha: 0.5, cap: "round" });
      }
    }
    strokeEdges(g, edges, { width: 7, color: PALETTE.waterLight, alpha: 0.7 });
    const c = new Container();
    c.addChild(base, this.clipped(g, points));
    return c;
  }

  /** Spots where the water catches the light; they twinkle in `drawProps`. */
  private waterGlints(hole: Hole): Glint[] {
    const glints: Glint[] = [];
    hole.zones.forEach((zone, z) => {
      if (zone.type !== "water") return;
      const [x0, y0, x1, y1] = bbox(zone.points);
      const want = Math.max(2, Math.round(((x1 - x0) * (y1 - y0)) / 2500));
      for (let i = 0, tries = 0; i < want && tries < want * 8; tries++) {
        const x = x0 + 10 + hash(z * 1000 + tries) * (x1 - x0 - 20);
        const y = y0 + 8 + hash(z * 1000 + tries + 500) * (y1 - y0 - 16);
        if (!pointInPolygon(x, y, zone.points) || distToPolygon(x, y, zone.points) < 9) continue;
        glints.push({ x, y, phase: hash(z * 77 + tries) * Math.PI * 2 });
        i++;
      }
    });
    return glints;
  }

  // ── Per frame ──

  portalHit(index: number): void {
    this.portalFlash[index] = 0.35;
  }

  bumperHit(index: number): void {
    this.bumperFlash[index] = 0.25;
  }

  /** Draws water glints, bumpers and moving obstacles at course-clock substep `clock`. */
  private drawProps(dt: number, hole: Hole, clock: number): void {
    const g = this.props;
    g.clear();
    for (const { x, y, phase } of this.glints) {
      const k = Math.max(0, Math.sin(this.time * 1.6 + phase));
      if (k <= 0.05) continue;
      const w = 4 + k * 4;
      g.moveTo(x - w, y).quadraticCurveTo(x, y - 3 * k, x + w, y).stroke({ width: 2, color: 0xffffff, alpha: k * 0.8, cap: "round" });
    }

    // Chevrons on boost pads stream toward where they fling the ball.
    for (const zone of hole.zones) {
      if (zone.type !== "boost") continue;
      const len = Math.hypot(...zone.velocity) || 1;
      const [ux, uy] = [zone.velocity[0] / len, zone.velocity[1] / len];
      const [px, py] = [-uy, ux];
      const along = zone.points.map(([x, y]) => x * ux + y * uy);
      const across = zone.points.map(([x, y]) => x * px + y * py);
      const [a0, a1, c0, c1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
      const step = 20;
      const shift = (this.time * 50) % step;
      for (let a = a0 + shift; a < a1; a += step) {
        const fade = Math.min(1, (a - a0) / 12, (a1 - a) / 12);
        for (let c = c0 + 14; c < c1 - 6; c += 26) {
          const [x, y] = [ux * a + px * c, uy * a + py * c];
          if (!pointInPolygon(x, y, zone.points) || distToPolygon(x, y, zone.points) < 7) continue;
          g.moveTo(x - ux * 6 + px * 7, y - uy * 6 + py * 7)
            .lineTo(x, y)
            .lineTo(x - ux * 6 - px * 7, y - uy * 6 - py * 7)
            .stroke({ width: 3.5, color: PALETTE.boostLight, alpha: 0.9 * fade, cap: "round", join: "round" });
        }
      }
    }

    // Portals swirl; a ball going through makes both ends flash.
    (hole.portals ?? []).forEach((portal, i) => {
      const flash = Math.max(0, (this.portalFlash[i] ?? 0) - dt);
      this.portalFlash[i] = flash;
      const color = mix(PORTAL_COLORS[i % PORTAL_COLORS.length], 0xffffff, 0.45);
      for (const [x, y] of [portal.a, portal.b]) {
        if (flash > 0) g.circle(x, y, PORTAL_RADIUS + 4 + 14 * (1 - flash / 0.35)).stroke({ width: 3, color: 0xffffff, alpha: flash * 2 });
        for (let k = 0; k < 3; k++) {
          const r = PORTAL_RADIUS - 4 - k * 3.2;
          const start = this.time * (2.4 + k * 0.8) + (k * Math.PI * 2) / 3;
          g.moveTo(x + Math.cos(start) * r, y + Math.sin(start) * r)
            .arc(x, y, r, start, start + 2.2)
            .stroke({ width: 1.8, color, alpha: 0.75 - k * 0.15, cap: "round" });
        }
      }
    });

    (hole.bumpers ?? []).forEach(({ center: [x, y], radius }, i) => {
      const flash = Math.max(0, (this.bumperFlash[i] ?? 0) - dt);
      this.bumperFlash[i] = flash;
      const r = radius * (1 + flash * 0.6);
      g.circle(x + 4, y + 6, radius).fill({ color: PALETTE.shadow, alpha: 0.28 });
      if (flash > 0) g.circle(x, y, r + 8 * (flash / 0.25)).fill({ color: 0xffffff, alpha: flash * 2 });
      g.circle(x, y + 3, r).fill(PALETTE.bumperDark);
      g.circle(x, y, r).fill(flash > 0 ? 0xffffff : PALETTE.bumperRim).stroke({ width: 1.5, color: PALETTE.bumperDark });
      g.circle(x, y, r - 4).fill(PALETTE.bumper);
      g.circle(x, y - 1.5, r - 7).fill(mix(PALETTE.bumper, 0xffffff, 0.25));
      g.circle(x, y - 1.5, r * 0.32).fill({ color: 0xffffff, alpha: 0.6 + flash * 1.6 });
      g.ellipse(x - r * 0.35, y - r * 0.45, r * 0.22, r * 0.12).fill({ color: 0xffffff, alpha: 0.7 });
    });

    for (const mover of hole.movers ?? []) {
      const pose = moverPose(mover, clock);
      if (mover.type === "slider" && pose.type === "slider") {
        g.poly(shifted(mover.points, pose.dx + 6, pose.dy + 9)).fill({ color: PALETTE.shadow, alpha: 0.25 });
        this.block(g, mover.points, PALETTE.slider, PALETTE.sliderDark, PALETTE.sliderLight, pose.dx, pose.dy);
        const [x0, y0, x1, y1] = bbox(mover.points);
        const [cx, cy] = [(x0 + x1) / 2 + pose.dx, (y0 + y1) / 2 + pose.dy - BLOCK_HEIGHT];
        const len = Math.hypot(...mover.path) || 1;
        const [ux, uy] = [mover.path[0] / len, mover.path[1] / len];
        // Double arrow along the track.
        for (const s of [1, -1]) {
          const [tx, ty] = [cx + ux * 9 * s, cy + uy * 9 * s];
          g.moveTo(tx - ux * 5 * s + uy * 4, ty - uy * 5 * s - ux * 4)
            .lineTo(tx, ty)
            .lineTo(tx - ux * 5 * s - uy * 4, ty - uy * 5 * s + ux * 4)
            .stroke({ width: 2, color: PALETTE.sliderDark, cap: "round", join: "round" });
        }
      } else if (mover.type === "spinner" && pose.type === "spinner") {
        const [cx, cy] = mover.center;
        const w = mover.width;
        for (const [ux, uy] of pose.arms) {
          const [tx, ty] = [cx + ux * mover.length, cy + uy * mover.length];
          g.moveTo(cx + 5, cy + 8).lineTo(tx + 5, ty + 8).stroke({ width: w, color: PALETTE.shadow, alpha: 0.25, cap: "round" });
        }
        for (const [ux, uy] of pose.arms) {
          const [tx, ty] = [cx + ux * mover.length, cy + uy * mover.length];
          g.moveTo(cx, cy + 3).lineTo(tx, ty + 3).stroke({ width: w, color: PALETTE.spinnerDark, cap: "round" });
        }
        for (const [ux, uy] of pose.arms) {
          const [tx, ty] = [cx + ux * mover.length, cy + uy * mover.length];
          g.moveTo(cx, cy).lineTo(tx, ty).stroke({ width: w, color: PALETTE.spinner, cap: "round" });
          g.moveTo(cx + ux * mover.length * 0.25 - uy * w * 0.18, cy + uy * mover.length * 0.25 + ux * w * 0.18 - w * 0.08)
            .lineTo(cx + ux * mover.length * 0.92 - uy * w * 0.18, cy + uy * mover.length * 0.92 + ux * w * 0.18 - w * 0.08)
            .stroke({ width: w * 0.22, color: 0xffffff, alpha: 0.55, cap: "round" });
          g.circle(tx, ty, w * 0.16).fill({ color: 0xffffff, alpha: 0.7 });
        }
        g.circle(cx, cy + 2, w * 0.85).fill(PALETTE.woodEdge);
        g.circle(cx, cy, w * 0.85).fill(PALETTE.metal).stroke({ width: 1.5, color: 0x8a9096 });
        g.circle(cx, cy, w * 0.35).fill(0x8a9096);
        g.circle(cx - w * 0.25, cy - w * 0.25, w * 0.18).fill({ color: 0xffffff, alpha: 0.8 });
      }
    }
  }

  addTrailPoint(id: string, x: number, y: number): void {
    const trail = this.trails.get(id) ?? [];
    trail.push([x, y]);
    if (trail.length > 14) trail.shift();
    this.trails.set(id, trail);
  }

  clearTrail(id: string): void {
    this.trails.delete(id);
  }

  clearTrails(): void {
    this.trails.clear();
  }

  burst(x: number, y: number, color: string): void {
    const c = Number.parseInt(color.slice(1), 16);
    const colors = [c, PALETTE.gold, 0xffffff, PALETTE.flag, 0x3f8fd2, 0x7cc46f];
    for (let i = 0; i < 60; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 240;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 90,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.7,
        color: colors[i % colors.length],
        size: 2.5 + Math.random() * 3,
        spin: (Math.random() - 0.5) * 16,
        angle: Math.random() * Math.PI,
      });
    }
    this.rings.push({ x, y, t: 0 }, { x, y, t: -0.12 });
  }

  splash(x: number, y: number): void {
    this.rings.push({ x, y, t: 0 }, { x, y, t: -0.15 }, { x, y, t: -0.3 });
    for (let i = 0; i < 18; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 90;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life: 0,
        maxLife: 0.4 + Math.random() * 0.3,
        color: i % 3 ? 0xffffff : PALETTE.waterLight,
        size: 1.5 + Math.random() * 2,
        spin: 0,
        angle: -1,
      });
    }
  }

  private drawBall(g: Graphics, ball: BallView): void {
    const color = Number.parseInt(ball.color.slice(1), 16);
    const r = BALL_RADIUS;
    const { x, y } = ball;
    g.ellipse(x + 2.5, y + 3.5, r * 1.05, r * 0.85).fill({ color: PALETTE.shadow, alpha: 0.3 });
    g.circle(x, y, r).fill(mix(color, 0x000000, 0.28));
    g.circle(x - 0.7, y - 0.9, r * 0.86).fill(color);
    g.circle(x - 1.8, y - 2.1, r * 0.5).fill({ color: mix(color, 0xffffff, 0.45), alpha: 0.75 });
    for (const [dx, dy] of [[2.4, 1.6], [0.4, 3.2], [3.4, -1], [-2.6, 2.4]]) g.circle(x + dx, y + dy, 0.7).fill({ color: 0x000000, alpha: 0.12 });
    g.circle(x - 2.6, y - 2.9, 1.7).fill({ color: 0xffffff, alpha: 0.95 });
    g.circle(x, y, r).stroke({ width: 1.2, color: PALETTE.ink, alpha: 0.45 });
  }

  /** `clock` is the course-clock substep that moving obstacles are drawn at. */
  draw(dt: number, balls: BallView[], aim: { from: Point; to: Point } | null, clock: number): void {
    this.time += dt;
    const g = this.dynamic;
    g.clear();
    if (!this.hole) return;
    this.drawProps(dt, this.hole, clock);

    for (const ring of this.rings) {
      ring.t += dt;
      if (ring.t < 0) continue;
      const k = ring.t / 0.8;
      g.circle(ring.x, ring.y, 6 + k * 28).stroke({ width: 2.5 * (1 - k) + 0.5, color: 0xffffff, alpha: Math.max(0, 1 - k) });
    }
    this.rings = this.rings.filter((r) => r.t < 0.8);

    for (const [id, trail] of this.trails) {
      const ball = balls.find((b) => b.id === id);
      if (!ball) continue;
      const color = mix(Number.parseInt(ball.color.slice(1), 16), 0xffffff, 0.35);
      trail.forEach(([x, y], i) => {
        g.circle(x, y, BALL_RADIUS * (0.25 + (i / trail.length) * 0.55)).fill({ color, alpha: (i / trail.length) * 0.4 });
      });
    }

    if (aim) {
      const [fx, fy] = aim.from;
      let dx = aim.to[0] - fx;
      let dy = aim.to[1] - fy;
      const len = Math.hypot(dx, dy);
      if (len > MAX_AIM_DISTANCE) {
        dx = (dx / len) * MAX_AIM_DISTANCE;
        dy = (dy / len) * MAX_AIM_DISTANCE;
      }
      const reach = Math.hypot(dx, dy);
      const power = reach / MAX_AIM_DISTANCE;
      const tip = power >= 1 ? PALETTE.flag : power > 0.6 ? PALETTE.gold : 0xffffff;
      const steps = Math.max(2, Math.floor(reach / 12));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        g.circle(fx + dx * t + 1, fy + dy * t + 1.5, 2 + t * 1.3).fill({ color: PALETTE.shadow, alpha: 0.2 });
        g.circle(fx + dx * t, fy + dy * t, 2 + t * 1.3).fill({ color: mix(0xffffff, tip, t), alpha: 0.95 });
      }
      if (reach > 1) {
        const [ux, uy] = [dx / reach, dy / reach];
        const [ex, ey] = [fx + dx, fy + dy];
        const head = [ex + ux * 6, ey + uy * 6, ex - ux * 6 + uy * 6, ey - uy * 6 - ux * 6, ex - ux * 6 - uy * 6, ey - uy * 6 + ux * 6];
        g.poly(head.map((v, i) => v + (i % 2 ? 1.5 : 1))).fill({ color: PALETTE.shadow, alpha: 0.2 });
        g.poly(head).fill(tip).stroke({ width: 1.5, color: PALETTE.ink, alpha: 0.4, join: "round" });
      }
    }

    const seen = new Set<string>();
    // Balls further down the screen are drawn last so they overlap the ones behind.
    for (const ball of [...balls].sort((a, b) => a.y - b.y)) {
      seen.add(ball.id);
      if (ball.isTurn) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
        g.circle(ball.x, ball.y, BALL_RADIUS + 6 + pulse * 3).fill({ color: 0xffffff, alpha: 0.12 + pulse * 0.1 });
        g.circle(ball.x, ball.y, BALL_RADIUS + 6 + pulse * 3).stroke({ width: 2, color: 0xffffff, alpha: 0.6 + pulse * 0.4 });
      }
      this.drawBall(g, ball);

      let label = this.labelCache.get(ball.id);
      if (!label) {
        label = new Text({
          text: ball.name,
          style: {
            fontFamily: "Nunito, Segoe UI, sans-serif",
            fontSize: 13,
            fontWeight: "800",
            fill: PALETTE.ink,
            stroke: { color: 0xffffff, width: 3.5, join: "round" },
          },
          resolution: 3,
        });
        label.anchor.set(0.5, 1);
        this.labels.addChild(label);
        this.labelCache.set(ball.id, label);
      }
      label.text = ball.name;
      label.visible = true;
      label.alpha = ball.isTurn || ball.isMe ? 1 : 0.7;
      label.position.set(ball.x, ball.y - BALL_RADIUS - (ball.isTurn ? 10 : 5));
    }
    for (const [id, label] of this.labelCache) if (!seen.has(id)) label.visible = false;

    for (const p of this.particles) {
      p.life += dt;
      p.vy += 260 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (p.angle < 0) {
        g.circle(p.x, p.y, p.size).fill({ color: p.color, alpha });
      } else {
        // Confetti: a spinning paper strip.
        p.angle += p.spin * dt;
        const [c, s] = [Math.cos(p.angle) * p.size, Math.sin(p.angle) * p.size];
        const flip = Math.abs(Math.cos(p.angle * 1.7)) * 0.5 + 0.2;
        g.poly([p.x + c - s * flip, p.y + s + c * flip, p.x - c - s * flip, p.y - s + c * flip, p.x - c + s * flip, p.y - s - c * flip, p.x + c + s * flip, p.y + s - c * flip]).fill({ color: p.color, alpha });
      }
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);

    this.drawFlag(this.hole.cup);
  }

  /** The pin: shadow on the carpet, pole and a pennant rippling in the breeze. */
  private drawFlag([cx, cy]: Point): void {
    const f = this.flag.clear();
    const h = 50;
    const t = this.time;
    f.moveTo(cx, cy).lineTo(cx + 26, cy + 14).stroke({ width: 3, color: PALETTE.shadow, alpha: 0.22, cap: "round" });
    f.poly([cx + 20, cy + 11, cx + 34, cy + 13, cx + 26, cy + 16]).fill({ color: PALETTE.shadow, alpha: 0.15 });
    f.moveTo(cx + 1.2, cy).lineTo(cx + 1.2, cy - h).stroke({ width: 3.5, color: 0x8a9096, cap: "round" });
    f.moveTo(cx, cy).lineTo(cx, cy - h).stroke({ width: 2.5, color: 0xf7f7f2, cap: "round" });
    const segs = 8;
    const length = 28;
    const top: number[] = [];
    const bottom: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const wave = Math.sin(t * 4 - u * 5) * 2.6 * u;
      const droop = u * 3;
      const height = 16 * (1 - u * 0.75);
      top.push(cx + u * length, cy - h + 1 + wave + droop);
      bottom.unshift(cx + u * length, cy - h + 1 + height + wave + droop);
    }
    f.poly([...top, ...bottom]).fill(PALETTE.flag).stroke({ width: 1.2, color: PALETTE.flagDark, join: "round" });
    for (let i = 1; i < segs; i += 2) {
      const u = i / segs;
      const shade = Math.sin(t * 4 - u * 5);
      if (shade < 0) continue;
      const x = cx + u * length;
      const y = cy - h + 1 + Math.sin(t * 4 - u * 5) * 2.6 * u + u * 3;
      f.moveTo(x, y + 2).lineTo(x, y + 16 * (1 - u * 0.75) - 2).stroke({ width: 2, color: 0xffffff, alpha: shade * 0.25, cap: "round" });
    }
    f.circle(cx, cy - h - 1.5, 3).fill(PALETTE.gold).stroke({ width: 1, color: PALETTE.sliderDark });
  }
}

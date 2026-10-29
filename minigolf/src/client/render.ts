import { Application, Container, Graphics, Text } from "pixi.js";
import { type Hole, type Point, holeExtent } from "../shared/hole";
import { BALL_RADIUS, CUP_RADIUS, MAX_AIM_DISTANCE } from "../shared/physics";

export const PALETTE = {
  page: 0xf6f1e7,
  shadow: 0xe4dac8,
  fairway: 0xa8c99a,
  stripe: 0xb2d1a4,
  wood: 0xc9935f,
  woodDark: 0xa8744a,
  woodLight: 0xdcae7e,
  sand: 0xeedcae,
  sandDot: 0xdcc48d,
  water: 0x8fc6d6,
  waterLight: 0xbfe0ea,
  slope: 0x97bd89,
  slopeArrow: 0x86ad78,
  tee: 0xd4e5c8,
  cup: 0x3d4a3a,
  flag: 0xe8615a,
  ink: 0x3b3b48,
};

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
}

interface Ring {
  x: number;
  y: number;
  t: number;
}

const HUD_LEFT = 230;
const HUD_TOP = 70;
const HUD_BOTTOM = 60;

export class Renderer {
  readonly app = new Application();
  private world = new Container();
  private course = new Container();
  private dynamic = new Graphics();
  private flag = new Graphics();
  private labels = new Container();
  private labelCache = new Map<string, Text>();
  private hole: Hole | null = null;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private trails = new Map<string, Point[]>();
  private time = 0;

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      background: PALETTE.page,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    parent.appendChild(this.app.canvas);
    this.world.addChild(this.course, this.dynamic, this.flag, this.labels);
    this.app.stage.addChild(this.world);
    this.app.renderer.on("resize", () => this.fit());
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  setHole(hole: Hole | null): void {
    if (hole === this.hole) return;
    this.hole = hole;
    this.course.removeChildren().forEach((c) => c.destroy());
    this.flag.clear();
    this.trails.clear();
    this.particles = [];
    this.rings = [];
    if (!hole) return;
    this.drawCourse(hole);
    this.fit();
  }

  private fit(): void {
    if (!this.hole) return;
    const { minX, minY, maxX, maxY } = holeExtent(this.hole);
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
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const rect = this.app.canvas.getBoundingClientRect();
    const s = this.world.scale.x;
    return [(clientX - rect.left - this.world.position.x) / s, (clientY - rect.top - this.world.position.y) / s];
  }

  private drawCourse(hole: Hole): void {
    const flat = (pts: Point[]) => pts.flat();
    const g = new Graphics();

    // Soft drop shadow and wooden rim around the fairway.
    g.poly(flat(hole.bounds.map(([x, y]) => [x + 6, y + 9] as Point))).stroke({ width: 30, color: PALETTE.shadow, join: "round" });
    g.poly(flat(hole.bounds.map(([x, y]) => [x + 6, y + 9] as Point))).fill(PALETTE.shadow);
    g.poly(flat(hole.bounds)).stroke({ width: 28, color: PALETTE.wood, join: "round" });
    g.poly(flat(hole.bounds)).stroke({ width: 4, color: PALETTE.woodDark, join: "round", alignment: 1 });
    g.poly(flat(hole.bounds)).fill(PALETTE.fairway);
    this.course.addChild(g);

    // Mowing stripes, clipped to the fairway.
    const { minX, minY, maxX, maxY } = holeExtent(hole);
    const stripes = new Graphics();
    for (let x = minX - (maxY - minY); x < maxX; x += 56) {
      stripes.poly([x, maxY, x + 28, maxY, x + 28 + (maxY - minY), minY, x + (maxY - minY), minY]).fill(PALETTE.stripe);
    }
    const mask = new Graphics().poly(flat(hole.bounds)).fill(0xffffff);
    stripes.mask = mask;
    this.course.addChild(mask, stripes);

    const zones = new Graphics();
    for (const zone of hole.zones) {
      if (zone.type === "slope") {
        zones.poly(flat(zone.points)).fill({ color: PALETTE.slope, alpha: 0.85 });
      }
    }
    this.course.addChild(zones);

    for (const zone of hole.zones) {
      if (zone.type === "slope") this.course.addChild(this.slopeArrows(zone.points, zone.force));
    }

    const hazards = new Graphics();
    for (const zone of hole.zones) {
      if (zone.type === "sand") {
        hazards.poly(flat(zone.points)).fill(PALETTE.sand).stroke({ width: 3, color: PALETTE.sandDot, alpha: 0.6 });
      } else if (zone.type === "water") {
        hazards.poly(flat(zone.points)).fill(PALETTE.water).stroke({ width: 3, color: PALETTE.waterLight });
      }
    }
    this.course.addChild(hazards);

    const texture = new Graphics();
    for (const zone of hole.zones) {
      if (zone.type === "slope") continue;
      const zmask = new Graphics().poly(flat(zone.points)).fill(0xffffff);
      const pattern = new Graphics();
      const xs = zone.points.map((p) => p[0]);
      const ys = zone.points.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      if (zone.type === "sand") {
        for (let y = y0 + 6; y < y1; y += 14) {
          for (let x = x0 + ((y / 14) % 2) * 7 + 4; x < x1; x += 14) pattern.circle(x, y, 1.4).fill(PALETTE.sandDot);
        }
      } else {
        for (let y = y0 + 14; y < y1; y += 22) {
          for (let x = x0 + ((y / 22) % 2) * 18 + 6; x < x1 - 10; x += 36) {
            pattern.moveTo(x, y).quadraticCurveTo(x + 6, y - 4, x + 12, y).stroke({ width: 2, color: PALETTE.waterLight, cap: "round" });
          }
        }
      }
      pattern.mask = zmask;
      texture.addChild(zmask, pattern);
    }
    this.course.addChild(texture);

    const blocks = new Graphics();
    for (const obstacle of hole.obstacles) {
      blocks.poly(flat(obstacle.map(([x, y]) => [x + 4, y + 6] as Point))).fill({ color: 0x5d7a52, alpha: 0.25 });
    }
    for (const obstacle of hole.obstacles) {
      blocks.poly(flat(obstacle)).fill(PALETTE.wood).stroke({ width: 3, color: PALETTE.woodDark, join: "round", alignment: 1 });
    }
    this.course.addChild(blocks);

    const marks = new Graphics();
    const [tx, ty] = hole.tee;
    marks.roundRect(tx - 16, ty - 16, 32, 32, 8).fill({ color: PALETTE.tee, alpha: 0.9 });
    const [cx, cy] = hole.cup;
    marks.circle(cx, cy, CUP_RADIUS + 3).fill({ color: 0xffffff, alpha: 0.35 });
    marks.circle(cx, cy, CUP_RADIUS).fill(PALETTE.cup);
    marks.circle(cx, cy - 2, CUP_RADIUS - 3).fill({ color: 0x000000, alpha: 0.25 });
    this.course.addChild(marks);
  }

  private slopeArrows(points: Point[], force: Point): Container {
    const c = new Container();
    const mask = new Graphics().poly(points.flat()).fill(0xffffff);
    const g = new Graphics();
    const len = Math.hypot(force[0], force[1]) || 1;
    const [ux, uy] = [force[0] / len, force[1] / len];
    const [px, py] = [-uy, ux];
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    for (let y = Math.min(...ys) + 20; y < Math.max(...ys); y += 44) {
      for (let x = Math.min(...xs) + 20; x < Math.max(...xs); x += 44) {
        const s = 9;
        g.moveTo(x - ux * s + px * s, y - uy * s + py * s)
          .lineTo(x + ux * s * 0.4, y + uy * s * 0.4)
          .lineTo(x - ux * s - px * s, y - uy * s - py * s)
          .stroke({ width: 3, color: PALETTE.slopeArrow, cap: "round", join: "round" });
      }
    }
    g.mask = mask;
    c.addChild(mask, g);
    return c;
  }

  addTrailPoint(id: string, x: number, y: number): void {
    const trail = this.trails.get(id) ?? [];
    trail.push([x, y]);
    if (trail.length > 14) trail.shift();
    this.trails.set(id, trail);
  }

  clearTrails(): void {
    this.trails.clear();
  }

  burst(x: number, y: number, color: string): void {
    const c = Number.parseInt(color.slice(1), 16);
    const colors = [c, 0xf2b632, 0xffffff, 0xe8615a, 0x3f8fd2];
    for (let i = 0; i < 46; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 220;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life: 0,
        maxLife: 0.7 + Math.random() * 0.6,
        color: colors[i % colors.length],
        size: 2 + Math.random() * 3,
      });
    }
  }

  splash(x: number, y: number): void {
    this.rings.push({ x, y, t: 0 }, { x, y, t: -0.15 }, { x, y, t: -0.3 });
    for (let i = 0; i < 16; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 90;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 0.4 + Math.random() * 0.3,
        color: 0xffffff,
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  draw(dt: number, balls: BallView[], aim: { from: Point; to: Point } | null): void {
    this.time += dt;
    const g = this.dynamic;
    g.clear();
    if (!this.hole) return;

    for (const ring of this.rings) {
      ring.t += dt;
      if (ring.t < 0) continue;
      const k = ring.t / 0.8;
      g.circle(ring.x, ring.y, 6 + k * 26).stroke({ width: 2.5, color: 0xffffff, alpha: Math.max(0, 1 - k) });
    }
    this.rings = this.rings.filter((r) => r.t < 0.8);

    for (const [id, trail] of this.trails) {
      const ball = balls.find((b) => b.id === id);
      if (!ball) continue;
      const color = Number.parseInt(ball.color.slice(1), 16);
      trail.forEach(([x, y], i) => {
        g.circle(x, y, BALL_RADIUS * (0.3 + (i / trail.length) * 0.5)).fill({ color, alpha: (i / trail.length) * 0.35 });
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
      const power = Math.min(len, MAX_AIM_DISTANCE) / MAX_AIM_DISTANCE;
      const steps = Math.max(2, Math.floor(Math.hypot(dx, dy) / 12));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        g.circle(fx + dx * t, fy + dy * t, 2.2 + t * 1.2).fill({ color: power >= 1 ? PALETTE.flag : 0xffffff, alpha: 0.9 });
      }
      g.circle(fx + dx, fy + dy, 6).stroke({ width: 2, color: power >= 1 ? PALETTE.flag : 0xffffff, alpha: 0.9 });
    }

    const seen = new Set<string>();
    for (const ball of balls) {
      seen.add(ball.id);
      const color = Number.parseInt(ball.color.slice(1), 16);
      if (ball.isTurn) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
        g.circle(ball.x, ball.y, BALL_RADIUS + 5 + pulse * 3).stroke({ width: 2, color: 0xffffff, alpha: 0.5 + pulse * 0.4 });
      }
      g.ellipse(ball.x + 2, ball.y + 3, BALL_RADIUS, BALL_RADIUS * 0.8).fill({ color: 0x2f4a2a, alpha: 0.22 });
      g.circle(ball.x, ball.y, BALL_RADIUS).fill(color).stroke({ width: 1.5, color: PALETTE.ink, alpha: 0.35 });
      g.circle(ball.x - 2.2, ball.y - 2.4, 2.2).fill({ color: 0xffffff, alpha: 0.7 });

      let label = this.labelCache.get(ball.id);
      if (!label) {
        label = new Text({
          text: ball.name,
          style: { fontFamily: "Nunito, Segoe UI, sans-serif", fontSize: 13, fontWeight: "700", fill: PALETTE.ink },
          resolution: 3,
        });
        label.anchor.set(0.5, 1);
        this.labels.addChild(label);
        this.labelCache.set(ball.id, label);
      }
      label.text = ball.name;
      label.visible = true;
      label.alpha = ball.isTurn || ball.isMe ? 1 : 0.6;
      label.position.set(ball.x, ball.y - BALL_RADIUS - 5);
    }
    for (const [id, label] of this.labelCache) if (!seen.has(id)) label.visible = false;

    for (const p of this.particles) {
      p.life += dt;
      p.vy += 260 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      g.circle(p.x, p.y, p.size).fill({ color: p.color, alpha: Math.max(0, 1 - p.life / p.maxLife) });
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);

    const [cx, cy] = this.hole.cup;
    const sway = Math.sin(this.time * 2.2) * 2;
    this.flag.clear();
    this.flag.moveTo(cx, cy).lineTo(cx, cy - 46).stroke({ width: 2.5, color: 0xfaf7f0, cap: "round" });
    this.flag.poly([cx, cy - 46, cx + 22 + sway, cy - 40, cx, cy - 33]).fill(PALETTE.flag);
  }
}

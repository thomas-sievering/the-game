import { Application, Container, Graphics, RenderTexture, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import { CAR, type RaceEvent } from "../shared/sim";
import type { Circle, Rect, Theme, Track } from "../shared/tracks";

export const CAR_COLORS = [0xe63946, 0x3a86ff, 0xffbe0b, 0x2dc653, 0xfb8500, 0x9b5de5, 0x00c2d1, 0xff5fa2];
export const CAR_COLOR_NAMES = ["Red", "Blue", "Yellow", "Green", "Orange", "Purple", "Cyan", "Pink"];
export const css = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

interface Palette {
  page: number;
  ground: string;
  road: number;
  roadPatch: number;
  verge: number;
  edge: number;
  kerb: [number, number];
  boost: number;
  dust: number;
  skid: number;
  /** Screen tint laid over the world. */
  tint: number;
  tintAlpha: number;
  night: boolean;
}

const PALETTES: Record<Theme, Palette> = {
  meadow: {
    page: 0x2f5e27,
    ground: "#5aa845",
    road: 0x50545c,
    roadPatch: 0x464a51,
    verge: 0x47913a,
    edge: 0xf4f4f0,
    kerb: [0xd8342c, 0xf4f4f0],
    boost: 0xffb020,
    dust: 0x9a8a5a,
    skid: 0x24262a,
    tint: 0xfff2c0,
    tintAlpha: 0.06,
    night: false,
  },
  desert: {
    page: 0x8a5230,
    ground: "#dea566",
    road: 0x6a5850,
    roadPatch: 0x5f4e47,
    verge: 0xc98a50,
    edge: 0xf6e6c8,
    kerb: [0xc7402d, 0xf6e6c8],
    boost: 0xff7a1a,
    dust: 0xd9a46a,
    skid: 0x3a2a22,
    tint: 0xff7a40,
    tintAlpha: 0.12,
    night: false,
  },
  city: {
    page: 0x0b0c14,
    ground: "#1c1f2e",
    road: 0x15171f,
    roadPatch: 0x1b1d27,
    verge: 0x383c50,
    edge: 0x22e0ff,
    kerb: [0xff2fa8, 0x22e0ff],
    boost: 0x22e0ff,
    dust: 0x6a6f88,
    skid: 0x05060a,
    tint: 0x2030a0,
    tintAlpha: 0.14,
    night: true,
  },
};

// ---------------------------------------------------------------- generated textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Draws fn at every wrapped offset so a tile repeats seamlessly. */
function wrapped(size: number, x: number, y: number, fn: (x: number, y: number) => void) {
  for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) fn(x + dx, y + dy);
}

function groundTexture(theme: Theme, base: string): Texture {
  const size = 256;
  const [c, g] = canvas(size, size);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  if (theme === "meadow") {
    // Mowing stripes, then blades of grass and clover.
    g.fillStyle = "rgba(255,255,255,0.035)";
    g.fillRect(0, 0, size, size / 2);
    for (let i = 0; i < 1600; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillStyle = Math.random() < 0.5 ? "rgba(30,80,20,0.35)" : "rgba(150,210,100,0.35)";
      wrapped(size, x, y, (px, py) => g.fillRect(px, py, 1.5, 3 + Math.random() * 2));
    }
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillStyle = "rgba(60,120,40,0.45)";
      wrapped(size, x, y, (px, py) => {
        g.beginPath();
        g.arc(px, py, 5 + Math.random() * 4, 0, Math.PI * 2);
        g.fill();
      });
    }
  } else if (theme === "desert") {
    for (let k = 0; k < 6; k++) {
      g.strokeStyle = k % 2 ? "rgba(150,80,30,0.16)" : "rgba(255,230,180,0.18)";
      g.lineWidth = 3;
      g.beginPath();
      for (let x = 0; x <= size; x += 4) {
        const y = k * (size / 6) + Math.sin((x / size) * Math.PI * 4 + k) * 8;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 2200; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillStyle = Math.random() < 0.5 ? "rgba(120,60,20,0.25)" : "rgba(255,240,200,0.3)";
      wrapped(size, x, y, (px, py) => g.fillRect(px, py, 1.5, 1.5));
    }
    for (let i = 0; i < 18; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillStyle = "rgba(110,70,40,0.5)";
      wrapped(size, x, y, (px, py) => g.fillRect(px, py, 3, 2));
    }
  } else {
    // Concrete slabs with joints and grime.
    for (let i = 0; i < 2500; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillStyle = Math.random() < 0.5 ? "rgba(0,0,0,0.25)" : "rgba(120,130,170,0.12)";
      wrapped(size, x, y, (px, py) => g.fillRect(px, py, 2, 2));
    }
    g.strokeStyle = "rgba(0,0,0,0.45)";
    g.lineWidth = 2;
    for (let i = 0; i <= size; i += 64) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, size);
      g.moveTo(0, i);
      g.lineTo(size, i);
      g.stroke();
    }
    g.strokeStyle = "rgba(255,255,255,0.04)";
    for (let i = 2; i <= size; i += 64) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, size);
      g.moveTo(0, i);
      g.lineTo(size, i);
      g.stroke();
    }
  }
  return Texture.from(c);
}

function radialTexture(size: number, stops: [number, string][]): Texture {
  const [c, g] = canvas(size, size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return Texture.from(c);
}

function coneTexture(): Texture {
  const [c, g] = canvas(256, 128);
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, "rgba(255,245,210,0.55)");
  grad.addColorStop(1, "rgba(255,245,210,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, 54);
  g.lineTo(256, 0);
  g.lineTo(256, 128);
  g.lineTo(0, 74);
  g.closePath();
  g.fill();
  return Texture.from(c);
}

function vignetteTexture(): Texture {
  const [c, g] = canvas(512, 512);
  const grad = g.createRadialGradient(256, 256, 120, 256, 256, 362);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  return Texture.from(c);
}

// ---------------------------------------------------------------- deterministic scenery randomness

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(color: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((color & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------- cars

export interface CarView {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  /** Heading as a unit vector. */
  hx: number;
  hy: number;
  vx: number;
  vy: number;
  input: number;
  boost: number;
  offroad: boolean;
  /** Away or retired: drawn faded. */
  faded: boolean;
  me: boolean;
}

class CarSprite {
  root = new Container();
  body = new Container();
  brake = new Graphics();
  flame = new Graphics();
  cone: Sprite | null = null;
  label: Text;
  marker = new Graphics();
  /** Rear wheel positions last frame, for skid marks. */
  lastRear: [number, number, number, number] | null = null;

  constructor(name: string, color: number, night: boolean, cone: Texture) {
    const c = CAR_COLORS[color % CAR_COLORS.length];
    const L = CAR.length / 2;
    const W = CAR.width / 2;
    const g = new Graphics();
    // Shadow, tyres, body, then details from the bottom up.
    g.roundRect(-L + 3, -W + 4, CAR.length, CAR.width, 7).fill({ color: 0x000000, alpha: 0.35 });
    for (const [x, y] of [
      [L - 9, -W - 1.5],
      [L - 9, W - 3.5],
      [-L + 3, -W - 1.5],
      [-L + 3, W - 3.5],
    ]) g.roundRect(x, y, 8, 5, 1.5).fill(0x111111);
    g.roundRect(-L, -W, CAR.length, CAR.width, 7).fill(shade(c, 0.62));
    g.roundRect(-L + 1, -W + 1, CAR.length - 2, CAR.width - 2, 6).fill(c);
    // Racing stripes over the bonnet and boot.
    g.rect(-L + 2, -1.8, CAR.length - 4, 3.6).fill({ color: 0xffffff, alpha: 0.85 });
    // Cabin: windscreen, roof, rear window.
    g.poly([5, -W + 2.5, 10, -W + 3.5, 10, W - 3.5, 5, W - 2.5]).fill(0x1c2a3a);
    g.poly([6, -W + 3.5, 9, -W + 4.2, 9, -W + 7]).fill({ color: 0xbfe6ff, alpha: 0.6 });
    g.roundRect(-7, -W + 2.5, 12, CAR.width - 5, 3).fill(shade(c, 1.12));
    g.rect(-7, -1.8, 12, 3.6).fill({ color: 0xffffff, alpha: 0.85 });
    g.poly([-7, -W + 2.5, -11, -W + 3.5, -11, W - 3.5, -7, W - 2.5]).fill(0x1c2a3a);
    // Spoiler and headlights.
    g.roundRect(-L - 1.5, -W + 0.5, 3.5, CAR.width - 1, 1).fill(0x1a1a1a);
    g.roundRect(L - 3, -W + 1.5, 2.5, 4, 1).fill(0xfff6c8);
    g.roundRect(L - 3, W - 5.5, 2.5, 4, 1).fill(0xfff6c8);
    g.roundRect(-L + 0.5, -W + 1.5, 2, 3.5, 0.8).fill(0x7a0a0a);
    g.roundRect(-L + 0.5, W - 5, 2, 3.5, 0.8).fill(0x7a0a0a);
    // Brake lights glow when braking; flames when boosting.
    this.brake.circle(-L, -W + 3.2, 4).fill({ color: 0xff2020, alpha: 0.7 });
    this.brake.circle(-L, W - 3.2, 4).fill({ color: 0xff2020, alpha: 0.7 });
    this.brake.visible = false;
    this.flame.ellipse(-L - 9, -4, 9, 3).fill({ color: 0xff8a1a, alpha: 0.85 });
    this.flame.ellipse(-L - 9, 4, 9, 3).fill({ color: 0xff8a1a, alpha: 0.85 });
    this.flame.ellipse(-L - 5, -4, 5, 1.8).fill(0xfff2a0);
    this.flame.ellipse(-L - 5, 4, 5, 1.8).fill(0xfff2a0);
    this.flame.visible = false;
    if (night) {
      this.cone = new Sprite(cone);
      this.cone.anchor.set(0, 0.5);
      this.cone.position.set(L - 2, 0);
      this.cone.width = 190;
      this.cone.height = 110;
      this.cone.blendMode = "add";
      this.body.addChild(this.cone);
    }
    this.body.addChild(this.flame, g, this.brake);
    this.label = new Text({
      text: name,
      style: { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: 13, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      resolution: 2,
    });
    this.label.anchor.set(0.5, 1);
    this.label.position.set(0, -24);
    this.marker.poly([-6, -40, 6, -40, 0, -32]).fill(c).stroke({ width: 2, color: 0xffffff });
    this.marker.visible = false;
    this.root.addChild(this.body, this.label, this.marker);
  }
}

// ---------------------------------------------------------------- particles

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
  grow: number;
  alpha: number;
}

export class Renderer {
  app = new Application();
  private world = new Container();
  private ground: TilingSprite | null = null;
  private road = new Graphics();
  /** Ground decorations under the cars: flowers, scrub, stands. */
  private decor = new Graphics();
  private scenery = new Graphics();
  private boostGlow = new Graphics();
  private skidSprite: Sprite | null = null;
  private skidTexture: RenderTexture | null = null;
  private skidBatch = new Graphics();
  private skidCount = 0;
  private carLayer = new Container();
  private glowLayer = new Container();
  private particleLayer = new Container();
  private tint = new Graphics();
  private vignette: Sprite | null = null;
  private minimap = new Container();
  private minimapCars = new Graphics();
  private minimapScale = 1;
  private cars = new Map<string, CarSprite>();
  private particles: Particle[] = [];
  private free: Sprite[] = [];
  private textures!: { soft: Texture; glow: Texture; cone: Texture; vignette: Texture };
  track: Track | null = null;
  private palette: Palette = PALETTES.meadow;
  private cam = { x: 0, y: 0, zoom: 1, shake: 0 };
  private time = 0;

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      background: 0x101218,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    parent.appendChild(this.app.canvas);
    this.textures = {
      soft: radialTexture(32, [
        [0, "rgba(255,255,255,1)"],
        [1, "rgba(255,255,255,0)"],
      ]),
      glow: radialTexture(128, [
        [0, "rgba(255,255,255,0.9)"],
        [0.35, "rgba(255,255,255,0.35)"],
        [1, "rgba(255,255,255,0)"],
      ]),
      cone: coneTexture(),
      vignette: vignetteTexture(),
    };
    this.vignette = new Sprite(this.textures.vignette);
    this.app.stage.addChild(this.world, this.tint, this.vignette, this.minimap);
  }

  /** Builds the static scene for a track; cheap to call again with the same one. */
  setTrack(track: Track): void {
    if (this.track === track) return;
    this.track = track;
    const p = (this.palette = PALETTES[track.theme]);
    this.app.renderer.background.color = p.page;
    this.world.removeChildren();
    for (const car of this.cars.values()) car.root.destroy({ children: true });
    this.cars.clear();
    for (const part of this.particles) part.sprite.destroy();
    this.particles = [];

    this.ground?.destroy();
    this.ground = new TilingSprite({ texture: groundTexture(track.theme, p.ground), width: track.width, height: track.height });
    this.road.clear();
    this.decor.clear();
    this.scenery.clear();
    this.boostGlow.clear();
    this.glowLayer.removeChildren();
    this.drawRoad(track);
    this.drawScenery(track);

    this.skidTexture?.destroy(true);
    this.skidTexture = RenderTexture.create({ width: track.width, height: track.height, resolution: 0.5 });
    this.skidSprite = new Sprite(this.skidTexture);
    this.skidSprite.alpha = p.night ? 0.8 : 0.55;
    this.skidBatch.clear();
    this.skidCount = 0;

    const edge = new Graphics();
    // A fence around the world edge.
    edge.rect(-6, -6, track.width + 12, track.height + 12).stroke({ width: 12, color: p.night ? 0x22e0ff : 0x2a2a2a, alpha: p.night ? 0.6 : 0.9 });
    for (let x = 0; x <= track.width; x += 60) {
      edge.rect(x - 3, -10, 6, 8).fill(0xdddddd);
      edge.rect(x - 3, track.height + 2, 6, 8).fill(0xdddddd);
    }

    this.world.addChild(this.ground, this.road, this.decor, this.skidSprite, this.boostGlow, this.carLayer, this.particleLayer, this.scenery, this.glowLayer, edge);
    this.tint.clear();
    this.drawMinimap(track);
  }

  private drawRoad(track: Track) {
    const p = this.palette;
    const g = this.road;
    const pts = track.path.flatMap((q) => [q.x, q.y]);
    const n = track.path.length;
    const w = track.half * 2;
    const bend = (i: number) => {
      const a = track.dir[(i - 6 + n) % n];
      const b = track.dir[(i + 6) % n];
      return a.x * b.y - a.y * b.x;
    };
    // Verge, then kerbs on the bends, then asphalt.
    g.poly(pts, true).stroke({ width: w + 70, color: p.verge, join: "round" });
    if (track.theme === "city") g.poly(pts, true).stroke({ width: w + 26, color: 0x4a4f66, join: "round" });
    g.poly(pts, true).stroke({ width: w + 14, color: p.edge, join: "round", alpha: track.theme === "city" ? 0.85 : 1 });
    for (let i = 0; i < n; i++) {
      const b = bend(i);
      if (b * b < 0.06) continue;
      const a = track.path[i];
      const c = track.path[(i + 1) % n];
      g.moveTo(a.x, a.y)
        .lineTo(c.x, c.y)
        .stroke({ width: w + 16, color: p.kerb[Math.floor(i / 2) % 2], cap: "round" });
    }
    g.poly(pts, true).stroke({ width: w, color: p.road, join: "round" });

    // Asphalt patches and a darker racing line give the road some wear.
    const rand = seeded(track.path.length * 7);
    for (let i = 0; i < n; i += 2) {
      const q = track.path[i];
      const d = track.dir[i];
      const off = (rand() - 0.5) * w * 0.8;
      g.ellipse(q.x - d.y * off, q.y + d.x * off, 10 + rand() * 30, 6 + rand() * 14).fill({ color: p.roadPatch, alpha: 0.5 });
    }
    for (let i = 0; i < n; i++) {
      const q = track.path[i];
      const d = track.dir[i];
      const b = bend(i);
      // The racing line drifts toward the inside of bends.
      const off = Math.max(-0.6, Math.min(0.6, b * 1.2)) * track.half * 0.6;
      g.circle(q.x + d.y * off, q.y - d.x * off, 16).fill({ color: 0x000000, alpha: 0.05 });
    }
    if (track.theme === "city") {
      for (let i = 0; i < n; i += 4) {
        const a = track.path[i];
        const c = track.path[(i + 2) % n];
        g.moveTo(a.x, a.y).lineTo(c.x, c.y).stroke({ width: 4, color: 0xffd23f, alpha: 0.75 });
      }
    }

    // Start/finish chequers across the road, two rows deep.
    const s = track.path[0];
    const d = track.dir[0];
    const cells = 10;
    const size = w / cells;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cells; col++) {
        const along0 = (row - 1) * size;
        const side0 = -track.half + col * size;
        const corner = (al: number, si: number) => [s.x + d.x * al - d.y * si, s.y + d.y * al + d.x * si];
        g.poly([...corner(along0, side0), ...corner(along0 + size, side0), ...corner(along0 + size, side0 + size), ...corner(along0, side0 + size)]).fill(
          (row + col) % 2 ? 0x111111 : 0xffffff,
        );
      }
    }
    // Grid boxes.
    for (const slot of track.grid) {
      const corner = (al: number, si: number) => [slot.x + slot.hx * al - slot.hy * si, slot.y + slot.hy * al + slot.hx * si];
      g.moveTo(...(corner(26, -16) as [number, number]))
        .lineTo(...(corner(26, 16) as [number, number]))
        .moveTo(...(corner(26, -16) as [number, number]))
        .lineTo(...(corner(14, -16) as [number, number]))
        .moveTo(...(corner(26, 16) as [number, number]))
        .lineTo(...(corner(14, 16) as [number, number]))
        .stroke({ width: 3, color: 0xffffff, alpha: 0.8 });
    }
    // Boost pad plates; their chevrons pulse in boostGlow.
    for (const pad of track.boosts) {
      const corner = (al: number, si: number) => [pad.x + pad.dx * al - pad.dy * si, pad.y + pad.dy * al + pad.dx * si];
      g.poly([...corner(-36, -34), ...corner(36, -34), ...corner(36, 34), ...corner(-36, 34)]).fill({ color: 0x000000, alpha: 0.45 });
      g.poly([...corner(-36, -34), ...corner(36, -34), ...corner(36, 34), ...corner(-36, 34)]).stroke({ width: 3, color: p.boost, alpha: 0.7 });
      for (let k = 0; k < 3; k++) {
        const al = -22 + k * 18;
        this.boostGlow
          .poly([...corner(al, -24), ...corner(al + 14, 0), ...corner(al, 24), ...corner(al - 6, 24), ...corner(al + 7, 0), ...corner(al - 6, -24)])
          .fill(p.boost);
      }
    }
    if (p.night) this.boostGlow.blendMode = "add";
  }

  private drawScenery(track: Track) {
    const g = this.scenery;
    const p = this.palette;
    const rand = seeded(track.width + track.height);
    // Ground decorations that don't collide: flowers, pebbles, puddles of light.
    const under = this.decor;
    if (track.theme === "meadow") {
      for (let i = 0; i < 260; i++) {
        const x = rand() * track.width;
        const y = rand() * track.height;
        if (this.nearRoad(track, x, y, 50)) continue;
        const color = [0xffffff, 0xffe14d, 0xff7bb0, 0xb48cff][Math.floor(rand() * 4)];
        for (let k = 0; k < 5; k++) under.circle(x + (rand() - 0.5) * 18, y + (rand() - 0.5) * 18, 2.2).fill(color);
      }
      this.drawGantry(this.scenery, track);
    } else if (track.theme === "desert") {
      for (let i = 0; i < 160; i++) {
        const x = rand() * track.width;
        const y = rand() * track.height;
        if (this.nearRoad(track, x, y, 40)) continue;
        under.ellipse(x, y, 30 + rand() * 60, 12 + rand() * 20).fill({ color: 0xffe0b0, alpha: 0.12 });
        under.circle(x + 20, y + 6, 2 + rand() * 3).fill({ color: 0x8a5a3a, alpha: 0.6 });
      }
      for (let i = 0; i < 60; i++) {
        const x = rand() * track.width;
        const y = rand() * track.height;
        if (this.nearRoad(track, x, y, 40)) continue;
        // Dry scrub.
        for (let k = 0; k < 6; k++) {
          const a = rand() * Math.PI * 2;
          under.moveTo(x, y).lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
        }
        under.stroke({ width: 1.5, color: 0x8a6a3a, alpha: 0.8 });
      }
      this.drawGantry(this.scenery, track);
    } else {
      this.drawGantry(this.scenery, track);
    }

    for (const c of track.circles) this.drawCircle(g, c, rand);
    for (const b of track.rects) {
      if (b.kind === "stand") this.drawStand(this.decor, b, track);
      else this.drawBuilding(g, b, rand);
    }
  }

  private nearRoad(track: Track, x: number, y: number, margin: number): boolean {
    const lim = track.half + margin;
    for (let i = 0; i < track.path.length; i += 2) {
      const q = track.path[i];
      if ((q.x - x) * (q.x - x) + (q.y - y) * (q.y - y) < lim * lim) return true;
    }
    return false;
  }

  /** A gantry with start lights over the line. */
  private drawGantry(g: Graphics, track: Track) {
    const s = track.path[0];
    const d = track.dir[0];
    const nx = -d.y;
    const ny = d.x;
    const night = this.palette.night;
    // Gantry over the line.
    const off = track.half + 26;
    for (const side of [-1, 1]) g.circle(s.x + nx * off * side, s.y + ny * off * side, 7).fill(0x333333);
    g.moveTo(s.x - nx * off, s.y - ny * off)
      .lineTo(s.x + nx * off, s.y + ny * off)
      .stroke({ width: 10, color: night ? 0xff2fa8 : 0x2a2a2a });
    for (let k = -2; k <= 2; k++) g.circle(s.x + nx * k * 22, s.y + ny * k * 22, 4).fill(night ? 0x22e0ff : 0xff3030);
  }

  /** Grandstand seen from above: tiered rows of fans facing the road, a coloured roof edge at the back. */
  private drawStand(g: Graphics, b: Rect, track: Track) {
    const night = this.palette.night;
    const vertical = b.h > b.w;
    // Rows run along the long side; the front faces the start line.
    const s = track.path[0];
    const front = vertical ? (s.x < b.x ? -1 : 1) : s.y < b.y ? -1 : 1;
    const long = vertical ? b.h : b.w;
    const deep = vertical ? b.w : b.h;
    const at = (along: number, depth: number, len: number, thick: number) =>
      vertical
        ? { x: front > 0 ? b.x + b.w - depth - thick : b.x + depth, y: b.y + along, w: thick, h: len }
        : { x: b.x + along, y: front > 0 ? b.y + b.h - depth - thick : b.y + depth, w: len, h: thick };
    g.rect(b.x + 6, b.y + 8, b.w, b.h).fill({ color: 0x000000, alpha: 0.3 });
    g.rect(b.x, b.y, b.w, b.h).fill(night ? 0x2a2d40 : 0x9aa0a8);
    const crowd = seeded(b.x * 31 + b.y);
    const colors = [0xe63946, 0x3a86ff, 0xffbe0b, 0xffffff, 0x2dc653, 0xff5fa2];
    for (let row = 0; row < 4; row++) {
      const r = at(6, 6 + row * 15, long - 12, 9);
      g.rect(r.x, r.y, r.w, r.h).fill(night ? 0x3a3e58 : row % 2 ? 0x707882 : 0x828a94);
      for (let k = 0; k < (long - 16) / 9; k++) {
        if (crowd() < 0.15) continue;
        const p = at(10 + k * 9 + crowd() * 2, 6 + row * 15 + 4.5, 0, 0);
        g.circle(p.x, p.y, 3.2).fill(colors[Math.floor(crowd() * colors.length)]);
      }
    }
    const roof = at(0, deep - 12, long, 12);
    g.rect(roof.x, roof.y, roof.w, roof.h).fill(night ? 0xff2fa8 : 0xc0392b);
    for (let k = 0; k < long; k += 40) {
      const p = at(k + 20, deep - 6, 0, 0);
      g.circle(p.x, p.y, 3).fill({ color: 0xffffff, alpha: 0.6 });
    }
  }

  private drawCircle(g: Graphics, c: Circle, rand: () => number) {
    const night = this.palette.night;
    switch (c.kind) {
      case "tree": {
        g.circle(c.x + c.r * 0.35, c.y + c.r * 0.45, c.r * 1.05).fill({ color: 0x000000, alpha: 0.28 });
        const base = night ? 0x1f5a3a : [0x2f7a2a, 0x3a8a30, 0x2a6e30][Math.floor(rand() * 3)];
        g.circle(c.x, c.y, c.r).fill(shade(base, 0.8));
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + rand();
          g.circle(c.x + Math.cos(a) * c.r * 0.45, c.y + Math.sin(a) * c.r * 0.45, c.r * 0.55).fill(base);
        }
        g.circle(c.x - c.r * 0.25, c.y - c.r * 0.3, c.r * 0.45).fill(shade(base, 1.3));
        g.circle(c.x - c.r * 0.35, c.y - c.r * 0.4, c.r * 0.18).fill({ color: 0xffffff, alpha: 0.15 });
        if (night) g.circle(c.x, c.y, c.r + 6).stroke({ width: 3, color: 0x5a6078 });
        break;
      }
      case "bush": {
        g.circle(c.x + 4, c.y + 5, c.r).fill({ color: 0x000000, alpha: 0.25 });
        for (let k = 0; k < 3; k++) g.circle(c.x + (rand() - 0.5) * c.r, c.y + (rand() - 0.5) * c.r, c.r * 0.7).fill(0x3f8f35);
        g.circle(c.x - 3, c.y - 3, c.r * 0.4).fill(0x6cbf52);
        for (let k = 0; k < 3; k++) g.circle(c.x + (rand() - 0.5) * c.r * 1.2, c.y + (rand() - 0.5) * c.r * 1.2, 2).fill(0xe63946);
        break;
      }
      case "rock": {
        const pts: number[] = [];
        const sides = 7 + Math.floor(rand() * 3);
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2;
          const r = c.r * (0.85 + rand() * 0.3);
          pts.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
        }
        g.poly(pts.map((v, i) => v + (i % 2 ? 8 : 6))).fill({ color: 0x5a2a10, alpha: 0.35 });
        g.poly(pts).fill(0x9a5a3a);
        g.poly(pts.map((v, i) => (i % 2 ? c.y + (v - c.y) * 0.7 - c.r * 0.12 : c.x + (v - c.x) * 0.7 - c.r * 0.12))).fill(0xb8744a);
        g.poly(pts.map((v, i) => (i % 2 ? c.y + (v - c.y) * 0.35 - c.r * 0.25 : c.x + (v - c.x) * 0.35 - c.r * 0.25))).fill(0xd08e5e);
        g.poly(pts).stroke({ width: 2, color: 0x6a3a20 });
        break;
      }
      case "cactus": {
        g.ellipse(c.x + 6, c.y + 7, c.r * 1.4, c.r * 0.7).fill({ color: 0x5a2a10, alpha: 0.3 });
        const arms = 2 + Math.floor(rand() * 2);
        for (let k = 0; k < arms; k++) {
          const a = rand() * Math.PI * 2;
          const ax = c.x + Math.cos(a) * c.r * 1.2;
          const ay = c.y + Math.sin(a) * c.r * 1.2;
          g.moveTo(c.x, c.y).lineTo(ax, ay).stroke({ width: c.r * 0.8, color: 0x3a7a3a, cap: "round" });
          g.circle(ax, ay, c.r * 0.45).fill(0x4f9a48);
        }
        g.circle(c.x, c.y, c.r).fill(0x3a7a3a);
        g.circle(c.x - 2, c.y - 2, c.r * 0.6).fill(0x5aaa50);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          g.circle(c.x + Math.cos(a) * c.r * 0.7, c.y + Math.sin(a) * c.r * 0.7, 1).fill(0xf0f0c0);
        }
        if (rand() < 0.4) g.circle(c.x, c.y, 3).fill(0xff5fa2);
        break;
      }
      case "tyres": {
        g.circle(c.x + 3, c.y + 4, c.r + 2).fill({ color: 0x000000, alpha: 0.3 });
        for (const [dx, dy] of [
          [-6, -6],
          [6, -6],
          [-6, 6],
          [6, 6],
        ]) {
          g.circle(c.x + dx, c.y + dy, 8).fill(0x1a1a1a);
          g.circle(c.x + dx, c.y + dy, 4).fill(night ? 0xff2fa8 : rand() < 0.5 ? 0xd8342c : 0xf0f0f0);
          g.circle(c.x + dx, c.y + dy, 2).fill(0x0a0a0a);
        }
        break;
      }
      case "lamp": {
        g.circle(c.x + 2, c.y + 3, c.r).fill({ color: 0x000000, alpha: 0.4 });
        g.circle(c.x, c.y, c.r).fill(0x6a6f88);
        g.circle(c.x, c.y, c.r * 0.5).fill(0xfff0c0);
        const glow = new Sprite(this.textures.glow);
        glow.anchor.set(0.5);
        glow.position.set(c.x, c.y);
        glow.width = glow.height = 220;
        glow.tint = 0xffc87a;
        glow.alpha = 0.55;
        glow.blendMode = "add";
        this.glowLayer.addChild(glow);
        break;
      }
    }
  }

  private drawBuilding(g: Graphics, b: Rect, rand: () => number) {
    const neon = [0xff2fa8, 0x22e0ff, 0xa060ff, 0xffd23f][Math.floor(rand() * 4)];
    const roof = [0x262a3e, 0x2e2a40, 0x22283a][Math.floor(rand() * 3)];
    const h = 6 + b.floors * 4;
    // Fake height: walls to the south and east, lit windows on the south face.
    g.poly([b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x + b.w + h, b.y + b.h + h, b.x + h, b.y + b.h + h]).fill(0x101320);
    g.poly([b.x + b.w, b.y, b.x + b.w + h, b.y + h, b.x + b.w + h, b.y + b.h + h, b.x + b.w, b.y + b.h]).fill(0x0c0e18);
    for (let wx = b.x + 8; wx < b.x + b.w - 6; wx += 12) {
      for (let f = 0; f < Math.min(3, b.floors); f++) {
        if (rand() < 0.45) continue;
        const y = b.y + b.h + 3 + f * (h / Math.min(3, b.floors));
        g.rect(wx + f, y, 6, 3).fill({ color: rand() < 0.7 ? 0xffd27a : 0x9ad8ff, alpha: 0.9 });
      }
    }
    g.rect(b.x, b.y, b.w, b.h).fill(roof);
    g.rect(b.x + 6, b.y + 6, b.w - 12, b.h - 12).stroke({ width: 2, color: 0x000000, alpha: 0.35 });
    // Rooftop clutter.
    for (let k = 0; k < 3; k++) {
      const w = 14 + rand() * 20;
      const x = b.x + 12 + rand() * (b.w - 24 - w);
      const y = b.y + 12 + rand() * (b.h - 24 - w);
      g.rect(x + 3, y + 3, w, w * 0.7).fill({ color: 0x000000, alpha: 0.35 });
      g.rect(x, y, w, w * 0.7).fill(0x454a62);
      g.circle(x + w / 2, y + w * 0.35, w * 0.22).fill(0x2a2e40);
    }
    g.rect(b.x, b.y, b.w, b.h).stroke({ width: 3, color: neon, alpha: 0.9 });
    const glow = new Graphics();
    glow.rect(b.x - 4, b.y - 4, b.w + 8, b.h + 8).stroke({ width: 10, color: neon, alpha: 0.18 });
    glow.blendMode = "add";
    this.glowLayer.addChild(glow);
  }

  private drawMinimap(track: Track) {
    this.minimap.removeChildren();
    const size = 210;
    const scale = (this.minimapScale = size / Math.max(track.width, track.height));
    const bg = new Graphics();
    const w = track.width * scale;
    const h = track.height * scale;
    bg.roundRect(-8, -8, w + 16, h + 16, 10).fill({ color: 0x000000, alpha: 0.45 }).stroke({ width: 2, color: 0xffffff, alpha: 0.25 });
    bg.poly(
      track.path.flatMap((q) => [q.x * scale, q.y * scale]),
      true,
    ).stroke({ width: 5, color: 0xffffff, alpha: 0.75, join: "round" });
    const s = track.path[0];
    const d = track.dir[0];
    bg.moveTo((s.x - d.y * track.half) * scale, (s.y + d.x * track.half) * scale)
      .lineTo((s.x + d.y * track.half) * scale, (s.y - d.x * track.half) * scale)
      .stroke({ width: 3, color: 0xff3030 });
    this.minimap.addChild(bg, this.minimapCars);
    this.minimap.label = `${w}x${h}`;
  }

  /** Spawns effects for race events. */
  fx(event: RaceEvent, cars: Map<string, CarView>) {
    if (event.type === "bump") {
      this.cam.shake = Math.max(this.cam.shake, cars.get(event.car)?.me ? Math.min(12, event.strength / 40) : 0);
      for (let i = 0; i < Math.min(14, 4 + event.strength / 40); i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 80 + Math.random() * 220;
        this.spawn(event.x, event.y, Math.cos(a) * v, Math.sin(a) * v, 0xffd23f, 0.35, 5, 0, 1);
      }
    } else if (event.type === "boost") {
      const car = cars.get(event.car);
      if (!car) return;
      for (let i = 0; i < 12; i++) {
        this.spawn(car.x, car.y, -car.hx * 200 + (Math.random() - 0.5) * 120, -car.hy * 200 + (Math.random() - 0.5) * 120, this.palette.boost, 0.5, 10, 30, 0.9);
      }
    }
  }

  private spawn(x: number, y: number, vx: number, vy: number, color: number, life: number, size: number, grow: number, alpha: number, add = false) {
    if (this.particles.length > 400) return;
    const sprite = this.free.pop() ?? new Sprite(this.textures.soft);
    sprite.anchor.set(0.5);
    sprite.position.set(x, y);
    sprite.tint = color;
    sprite.width = sprite.height = size;
    sprite.alpha = alpha;
    sprite.blendMode = add || this.palette.night ? "add" : "normal";
    this.particleLayer.addChild(sprite);
    this.particles.push({ sprite, vx, vy, life, max: life, grow, alpha });
  }

  clearSkids() {
    if (this.skidTexture) this.app.renderer.render({ container: new Container(), target: this.skidTexture, clear: true });
    for (const car of this.cars.values()) car.lastRear = null;
  }

  /** Draws one frame. `focus` is the car the camera follows; null or overview shows the whole track. */
  frame(views: CarView[], focus: CarView | null, overview: boolean, dt: number) {
    const track = this.track;
    if (!track) return;
    this.time += dt;
    const p = this.palette;
    const seen = new Set<string>();
    for (const v of views) {
      seen.add(v.id);
      let car = this.cars.get(v.id);
      if (!car) {
        car = new CarSprite(v.name, v.color, p.night, this.textures.cone);
        this.cars.set(v.id, car);
        this.carLayer.addChild(car.root);
      }
      car.root.position.set(v.x, v.y);
      car.body.rotation = Math.atan2(v.hy, v.hx);
      car.root.alpha = v.faded ? 0.4 : 1;
      car.marker.visible = v.me;
      car.label.visible = !v.me || overview;
      car.label.scale.set(1 / Math.max(0.35, this.cam.zoom));
      car.marker.scale.set(1 / Math.max(0.5, this.cam.zoom));
      const f = v.vx * v.hx + v.vy * v.hy;
      const lat = -v.vx * v.hy + v.vy * v.hx;
      const speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      car.brake.visible = (v.input & 2) !== 0 && f > 0;
      car.flame.visible = v.boost > 0;
      if (v.boost > 0) car.flame.scale.set(0.8 + Math.random() * 0.5, 1);

      // Skid marks from the rear wheels when sliding or braking hard; dust off the road.
      const rx = v.x - v.hx * 11;
      const ry = v.y - v.hy * 11;
      const rear: [number, number, number, number] = [rx - v.hy * 7, ry + v.hx * 7, rx + v.hy * 7, ry - v.hx * 7];
      const sliding = Math.abs(lat) > 70 || ((v.input & 2) !== 0 && f > 200);
      if (sliding && !v.offroad && car.lastRear && !v.faded) {
        const a = Math.min(0.9, Math.abs(lat) / 200 + 0.3);
        this.skidBatch.moveTo(car.lastRear[0], car.lastRear[1]).lineTo(rear[0], rear[1]);
        this.skidBatch.moveTo(car.lastRear[2], car.lastRear[3]).lineTo(rear[2], rear[3]);
        this.skidBatch.stroke({ width: 4, color: p.skid, alpha: a });
        this.skidCount++;
        if (Math.random() < 0.5) this.spawn(rx, ry, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, p.night ? 0x8090b0 : 0xdddddd, 0.7, 14, 40, 0.35);
      }
      car.lastRear = rear;
      if (v.offroad && speed > 60 && Math.random() < 0.7) {
        this.spawn(rx, ry, -v.vx * 0.2 + (Math.random() - 0.5) * 40, -v.vy * 0.2 + (Math.random() - 0.5) * 40, p.dust, 0.8, 16, 50, 0.5);
      }
      if (v.boost > 0 && Math.random() < 0.8) {
        this.spawn(v.x - v.hx * 26, v.y - v.hy * 26, -v.hx * 120, -v.hy * 120, 0xff9a2a, 0.25, 9, -10, 0.9, true);
      }
    }
    for (const [id, car] of this.cars) {
      if (seen.has(id)) continue;
      car.root.destroy({ children: true });
      this.cars.delete(id);
    }
    if (this.skidCount && this.skidTexture) {
      this.app.renderer.render({ container: this.skidBatch, target: this.skidTexture, clear: false });
      this.skidBatch.clear();
      this.skidCount = 0;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const part = this.particles[i];
      part.life -= dt;
      if (part.life <= 0) {
        part.sprite.removeFromParent();
        this.free.push(part.sprite);
        this.particles.splice(i, 1);
        continue;
      }
      part.sprite.x += part.vx * dt;
      part.sprite.y += part.vy * dt;
      part.vx *= 0.94;
      part.vy *= 0.94;
      part.sprite.width = part.sprite.height = Math.max(1, part.sprite.width + part.grow * dt);
      part.sprite.alpha = part.alpha * (part.life / part.max);
    }
    this.boostGlow.alpha = 0.55 + 0.45 * Math.sin(this.time * 8);

    // Camera: follow the focus car, looking ahead and zooming out with speed.
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    let tx: number;
    let ty: number;
    let tz: number;
    if (!focus || overview) {
      tx = track.width / 2;
      ty = track.height / 2;
      tz = Math.min(sw / (track.width + 100), sh / (track.height + 100));
    } else {
      const speed = Math.sqrt(focus.vx * focus.vx + focus.vy * focus.vy);
      tx = focus.x + focus.vx * 0.35;
      ty = focus.y + focus.vy * 0.35;
      tz = Math.max(0.55, Math.min(sw / 1500, sh / 950) * 1.25) * (1 - 0.22 * Math.min(1, speed / CAR.maxSpeed));
    }
    const k = Math.min(1, dt * 6);
    const jump = Math.abs(tx - this.cam.x) + Math.abs(ty - this.cam.y) > 1200;
    this.cam.x = jump ? tx : this.cam.x + (tx - this.cam.x) * k;
    this.cam.y = jump ? ty : this.cam.y + (ty - this.cam.y) * k;
    this.cam.zoom += (tz - this.cam.zoom) * Math.min(1, dt * (overview ? 5 : 2.5));
    this.cam.shake *= 0.88;
    const sx = (Math.random() - 0.5) * this.cam.shake;
    const sy = (Math.random() - 0.5) * this.cam.shake;
    this.world.scale.set(this.cam.zoom);
    this.world.position.set(sw / 2 - this.cam.x * this.cam.zoom + sx, sh / 2 - this.cam.y * this.cam.zoom + sy);

    this.tint.clear().rect(0, 0, sw, sh).fill({ color: p.tint, alpha: p.tintAlpha });
    if (this.vignette) {
      this.vignette.width = sw;
      this.vignette.height = sh;
      this.vignette.alpha = p.night ? 1 : 0.6;
    }

    // Minimap in the top-right corner, under the HUD's lap counter.
    const scale = this.minimapScale;
    this.minimap.position.set(sw - track.width * scale - 22, sh - track.height * scale - 70);
    const mc = this.minimapCars.clear();
    for (const v of views) {
      if (v.faded) continue;
      mc.circle(v.x * scale, v.y * scale, v.me ? 6 : 4.5)
        .fill(CAR_COLORS[v.color % CAR_COLORS.length])
        .stroke({ width: v.me || v === focus ? 2 : 1, color: 0xffffff });
    }
  }

  /** Where the camera has the given world point on screen (for tests). */
  toScreen(x: number, y: number) {
    return { x: this.world.position.x + x * this.cam.zoom, y: this.world.position.y + y * this.cam.zoom };
  }
}

/** A small top-down preview of a track for the lobby. */
export function drawTrackThumb(target: HTMLCanvasElement, track: Track) {
  const g = target.getContext("2d")!;
  const w = target.width;
  const h = target.height;
  const p = PALETTES[track.theme];
  g.fillStyle = p.ground;
  g.fillRect(0, 0, w, h);
  const scale = Math.min((w - 16) / track.width, (h - 16) / track.height);
  const ox = (w - track.width * scale) / 2;
  const oy = (h - track.height * scale) / 2;
  const path = () => {
    g.beginPath();
    track.path.forEach((q, i) => (i ? g.lineTo(ox + q.x * scale, oy + q.y * scale) : g.moveTo(ox + q.x * scale, oy + q.y * scale)));
    g.closePath();
  };
  g.lineJoin = "round";
  g.fillStyle = track.theme === "city" ? "#2a2e44" : track.theme === "desert" ? "#9a5a3a" : "#2f7a2a";
  for (const c of track.circles) {
    if (c.kind === "lamp" || c.kind === "tyres") continue;
    g.beginPath();
    g.arc(ox + c.x * scale, oy + c.y * scale, Math.max(1.5, c.r * scale), 0, Math.PI * 2);
    g.fill();
  }
  for (const b of track.rects) {
    g.fillStyle = b.kind === "stand" ? "#9aa0a8" : "#2a2e44";
    g.fillRect(ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale);
    if (b.kind === "stand") continue;
    g.strokeStyle = css([0xff2fa8, 0x22e0ff, 0xa060ff][Math.floor(b.x + b.y) % 3]);
    g.lineWidth = 1;
    g.strokeRect(ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale);
  }
  path();
  g.strokeStyle = css(p.edge);
  g.lineWidth = track.half * 2 * scale + 3;
  g.stroke();
  path();
  g.strokeStyle = css(p.road);
  g.lineWidth = track.half * 2 * scale;
  g.stroke();
  const s = track.path[0];
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(ox + s.x * scale, oy + s.y * scale, 4, 0, Math.PI * 2);
  g.fill();
}

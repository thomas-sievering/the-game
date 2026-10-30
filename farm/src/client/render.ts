import { Application, Container, Graphics, Text } from "pixi.js";
import { COLS, type CropId, type Fx, ROWS, TILE_COUNT, mirror, tileX, tileY } from "../shared/sim";

export const PALETTE = {
  page: 0x2c2418,
  grass: [0x8cbf5f, 0x84b858],
  rich: [0x5d7f37, 0x587a33],
  rock: 0x9a9384,
  rockDark: 0x6f695c,
  pond: 0x5fa8d3,
  pondLight: 0x8cc8e8,
  soil: 0xa8794a,
  soilWet: 0x7d5532,
  soilRich: 0x6e4a2a,
  soilRichWet: 0x52361d,
  me: 0x2f80ed,
  them: 0xe85d4a,
  hover: 0xfff3c4,
  weeds: 0x2f5d1e,
  leaf: 0x4f8a3c,
  wheat: 0xe8c547,
  carrot: 0xf08a24,
  pumpkin: 0xe8711c,
  berries: 0x7b3fa0,
  white: 0xffffff,
  ink: 0x3b2f1e,
  crow: 0x1d1d22,
};

/** What the renderer needs from a synced tile. */
export interface TileView {
  terrain: string;
  owner: number;
  crop: string;
  growth: number;
  building: string;
  wet: boolean;
  weeds: boolean;
  guarded: boolean;
}

interface Floater {
  text: Text;
  age: number;
  life: number;
}

interface Flash {
  tile: number;
  color: number;
  age: number;
  life: number;
}

interface Crow {
  /** Board position in view tiles, flying from (sx, sy) to the target. */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  age: number;
  life: number;
}

const TILE = 48;
const BOARD_W = COLS * TILE;
const BOARD_H = ROWS * TILE;
/** Screen space the DOM HUD covers around the board. */
const INSET = { left: 16, right: 336, top: 64, bottom: 100 };

export class Renderer {
  readonly app = new Application();
  private world = new Container();
  private ground = new Graphics();
  private things = new Graphics();
  private overlay = new Graphics();
  private floaters = new Container();
  private floating: Floater[] = [];
  private flashes: Flash[] = [];
  private crows: Crow[] = [];
  private tiles: TileView[] = [];
  private hover = -1;
  private time = 0;

  /** The local player's side. Side 1 sees the board turned around so both start top-left. */
  mySide = 0;
  /** Tiles the current tool can act on, outlined while hovering. */
  canAct: (tile: number) => boolean = () => false;
  onTile: (tile: number) => void = () => {};
  onHover: (tile: number) => void = () => {};

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      background: PALETTE.page,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    parent.appendChild(this.app.canvas);
    this.world.addChild(this.ground, this.things, this.overlay, this.floaters);
    this.app.stage.addChild(this.world);
    this.app.renderer.on("resize", () => this.fit());
    this.fit();

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointermove", (e) => {
      const tile = this.tileAt(this.world.toLocal(e.global));
      if (tile !== this.hover) {
        this.hover = tile;
        this.onHover(tile);
      }
      this.app.canvas.style.cursor = tile !== -1 && this.canAct(tile) ? "pointer" : "";
    });
    this.app.stage.on("pointerleave", () => {
      this.hover = -1;
      this.onHover(-1);
    });
    this.app.stage.on("pointerdown", (e) => {
      const tile = this.tileAt(this.world.toLocal(e.global));
      if (tile !== -1) this.onTile(tile);
    });
    this.app.ticker.add((ticker) => this.frame(Math.min(0.1, ticker.deltaMS / 1000)));
  }

  setTiles(tiles: TileView[]): void {
    this.tiles = tiles;
  }

  addFx(events: Fx[]): void {
    for (const fx of events) {
      const color = fx.side === this.mySide ? PALETTE.me : PALETTE.them;
      if (fx.type === "harvest") {
        this.floatAt(fx.tile, `+1 ${CROP_ICONS[fx.crop]}`, PALETTE.white);
      } else if (fx.type === "buy") {
        this.flashes.push({ tile: fx.tile, color, age: 0, life: 0.5 });
      } else if (fx.type === "buyout") {
        this.flashes.push({ tile: fx.tile, color, age: 0, life: 1 });
        this.floatAt(fx.tile, "Bought out!", color);
      } else if (fx.type === "weeds") {
        for (const tile of fx.tiles) this.flashes.push({ tile, color: PALETTE.weeds, age: 0, life: 0.8 });
      } else if (fx.type === "crows") {
        for (const tile of fx.tiles) {
          const { x, y } = this.viewXY(tile);
          const fromLeft = x < COLS / 2;
          this.crows.push({ sx: fromLeft ? -2 : COLS + 2, sy: y - 3, tx: x, ty: y, age: 0, life: 1.4 });
          this.floatAt(tile, "Crows!", PALETTE.white, 0.6);
        }
      }
    }
  }

  /** Screen position of the centre of a tile. */
  tileOnScreen(tile: number): { x: number; y: number } {
    const { x, y } = this.viewXY(tile);
    const p = this.world.toGlobal({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
    return { x: p.x, y: p.y };
  }

  private viewTile(tile: number): number {
    return this.mySide === 1 ? mirror(tile) : tile;
  }

  private viewXY(tile: number): { x: number; y: number } {
    const v = this.viewTile(tile);
    return { x: tileX(v), y: tileY(v) };
  }

  private tileAt(p: { x: number; y: number }): number {
    const x = Math.floor(p.x / TILE);
    const y = Math.floor(p.y / TILE);
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return -1;
    // viewTile is its own inverse.
    return this.viewTile(y * COLS + x);
  }

  private fit() {
    const w = this.app.screen.width - INSET.left - INSET.right;
    const h = this.app.screen.height - INSET.top - INSET.bottom;
    const scale = Math.max(0.3, Math.min(w / BOARD_W, h / BOARD_H));
    this.world.scale.set(scale);
    this.world.position.set(INSET.left + (w - BOARD_W * scale) / 2, INSET.top + (h - BOARD_H * scale) / 2);
    this.app.stage.hitArea = this.app.screen;
  }

  private floatAt(tile: number, text: string, color: number, delay = 0) {
    const { x, y } = this.viewXY(tile);
    const label = new Text({
      text,
      style: { fontFamily: "Segoe UI, sans-serif", fontSize: 16, fontWeight: "700", fill: color, stroke: { color: PALETTE.ink, width: 3 } },
    });
    label.anchor.set(0.5);
    label.position.set((x + 0.5) * TILE, y * TILE + 8);
    label.alpha = 0;
    this.floaters.addChild(label);
    this.floating.push({ text: label, age: -delay, life: 1.1 });
  }

  private frame(dt: number) {
    this.time += dt;
    this.drawGround();
    this.drawThings();
    this.drawOverlay(dt);
    for (const f of this.floating) {
      f.age += dt;
      if (f.age < 0) continue;
      f.text.alpha = Math.max(0, 1 - f.age / f.life);
      f.text.y -= dt * 30;
    }
    for (const f of this.floating.filter((f) => f.age >= f.life)) f.text.destroy();
    this.floating = this.floating.filter((f) => f.age < f.life);
  }

  private drawGround() {
    const g = this.ground.clear();
    g.roundRect(-6, -6, BOARD_W + 12, BOARD_H + 12, 10).fill(0x5a4630);
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t) continue;
      const { x, y } = this.viewXY(tile);
      const px = x * TILE;
      const py = y * TILE;
      const checker = (x + y) % 2;
      const base = t.terrain === "rich" ? PALETTE.rich[checker] : PALETTE.grass[checker];
      g.rect(px, py, TILE, TILE).fill(t.terrain === "pond" ? PALETTE.pond : base);
      if (t.terrain === "pond") {
        g.ellipse(px + TILE * 0.35, py + TILE * 0.4, 8, 3).fill({ color: PALETTE.pondLight, alpha: 0.8 });
        g.ellipse(px + TILE * 0.65, py + TILE * 0.7, 6, 2).fill({ color: PALETTE.pondLight, alpha: 0.6 });
        continue;
      }
      if (t.owner !== -1 && t.terrain !== "rock") {
        g.roundRect(px + 3, py + 3, TILE - 6, TILE - 6, 5).fill(
          t.terrain === "rich" ? (t.wet ? PALETTE.soilRichWet : PALETTE.soilRich) : t.wet ? PALETTE.soilWet : PALETTE.soil,
        );
        for (let row = 0; row < 3; row++) g.rect(px + 8, py + 12 + row * 11, TILE - 16, 2).fill({ color: 0x000000, alpha: 0.12 });
      }
      if (t.terrain === "rich" && t.owner === -1) {
        for (const [dx, dy] of [[12, 14], [32, 20], [20, 34], [36, 38]]) g.circle(px + dx, py + dy, 2).fill(0x3e5a22);
      }
      if (t.terrain === "rock") {
        g.ellipse(px + TILE / 2, py + TILE * 0.58, 16, 11).fill(PALETTE.rockDark);
        g.ellipse(px + TILE / 2 - 2, py + TILE * 0.52, 14, 9).fill(PALETTE.rock);
      }
    }
    // Owner borders: outline each edge where ownership changes.
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t || t.owner === -1) continue;
      const { x, y } = this.viewXY(tile);
      const color = t.owner === this.mySide ? PALETTE.me : PALETTE.them;
      const ownerAt = (vx: number, vy: number) =>
        vx < 0 || vx >= COLS || vy < 0 || vy >= ROWS ? -2 : (this.tiles[this.viewTile(vy * COLS + vx)]?.owner ?? -2);
      const px = x * TILE;
      const py = y * TILE;
      const w = 3;
      if (ownerAt(x, y - 1) !== t.owner) g.rect(px, py, TILE, w).fill(color);
      if (ownerAt(x, y + 1) !== t.owner) g.rect(px, py + TILE - w, TILE, w).fill(color);
      if (ownerAt(x - 1, y) !== t.owner) g.rect(px, py, w, TILE).fill(color);
      if (ownerAt(x + 1, y) !== t.owner) g.rect(px + TILE - w, py, w, TILE).fill(color);
    }
  }

  private drawThings() {
    const g = this.things.clear();
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t) continue;
      const { x, y } = this.viewXY(tile);
      const cx = (x + 0.5) * TILE;
      const cy = (y + 0.5) * TILE;
      if (t.crop) drawCrop(g, t.crop as CropId, t.growth, cx, cy, this.time);
      if (t.building === "well") {
        g.circle(cx, cy, 15).fill(0x8d8577);
        g.circle(cx, cy, 10).fill(PALETTE.pond);
        g.rect(cx - 16, cy - 18, 32, 4).fill(0x6b4a2b);
      } else if (t.building === "scarecrow") {
        g.rect(cx - 2, cy - 14, 4, 30).fill(0x6b4a2b);
        g.rect(cx - 14, cy - 6, 28, 4).fill(0x6b4a2b);
        g.circle(cx, cy - 15, 7).fill(0xe8c547);
        g.poly([cx - 10, cy - 18, cx + 10, cy - 18, cx, cy - 28]).fill(0x8a5a2b);
      } else if (t.building === "silo") {
        g.roundRect(cx - 11, cy - 12, 22, 30, 3).fill(0xb3412e);
        g.ellipse(cx, cy - 12, 11, 8).fill(0xd8d2c4);
        g.rect(cx - 11, cy + 2, 22, 2).fill({ color: 0x000000, alpha: 0.2 });
      }
      if (t.weeds) {
        for (const [dx, dy] of [[-14, 10], [-4, 14], [8, 12], [15, 6], [-12, -8]]) {
          g.poly([cx + dx - 4, cy + dy + 4, cx + dx, cy + dy - 6, cx + dx + 4, cy + dy + 4]).fill(PALETTE.weeds);
        }
      }
      if (t.guarded) {
        g.roundRect(x * TILE + 6, y * TILE + 6, TILE - 12, TILE - 12, 6).stroke({ color: PALETTE.white, width: 2, alpha: 0.7 });
      }
    }
  }

  private drawOverlay(dt: number) {
    const g = this.overlay.clear();
    if (this.hover !== -1) {
      const { x, y } = this.viewXY(this.hover);
      const active = this.canAct(this.hover);
      g.roundRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2, 6).stroke({ color: PALETTE.hover, width: active ? 3 : 1.5, alpha: active ? 1 : 0.5 });
    }
    for (const f of this.flashes) {
      f.age += dt;
      const { x, y } = this.viewXY(f.tile);
      g.rect(x * TILE, y * TILE, TILE, TILE).fill({ color: f.color, alpha: 0.6 * Math.max(0, 1 - f.age / f.life) });
    }
    this.flashes = this.flashes.filter((f) => f.age < f.life);
    for (const c of this.crows) {
      c.age += dt;
      const k = Math.min(1, c.age / (c.life * 0.6));
      const leaving = Math.max(0, (c.age - c.life * 0.6) / (c.life * 0.4));
      const px = (c.sx + (c.tx - c.sx) * k + leaving * 4 + 0.5) * TILE;
      const py = (c.sy + (c.ty - c.sy) * k - leaving * 4 + 0.5) * TILE;
      const flap = Math.sin(this.time * 30) * 6;
      g.poly([px - 14, py - flap, px, py + 2, px + 14, py - flap, px, py - 4]).fill(PALETTE.crow);
      g.circle(px, py, 4).fill(PALETTE.crow);
    }
    this.crows = this.crows.filter((c) => c.age < c.life);
  }
}

export const CROP_ICONS: Record<CropId, string> = { wheat: "🌾", carrot: "🥕", pumpkin: "🎃", berries: "🫐" };

/** Draws a crop that grows from a sprout into its ripe shape. */
function drawCrop(g: Graphics, crop: CropId, growth: number, cx: number, cy: number, time: number) {
  const k = 0.35 + 0.65 * (growth / 100);
  const ripe = growth >= 100;
  const bob = ripe ? Math.sin(time * 4 + cx) * 1.5 : 0;
  if (!ripe) {
    // Sprout: two leaves on a stem, plus a progress bar.
    g.rect(cx - 1, cy + 8 - 14 * k, 2, 14 * k).fill(PALETTE.leaf);
    g.ellipse(cx - 5 * k, cy + 8 - 12 * k, 5 * k, 3 * k).fill(PALETTE.leaf);
    g.ellipse(cx + 5 * k, cy + 8 - 14 * k, 5 * k, 3 * k).fill(PALETTE.leaf);
    g.rect(cx - 15, cy + 14, 30, 4).fill({ color: 0x000000, alpha: 0.3 });
    g.rect(cx - 15, cy + 14, (30 * growth) / 100, 4).fill(PALETTE[crop]);
    return;
  }
  const y = cy + bob;
  if (crop === "wheat") {
    for (const dx of [-9, 0, 9]) {
      g.rect(cx + dx - 1, y - 6, 2, 18).fill(0xb89a3a);
      g.ellipse(cx + dx, y - 10, 4, 9).fill(PALETTE.wheat);
    }
  } else if (crop === "carrot") {
    g.poly([cx - 8, y - 4, cx + 8, y - 4, cx, y + 16]).fill(PALETTE.carrot);
    g.ellipse(cx - 4, y - 9, 3, 7).fill(PALETTE.leaf);
    g.ellipse(cx + 4, y - 9, 3, 7).fill(PALETTE.leaf);
  } else if (crop === "pumpkin") {
    g.ellipse(cx, y + 4, 16, 12).fill(PALETTE.pumpkin);
    g.ellipse(cx, y + 4, 6, 12).fill({ color: 0x000000, alpha: 0.12 });
    g.rect(cx - 2, y - 11, 4, 6).fill(0x5a7d2a);
  } else {
    g.circle(cx, y + 2, 15).fill(0x3f7a33);
    for (const [dx, dy] of [[-6, -2], [5, -5], [7, 6], [-4, 8], [0, 1]]) g.circle(cx + dx, y + dy, 3.5).fill(PALETTE.berries);
  }
  // A white ring tells ripe crops apart at a glance.
  g.circle(cx, cy, 21).stroke({ color: PALETTE.white, width: 2, alpha: 0.35 + 0.25 * Math.sin(time * 4) });
}

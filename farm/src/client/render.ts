import { Application, Container, Graphics, RenderTexture, Sprite, Text } from "pixi.js";
import { COLS, type CropId, type Fx, ROWS, TILE_COUNT, mirror, tileX, tileY } from "../shared/sim";

export const PALETTE = {
  page: 0x2c2418,
  me: 0x3d8bff,
  meDark: 0x1c4a9c,
  them: 0xf0573f,
  themDark: 0x8f2a1f,
  hover: 0xfff3c4,
  white: 0xfff6d8,
  ink: 0x24180f,
  wheat: 0xf2cf55,
  carrot: 0xf08a24,
  pumpkin: 0xe8711c,
  berries: 0x9b55c8,
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
  tile: number;
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
  /** Board position in tiles, flying from (sx, sy) to the target. */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  age: number;
  life: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  color: number;
  age: number;
  life: number;
}

/**
 * The board is pixel art: it is drawn at TILE art pixels per tile into a small
 * texture, which is then scaled up with nearest-neighbour filtering.
 */
const TILE = 16;
/** Wooden frame around the board, in art pixels. */
const FRAME = 6;
const BOARD_W = COLS * TILE;
const BOARD_H = ROWS * TILE;
const ART_W = BOARD_W + FRAME * 2;
const ART_H = BOARD_H + FRAME * 2;
/** Screen space the DOM HUD covers around the board. */
const INSET = { left: 16, right: 336, top: 64, bottom: 100 };

// ---------------------------------------------------------------------------
// Pixel art. Each character in a sprite row is one art pixel; "." is clear.

const INK: Record<string, number> = {
  k: 0x24180f,
  w: 0xfff6d8,
  g: 0x2f6b2f,
  G: 0x5aa340,
  L: 0x9fd45c,
  y: 0xb88a28,
  Y: 0xf2cf55,
  H: 0xfff09a,
  o: 0xb04e18,
  O: 0xf08a24,
  P: 0xffb35c,
  b: 0x3d1f5c,
  B: 0x8a46b8,
  V: 0xc890ec,
  s: 0x4a4540,
  S: 0x7f786f,
  T: 0xb3ab9f,
  U: 0xe0d8c8,
  d: 0x4f3220,
  D: 0x7a4e2c,
  E: 0xa8743f,
  r: 0x7a2318,
  R: 0xc0392b,
  Q: 0xe8664f,
  a: 0x2b5e8c,
  A: 0x4f93c9,
  C: 0x9fd3f0,
  n: 0xd9b45a,
  N: 0xf2dc8a,
  m: 0x1d1d26,
  M: 0x45455a,
  x: 0x3f6b1f,
  z: 0x9fd03f,
};

interface Art {
  w: number;
  h: number;
  /** Horizontal runs of one colour: x, y, length, colour. */
  runs: [number, number, number, number][];
}

/** Turns sprite rows into colour runs, adding a dark outline around the shape. */
function art(rows: string[], outline = true): Art {
  const pad = outline ? 1 : 0;
  const w = Math.max(...rows.map((r) => r.length)) + pad * 2;
  const h = rows.length + pad * 2;
  const cell = (x: number, y: number) => rows[y - pad]?.[x - pad] ?? ".";
  const grid: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      let c = cell(x, y);
      if (c === "." && outline && [cell(x - 1, y), cell(x + 1, y), cell(x, y - 1), cell(x, y + 1)].some((n) => n !== ".")) c = "k";
      row.push(c);
    }
    grid.push(row);
  }
  const runs: Art["runs"] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; ) {
      const c = grid[y][x];
      let end = x + 1;
      while (end < w && grid[y][end] === c) end++;
      if (c !== ".") runs.push([x, y, end - x, INK[c]]);
      x = end;
    }
  }
  return { w, h, runs };
}

const SPROUT = art(["L...L", "GG.GG", ".GGG.", "..g.."]);

const YOUNG: Record<CropId, Art> = {
  wheat: art([".G...G...G", ".G..LG...G", ".GG.G..GG.", "..GGG.GG..", "...GGGG...", "....gg...."]),
  carrot: art(["..L.L.L..", "..GLGLG..", "...GGG...", "..G.G.G..", "...ggg..."]),
  pumpkin: art(["..GG......", ".GLGG...G.", "..GGgggGLG", "....g...GG", "....O....."]),
  berries: art(["...gGGg...", ".gGGLGGg..", "gGLGGGGGg.", "gGGGGLGGGg", ".gGGGGGGg.", "..gggggg.."]),
};

const RIPE: Record<CropId, Art> = {
  wheat: art([
    ".H...H...H.",
    "HYy.HYy.HYy",
    "YYy.YYy.YYy",
    "HYy.HYy.HYy",
    "YYy.YYy.YYy",
    ".y...y...y.",
    ".G...G...G.",
    ".G..GG..G..",
    ".GG.G..GG..",
    "..GGG.GG...",
    "...GGGG....",
    "....gg.....",
  ]),
  carrot: art([
    "..L.L.L...",
    ".GLGLGLG..",
    "..GGGGG...",
    ".L.GGG.L..",
    "..GGgGG...",
    "...ggg....",
    "..POOOO...",
    "..OOOOo...",
    "...OOo....",
    "...Oo.....",
    "....o.....",
  ]),
  pumpkin: art([
    "......dGG....",
    ".....dDGLG...",
    "...oOOoOOo...",
    "..oPOOoOOOo..",
    ".oPPOoOOoOOo.",
    ".oPOOoOOoOOo.",
    ".oOOOoOOoOOo.",
    ".ooOOoOOoOoo.",
    "..ooOooOooo..",
    "...ooooooo...",
  ]),
  berries: art([
    "....gGGg....",
    "..gGGLGGGg..",
    ".gGBVGGGBVg.",
    ".GGbBGLGbBG.",
    "gGLGGGBVGGGg",
    "gGGGBVbBGLGg",
    ".gGBVGGGGGg.",
    "..gbBGGBVg..",
    "...ggGGbBg..",
    "....gggg....",
  ]),
};

const ROCK = art([
  "....TTUU....",
  "..STTTTUUT..",
  ".STTTSTTTTT.",
  "SSTTSSSTTTTS",
  "sSSTTSSTTTSS",
  "sSSSSSSSSSSs",
  ".ssSSssSSss.",
  "..ssssssss..",
]);

const WELL = art([
  ".dddddddddd.",
  "dEEEEEEEEEEd",
  "dDDDDDDDDDDd",
  "..D......D..",
  "..D..kk..D..",
  "..D..d...D..",
  ".UTTTTTTTTU.",
  "TUAAAAAAAAUT",
  "STaaAACaaaTS",
  "STTSTTTSTTTS",
  "sSSsSSSsSSSs",
  ".ssssssssss.",
]);

const SCARECROW = art([
  "....nNn....",
  "...nNNNn...",
  ".nnnnnnnnn.",
  "....EEE....",
  "....kEk....",
  "....EEE....",
  "NnRRRRRRRnN",
  "...RRQRR...",
  "...RRRRR...",
  "....RRR....",
  ".....d.....",
  ".....d.....",
]);

const SILO = art([
  "...TUUT...",
  "..TTTUUT..",
  ".TTTTTTUT.",
  ".SSSSSSSS.",
  ".QRRRRRRr.",
  ".QRRRRRRr.",
  ".wwwwwwww.",
  ".QRRRRRRr.",
  ".QRRRRRRr.",
  ".QRRddRRr.",
  ".QRRddRRr.",
]);

const BUILDINGS: Record<string, Art> = { well: WELL, scarecrow: SCARECROW, silo: SILO };

const WEED = art([".B.", "zxz", "xzx"]);

/** Two wing frames, facing right. */
const CROW_ROWS = [
  ["M.........M", "mM.......Mm", ".mmM...Mmm.", "..mmmmmmmm.", "...mmMmmmmY", "....mmmm..."],
  ["....mmm....", "...mmmmmmmY", ".mmMmMmmm..", "mmM.....Mm.", "mM.......mm", "M.........M"],
];
const flip = (rows: string[]) => rows.map((r) => [...r].reverse().join(""));
const CROW = { right: CROW_ROWS.map((r) => art(r, false)), left: CROW_ROWS.map((r) => art(flip(r), false)) };

// ---------------------------------------------------------------------------
// Terrain colours.

const GROUND = {
  grass: [0x5a9e3f, 0x579a3c],
  grassDark: 0x447f30,
  grassLight: 0x86c252,
  rich: [0x437c31, 0x40782f],
  richDark: 0x2f5e24,
  richLight: 0x6aa043,
  water: 0x3f7fb5,
  waterDeep: 0x2f6aa0,
  waterLight: 0x9fd3f0,
  bank: 0x2f5a26,
  flowers: [0xfff6d8, 0xf2cf55, 0xf29ac0, 0x9fd3f0],
};

/** Soil shades per kind: [shadow, base, ridge]. */
const SOIL = {
  dry: [0x5e3d26, 0x7d5636, 0x9a7048],
  wet: [0x3f2715, 0x553520, 0x6e4a2c],
  rich: [0x3a2216, 0x553424, 0x6e4a34],
  richWet: [0x24140c, 0x37221a, 0x4a3226],
};

const FRAME_WOOD = { dark: 0x3a2614, mid: 0x6b4426, light: 0x9a6a3c };

/** A small integer hash, so decorations stay put from frame to frame. */
function hash(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

export class Renderer {
  readonly app = new Application();
  /** The board in art pixels, rendered into `canvas` each frame. */
  private world = new Container();
  private ground = new Graphics();
  private things = new Graphics();
  private anim = new Graphics();
  private canvas = RenderTexture.create({ width: ART_W, height: ART_H, scaleMode: "nearest", antialias: false });
  private board = new Sprite(this.canvas);
  private shadow = new Graphics();
  private floaters = new Container();
  private floating: Floater[] = [];
  private flashes: Flash[] = [];
  private crows: Crow[] = [];
  private particles: Particle[] = [];
  private tiles: TileView[] = [];
  private groundKey = "";
  private thingsKey = "";
  private hover = -1;
  private time = 0;
  private seed = 1;

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
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    parent.appendChild(this.app.canvas);
    this.world.addChild(this.ground, this.things, this.anim);
    this.app.stage.addChild(this.shadow, this.board, this.floaters);
    this.app.renderer.on("resize", () => this.fit());
    this.fit();

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointermove", (e) => {
      const tile = this.tileAt(this.board.toLocal(e.global));
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
      const tile = this.tileAt(this.board.toLocal(e.global));
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
        this.burst(fx.tile, [PALETTE[fx.crop], PALETTE[fx.crop], PALETTE.white, INK.L], 10, 50);
      } else if (fx.type === "buy") {
        this.flashes.push({ tile: fx.tile, color, age: 0, life: 0.5 });
        this.burst(fx.tile, [color, PALETTE.white, SOIL.dry[2]], 12, 40);
      } else if (fx.type === "buyout") {
        this.flashes.push({ tile: fx.tile, color, age: 0, life: 1 });
        this.floatAt(fx.tile, "Bought out!", color);
        this.burst(fx.tile, [color, PALETTE.white, INK.Y], 20, 60);
      } else if (fx.type === "weeds") {
        for (const tile of fx.tiles) {
          this.flashes.push({ tile, color: INK.x, age: 0, life: 0.8 });
          this.burst(tile, [INK.x, INK.z, INK.B], 6, 30);
        }
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
    const p = this.board.toGlobal({ x: FRAME + (x + 0.5) * TILE, y: FRAME + (y + 0.5) * TILE });
    return { x: p.x, y: p.y };
  }

  private viewTile(tile: number): number {
    return this.mySide === 1 ? mirror(tile) : tile;
  }

  private viewXY(tile: number): { x: number; y: number } {
    const v = this.viewTile(tile);
    return { x: tileX(v), y: tileY(v) };
  }

  /** The tile under a point in art pixels. */
  private tileAt(p: { x: number; y: number }): number {
    const x = Math.floor((p.x - FRAME) / TILE);
    const y = Math.floor((p.y - FRAME) / TILE);
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return -1;
    // viewTile is its own inverse.
    return this.viewTile(y * COLS + x);
  }

  private fit() {
    const w = this.app.screen.width - INSET.left - INSET.right;
    const h = this.app.screen.height - INSET.top - INSET.bottom;
    const res = this.app.renderer.resolution;
    let scale = Math.max(0.5, Math.min(w / ART_W, h / ART_H));
    // Whole device pixels per art pixel keep every pixel the same size.
    if (scale * res >= 2) scale = Math.floor(scale * res) / res;
    const snap = (v: number) => Math.round(v * res) / res;
    this.board.scale.set(scale);
    this.board.position.set(snap(INSET.left + (w - ART_W * scale) / 2), snap(INSET.top + (h - ART_H * scale) / 2));
    this.shadow
      .clear()
      .rect(this.board.x + scale * 3, this.board.y + scale * 4, ART_W * scale, ART_H * scale)
      .fill({ color: 0x000000, alpha: 0.35 });
    this.app.stage.hitArea = this.app.screen;
  }

  private floatAt(tile: number, text: string, color: number, delay = 0) {
    const label = new Text({
      text,
      style: {
        fontFamily: "Consolas, 'Courier New', monospace",
        fontSize: 18,
        fontWeight: "900",
        fill: color,
        stroke: { color: PALETTE.ink, width: 5, join: "miter" },
      },
    });
    label.anchor.set(0.5);
    label.alpha = 0;
    this.floaters.addChild(label);
    this.floating.push({ text: label, tile, age: -delay, life: 1.1 });
  }

  private random(): number {
    this.seed = hash(this.seed + 0x9e3779b9);
    return this.seed / 4294967296;
  }

  /** Throws a few pixels out of a tile. */
  private burst(tile: number, colors: number[], count: number, speed: number) {
    const { x, y } = this.viewXY(tile);
    for (let i = 0; i < count; i++) {
      const angle = this.random() * Math.PI * 2;
      const v = speed * (0.4 + this.random() * 0.6);
      this.particles.push({
        x: FRAME + x * TILE + 4 + this.random() * 8,
        y: FRAME + y * TILE + 4 + this.random() * 8,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v - speed * 0.6,
        gravity: 140,
        color: colors[i % colors.length],
        age: 0,
        life: 0.5 + this.random() * 0.4,
      });
    }
  }

  private frame(dt: number) {
    this.time += dt;
    const groundKey = this.mySide + this.tiles.map((t) => `${t.terrain[0]}${t.owner}${+t.wet}${t.building[0] ?? ""}`).join();
    if (groundKey !== this.groundKey) {
      this.groundKey = groundKey;
      this.drawGround();
    }
    // Ripe crops bob a pixel a few times a second, so things only redraw on that beat.
    const thingsKey = `${this.mySide}${Math.floor(this.time * 3)}${this.tiles.map((t) => `${t.crop}${t.growth}${t.building}${+t.weeds}`).join()}`;
    if (thingsKey !== this.thingsKey) {
      this.thingsKey = thingsKey;
      this.drawThings();
    }
    this.drawAnim(dt);
    this.app.renderer.render({ container: this.world, target: this.canvas, clear: true });

    const scale = this.board.scale.x;
    for (const f of this.floating) {
      f.age += dt;
      if (f.age < 0) continue;
      const p = this.tileOnScreen(f.tile);
      // Rise in whole art pixels, like the board.
      f.text.position.set(p.x, p.y - (6 + Math.floor(f.age * 14)) * scale);
      f.text.alpha = f.age > f.life * 0.6 ? 0.5 : 1;
    }
    for (const f of this.floating.filter((f) => f.age >= f.life)) f.text.destroy();
    this.floating = this.floating.filter((f) => f.age < f.life);
  }

  private ownerAt(vx: number, vy: number): number {
    if (vx < 0 || vx >= COLS || vy < 0 || vy >= ROWS) return -2;
    return this.tiles[this.viewTile(vy * COLS + vx)]?.owner ?? -2;
  }

  private terrainAt(vx: number, vy: number): string {
    if (vx < 0 || vx >= COLS || vy < 0 || vy >= ROWS) return "";
    return this.tiles[this.viewTile(vy * COLS + vx)]?.terrain ?? "";
  }

  private drawGround() {
    const g = this.ground.clear();
    // Wooden frame with plank seams.
    g.rect(0, 0, ART_W, ART_H).fill(FRAME_WOOD.dark);
    g.rect(1, 1, ART_W - 2, ART_H - 2).fill(FRAME_WOOD.mid);
    g.rect(1, 1, ART_W - 2, 1).fill(FRAME_WOOD.light);
    g.rect(1, 1, 1, ART_H - 2).fill(FRAME_WOOD.light);
    for (let x = 14; x < ART_W - 4; x += 22) {
      g.rect(x, 1, 1, FRAME - 2).fill(FRAME_WOOD.dark);
      g.rect(x + 7, ART_H - FRAME + 1, 1, FRAME - 2).fill(FRAME_WOOD.dark);
    }
    for (let y = 18; y < ART_H - 4; y += 22) {
      g.rect(1, y, FRAME - 2, 1).fill(FRAME_WOOD.dark);
      g.rect(ART_W - FRAME + 1, y + 7, FRAME - 2, 1).fill(FRAME_WOOD.dark);
    }
    g.rect(FRAME - 1, FRAME - 1, BOARD_W + 2, BOARD_H + 2).fill(FRAME_WOOD.dark);

    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t) continue;
      const { x, y } = this.viewXY(tile);
      const px = FRAME + x * TILE;
      const py = FRAME + y * TILE;
      const h = hash(x * 131 + y * 977 + 7);
      if (t.terrain === "pond") {
        this.drawPond(g, x, y, px, py);
        continue;
      }
      drawGrass(g, px, py, x, y, h, t.terrain === "rich");
      if (t.terrain === "rock") {
        drawArt(g, ROCK, px + 2, py + 4, true);
      } else if (t.owner !== -1) {
        drawSoil(g, px, py, h, t.terrain === "rich" ? (t.wet ? SOIL.richWet : SOIL.rich) : t.wet ? SOIL.wet : SOIL.dry, t.wet, !!t.building);
      }
    }

    // Owner fences: a line where ownership changes, with posts at the corners.
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t || t.owner === -1) continue;
      const { x, y } = this.viewXY(tile);
      const mine = t.owner === this.mySide;
      const color = mine ? PALETTE.me : PALETTE.them;
      const dark = mine ? PALETTE.meDark : PALETTE.themDark;
      const px = FRAME + x * TILE;
      const py = FRAME + y * TILE;
      const edges = [
        [this.ownerAt(x, y - 1) !== t.owner, px, py, TILE, 1],
        [this.ownerAt(x, y + 1) !== t.owner, px, py + TILE - 1, TILE, 1],
        [this.ownerAt(x - 1, y) !== t.owner, px, py, 1, TILE],
        [this.ownerAt(x + 1, y) !== t.owner, px + TILE - 1, py, 1, TILE],
      ] as const;
      for (const [open, ex, ey, ew, eh] of edges) if (open) g.rect(ex, ey, ew, eh).fill(color);
      const posts = [
        [edges[0][0] || edges[2][0], px, py],
        [edges[0][0] || edges[3][0], px + TILE - 2, py],
        [edges[1][0] || edges[2][0], px, py + TILE - 2],
        [edges[1][0] || edges[3][0], px + TILE - 2, py + TILE - 2],
      ] as const;
      for (const [on, ex, ey] of posts) {
        if (!on) continue;
        g.rect(ex, ey, 2, 2).fill(dark);
        g.rect(ex, ey, 1, 1).fill(PALETTE.white);
      }
    }
  }

  private drawPond(g: Graphics, x: number, y: number, px: number, py: number) {
    const water = (dx: number, dy: number) => this.terrainAt(x + dx, y + dy) === "pond";
    g.rect(px, py, TILE, TILE).fill(GROUND.water);
    // The far bank shades the water below it.
    if (!water(0, -1)) {
      g.rect(px, py, TILE, 2).fill(GROUND.bank);
      g.rect(px, py + 2, TILE, 2).fill(GROUND.waterDeep);
    }
    if (!water(0, 1)) g.rect(px, py + TILE - 1, TILE, 1).fill(GROUND.waterLight);
    if (!water(-1, 0)) g.rect(px, py, 1, TILE).fill(GROUND.waterLight);
    if (!water(1, 0)) g.rect(px + TILE - 1, py, 1, TILE).fill(GROUND.waterLight);
    // Round off outside corners with grass.
    const grass = GROUND.grass[(x + y) % 2];
    for (const [dx, dy, cx, cy] of [
      [-1, -1, 0, 0],
      [1, -1, TILE - 2, 0],
      [-1, 1, 0, TILE - 2],
      [1, 1, TILE - 2, TILE - 2],
    ]) {
      if (water(dx, 0) || water(0, dy)) continue;
      g.rect(px + cx, py + cy, 2, 2).fill(grass);
      g.rect(px + (dx < 0 ? cx + 1 : cx), py + (dy < 0 ? cy + 1 : cy), 1, 1).fill(dy < 0 ? GROUND.bank : GROUND.waterLight);
    }
    // A lily pad on some tiles.
    const h = hash(x * 53 + y * 311);
    if (h % 3 === 0) {
      const lx = px + 4 + (h % 7);
      const ly = py + 6 + ((h >>> 4) % 6);
      g.rect(lx, ly, 3, 2).fill(INK.G);
      g.rect(lx + 1, ly - 1, 2, 1).fill(INK.G);
      g.rect(lx + 2, ly, 1, 1).fill(GROUND.water);
      if (h % 2) g.rect(lx, ly - 1, 1, 1).fill(GROUND.flowers[2]);
    }
  }

  private drawThings() {
    const g = this.things.clear();
    const beat = Math.floor(this.time * 3);
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const t = this.tiles[tile];
      if (!t) continue;
      const { x, y } = this.viewXY(tile);
      const px = FRAME + x * TILE;
      const py = FRAME + y * TILE;
      const building = BUILDINGS[t.building];
      if (building) drawArt(g, building, px + 8 - Math.floor(building.w / 2), py + 15 - building.h, true);
      if (t.crop) {
        const crop = t.crop as CropId;
        if (t.growth >= 100) {
          const sprite = RIPE[crop];
          const bob = (beat + tile) % 4 === 0 ? 1 : 0;
          drawArt(g, sprite, px + 8 - Math.floor(sprite.w / 2), py + 15 - sprite.h - bob, true);
        } else {
          const sprite = t.growth < 35 ? SPROUT : YOUNG[crop];
          drawArt(g, sprite, px + 8 - Math.floor(sprite.w / 2), py + 12 - sprite.h, false);
          // Progress bar.
          g.rect(px + 2, py + 12, 12, 3).fill(PALETTE.ink);
          g.rect(px + 3, py + 13, Math.max(1, Math.floor((10 * t.growth) / 100)), 1).fill(PALETTE[crop]);
        }
      }
      if (t.weeds) {
        for (const [dx, dy] of [[1, 9], [9, 10], [5, 3], [11, 2]]) drawArt(g, WEED, px + dx, py + dy, false);
      }
    }
  }

  private drawAnim(dt: number) {
    const g = this.anim.clear();
    const t = this.time;

    // Water ripples and ripe-crop twinkles.
    for (let tile = 0; tile < TILE_COUNT; tile++) {
      const v = this.tiles[tile];
      if (!v) continue;
      const { x, y } = this.viewXY(tile);
      const px = FRAME + x * TILE;
      const py = FRAME + y * TILE;
      const h = hash(tile * 17 + 3);
      if (v.terrain === "pond") {
        for (let i = 0; i < 2; i++) {
          const phase = Math.floor(t * 1.5 + (h >>> (i * 4)) % 8);
          const rx = px + 3 + ((h >>> (i * 7)) + phase) % 9;
          const ry = py + 6 + i * 5 + ((h >>> 3) % 2);
          if (phase % 4 !== 0) g.rect(rx, ry, phase % 4 === 2 ? 4 : 2, 1).fill(GROUND.waterLight);
        }
      } else if (v.crop && v.growth >= 100) {
        const cycle = (t + (h % 100) / 40) % 2.5;
        if (cycle < 0.4) {
          const sx = px + 3 + (h % 10);
          const sy = py + 1 + ((h >>> 5) % 5);
          const big = cycle > 0.12 && cycle < 0.28;
          g.rect(sx, sy, 1, 1).fill(PALETTE.white);
          if (big) {
            g.rect(sx - 1, sy, 3, 1).fill(PALETTE.white);
            g.rect(sx, sy - 1, 1, 3).fill(PALETTE.white);
          }
        }
      }
      if (v.guarded) {
        // Blinking shield brackets while a bought-out tile is safe.
        if (Math.floor(t * 2) % 2 === 0) drawBrackets(g, px + 1, py + 1, TILE - 2, PALETTE.white, 1);
      }
    }

    // Slow cloud shadows drifting over the field.
    for (let i = 0; i < 3; i++) {
      const cx = Math.floor(((t * (4 + i) + i * 97) % (BOARD_W + 80)) - 40) + FRAME;
      const cy = FRAME + 20 + i * 62;
      g.rect(cx, cy, 30, 8).fill({ color: 0x000000, alpha: 0.06 });
      g.rect(cx + 6, cy - 4, 16, 16).fill({ color: 0x000000, alpha: 0.06 });
    }

    // A pair of butterflies.
    for (let i = 0; i < 2; i++) {
      const bx = Math.floor(FRAME + BOARD_W / 2 + Math.sin(t * 0.23 + i * 3) * BOARD_W * 0.42 + Math.sin(t * 1.7 + i) * 6);
      const by = Math.floor(FRAME + BOARD_H / 2 + Math.sin(t * 0.31 + i * 5) * BOARD_H * 0.4 + Math.cos(t * 2.1 + i) * 4);
      const color = i === 0 ? PALETTE.white : INK.Y;
      if (Math.floor(t * 8 + i) % 2) {
        g.rect(bx - 1, by, 1, 1).fill(color);
        g.rect(bx + 1, by, 1, 1).fill(color);
      } else {
        g.rect(bx - 2, by - 1, 2, 2).fill(color);
        g.rect(bx + 1, by - 1, 2, 2).fill(color);
      }
      g.rect(bx, by, 1, 1).fill(PALETTE.ink);
    }

    if (this.hover !== -1) {
      const { x, y } = this.viewXY(this.hover);
      const px = FRAME + x * TILE;
      const py = FRAME + y * TILE;
      if (this.canAct(this.hover)) {
        const pulse = Math.floor(t * 3) % 2;
        g.rect(px, py, TILE, TILE).fill({ color: PALETTE.hover, alpha: 0.15 });
        drawBrackets(g, px - pulse, py - pulse, TILE + pulse * 2, PALETTE.hover, 1);
      } else {
        drawBrackets(g, px, py, TILE, PALETTE.hover, 0.4);
      }
    }

    for (const f of this.flashes) {
      f.age += dt;
      const { x, y } = this.viewXY(f.tile);
      // Fade in steps rather than smoothly.
      const alpha = 0.6 * Math.ceil(4 * Math.max(0, 1 - f.age / f.life)) / 4;
      g.rect(FRAME + x * TILE, FRAME + y * TILE, TILE, TILE).fill({ color: f.color, alpha });
    }
    this.flashes = this.flashes.filter((f) => f.age < f.life);

    for (const p of this.particles) {
      p.age += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const size = p.age < p.life * 0.4 ? 2 : 1;
      g.rect(Math.floor(p.x), Math.floor(p.y), size, size).fill(p.color);
    }
    this.particles = this.particles.filter((p) => p.age < p.life);

    for (const c of this.crows) {
      c.age += dt;
      const k = Math.min(1, c.age / (c.life * 0.6));
      const leaving = Math.max(0, (c.age - c.life * 0.6) / (c.life * 0.4));
      const cx = FRAME + (c.sx + (c.tx - c.sx) * k + leaving * 4 + 0.5) * TILE;
      const cy = FRAME + (c.sy + (c.ty - c.sy) * k - leaving * 4 + 0.5) * TILE;
      const facing = leaving > 0 || c.tx > c.sx ? CROW.right : CROW.left;
      const sprite = facing[Math.floor(this.time * 10) % 2];
      g.rect(Math.floor(cx) - 4, Math.floor(cy) + 9, 8, 2).fill({ color: 0x000000, alpha: 0.25 });
      drawArt(g, sprite, Math.floor(cx) - 5, Math.floor(cy) - 3, false);
    }
    this.crows = this.crows.filter((c) => c.age < c.life);
  }
}

export const CROP_ICONS: Record<CropId, string> = { wheat: "🌾", carrot: "🥕", pumpkin: "🎃", berries: "🫐" };

function drawArt(g: Graphics, a: Art, x: number, y: number, shadow: boolean) {
  if (shadow) g.rect(x + 2, y + a.h - 2, a.w - 4, 2).fill({ color: 0x000000, alpha: 0.25 });
  for (const [rx, ry, len, color] of a.runs) g.rect(x + rx, y + ry, len, 1).fill(color);
}

/** Four corner brackets around a square. */
function drawBrackets(g: Graphics, x: number, y: number, size: number, color: number, alpha: number) {
  const arm = 4;
  const fill = { color, alpha };
  const far = size - 1;
  g.rect(x, y, arm, 1).fill(fill).rect(x, y + 1, 1, arm - 1).fill(fill);
  g.rect(x + size - arm, y, arm, 1).fill(fill).rect(x + far, y + 1, 1, arm - 1).fill(fill);
  g.rect(x, y + far, arm, 1).fill(fill).rect(x, y + size - arm, 1, arm - 1).fill(fill);
  g.rect(x + size - arm, y + far, arm, 1).fill(fill).rect(x + far, y + size - arm, 1, arm - 1).fill(fill);
}

function drawGrass(g: Graphics, px: number, py: number, x: number, y: number, h: number, rich: boolean) {
  const base = rich ? GROUND.rich : GROUND.grass;
  const dark = rich ? GROUND.richDark : GROUND.grassDark;
  const light = rich ? GROUND.richLight : GROUND.grassLight;
  g.rect(px, py, TILE, TILE).fill(base[(x + y) % 2]);
  // Grass tufts: a dark root with two light blades.
  for (let i = 0; i < 3; i++) {
    const v = hash(h + i * 7919);
    const bx = px + 1 + (v % 13);
    const by = py + 2 + ((v >>> 8) % 13);
    g.rect(bx, by, 1, 1).fill(dark);
    g.rect(bx - 1, by - 1, 1, 1).fill(light);
    g.rect(bx + 1, by - 1, 1, 1).fill(light);
  }
  if (rich) {
    // Dark loam showing through, and the odd clover.
    for (let i = 0; i < 3; i++) {
      const v = hash(h + i * 104729);
      g.rect(px + 1 + (v % 13), py + 1 + ((v >>> 9) % 14), 1, 1).fill(SOIL.rich[1]);
    }
    if (h % 4 === 0) {
      const cx = px + 3 + ((h >>> 6) % 9);
      const cy = py + 3 + ((h >>> 11) % 9);
      g.rect(cx, cy, 1, 1).fill(light).rect(cx + 2, cy, 1, 1).fill(light).rect(cx + 1, cy + 1, 1, 1).fill(light);
    }
  } else if (h % 3 === 0) {
    const fx = px + 2 + ((h >>> 5) % 11);
    const fy = py + 3 + ((h >>> 10) % 10);
    const petal = GROUND.flowers[(h >>> 14) % GROUND.flowers.length];
    g.rect(fx, fy + 1, 1, 1).fill(dark);
    g.rect(fx - 1, fy, 3, 1).fill(petal);
    g.rect(fx, fy - 1, 1, 1).fill(petal);
    g.rect(fx, fy, 1, 1).fill(INK.Y);
  }
}

/** A tilled plot with furrows, inset a pixel so neighbouring plots read apart. */
function drawSoil(g: Graphics, px: number, py: number, h: number, shades: number[], wet: boolean, building: boolean) {
  const [shadow, base, ridge] = shades;
  g.rect(px + 1, py + 1, TILE - 2, TILE - 2).fill(base);
  g.rect(px + 1, py + TILE - 2, TILE - 2, 1).fill(shadow);
  g.rect(px + TILE - 2, py + 1, 1, TILE - 2).fill(shadow);
  g.rect(px + 1, py + 1, TILE - 2, 1).fill(ridge);
  for (const [cx, cy] of [[1, 1], [TILE - 2, 1], [1, TILE - 2], [TILE - 2, TILE - 2]]) g.rect(px + cx, py + cy, 1, 1).fill(shadow);
  if (building) {
    for (let i = 0; i < 3; i++) {
      const v = hash(h + i * 31);
      g.rect(px + 3 + (v % 9), py + 3 + ((v >>> 7) % 9), 1, 1).fill(ridge);
    }
    return;
  }
  // Rows of hoed mounds, staggered so the plot reads as soil, not planks.
  for (const [row, fy] of [3, 7, 11].entries()) {
    for (let mx = (row % 2) * 2; mx < TILE - 2; mx += 4) {
      const x0 = Math.max(px + 2, px + mx);
      const x1 = Math.min(px + TILE - 2, px + mx + 3);
      if (x1 <= x0) continue;
      g.rect(x0, py + fy, x1 - x0, 1).fill(ridge);
      g.rect(x0, py + fy + 1, x1 - x0, 1).fill(shadow);
    }
  }
  // Wet soil glints, dry soil gets the odd pebble.
  const v = hash(h + 5);
  if (wet) {
    g.rect(px + 3 + (v % 8), py + 5, 2, 1).fill({ color: 0x9fd3f0, alpha: 0.35 });
    g.rect(px + 4 + ((v >>> 6) % 8), py + 9, 2, 1).fill({ color: 0x9fd3f0, alpha: 0.35 });
  } else {
    g.rect(px + 3 + (v % 10), py + 6 + ((v >>> 6) % 2) * 4, 1, 1).fill(INK.T);
  }
}

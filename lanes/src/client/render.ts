import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import { CARDS } from "../shared/cards";
import { COLS, FIELD_HEIGHT, FIELD_WIDTH, type Fx, MAX_LEVEL, ROW_HEIGHT, ROWS, SHRINE, TOWER, rowCenter } from "../shared/sim";
import { TABLE, drawMini, drawSpellIcon, miniHeight, miniRadius, mix, shade } from "./minis";

export const PALETTE = {
  table: 0x4a2f1c,
  tablePlanks: [0x52341f, 0x482d1a, 0x4e321d],
  frame: 0x5e3b20,
  brass: 0xd4a94f,
  felt: [0x3f7353, 0x3a6b4d],
  feltEdge: 0x2b4d3c,
  path: 0xc8a46c,
  stitch: 0xeadfc4,
  tuft: 0x2c5a3d,
  tray: 0x6e4a2c,
  slot: 0x4a3020,
  paper: 0xf1e4c8,
  target: 0xffd166,
  blocked: 0xe0624f,
  me: 0x3f78d0,
  them: 0xcf4a3a,
  hpBack: 0x2a1d14,
  hp: 0x7fd38a,
  hpThem: 0xf2a65a,
  heal: 0x7fd38a,
  frost: 0x9fdcff,
  haste: 0xffd166,
  lightning: 0xfff3a0,
  shrine: 0xc9b6ff,
  fury: 0xff5a3c,
  meteor: 0xff9a3c,
  dust: 0xd8c39a,
  /** Rank colours for levels 2 and 3. */
  silver: 0xdfe6f2,
  gold: 0xffc93c,
  white: 0xffffff,
};

/** Units grow a little with each level, on top of their rank marks. */
const LEVEL_SIZE = [1, 1.15, 1.32];
/** Miniatures are drawn larger than their body radius so they read at board scale. */
const MINI_SCALE = 1.4;

export interface UnitView {
  id: number;
  side: number;
  card: string;
  level: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  hasted: boolean;
  frozen: boolean;
  fury: boolean;
}

export interface Board {
  /** Card id per build cell, "" when empty. */
  grid: string[];
  /** Level per build cell, 0 when empty. */
  levels: number[];
}

/** What the renderer remembers about a unit between frames. */
interface Shown {
  card: string;
  side: number;
  level: number;
  x: number;
  y: number;
  hp: number;
  age: number;
  flash: number;
  lunge: number;
  lungeX: number;
  lungeY: number;
  /** Seconds spent walking, which drives the hop. */
  walk: number;
  /** Time the unit left the state. */
  gone?: number;
  /** Died; it now topples as a fallen piece instead. */
  dead?: boolean;
}

/** A miniature that died and is toppling over. */
interface Fallen {
  card: string;
  side: number;
  x: number;
  y: number;
  r: number;
  age: number;
}

interface ActiveFx {
  fx: Fx;
  age: number;
  life: number;
  /** Attacker's card for hits, picked when the effect arrives; "turret" for a base. */
  by: string;
}

interface Floater {
  text: Text;
  age: number;
  life: number;
  vy: number;
}

const BASE_WIDTH = 60;
const SLOT_WIDTH = 100;
const PAD_SIZE = 84;
const GRID_WIDTH = COLS * SLOT_WIDTH;
const LEFT = GRID_WIDTH + BASE_WIDTH + 12;
const CELLS = ROWS * COLS;
/** Board margin around the play area, inside the wooden frame. */
const MARGIN_X = 16;
const MARGIN_Y = 28;
const FRAME = 18;
const HUD_TOP = 80;
const HUD_BOTTOM = 236;
/** Higher is snappier; positions arrive 20 times a second. */
const SMOOTHING = 18;
const FX_SECONDS = { hit: 0.3, heal: 0.45, death: 0.6, breach: 0.9, tower: 0.9, spell: 0.7, shrine: 0.9 };
const FLASH_SECONDS = 0.12;
const LUNGE_SECONDS = 0.16;
const SPAWN_SECONDS = 0.25;
const FALL_SECONDS = 0.9;
const FONT = "Georgia, 'Palatino Linotype', serif";

/** Left edge of a build pad slot on the left (0) or right (1) board. Column COLS - 1 sits next to the base. */
function slotX(board: number, col: number): number {
  return board === 0 ? -LEFT + col * SLOT_WIDTH : FIELD_WIDTH + LEFT - (col + 1) * SLOT_WIDTH;
}

/** Left edge of a build pad. */
function padX(board: number, cell: number): number {
  return slotX(board, cell % COLS) + (SLOT_WIDTH - PAD_SIZE) / 2;
}

/** Repeatable pseudo-random number in [0, 1) for scattering board decoration. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class Renderer {
  readonly app = new Application();
  /**
   * The table, board and scenery change rarely, so they are rendered into a plain canvas behind the
   * transparent Pixi canvas instead of every frame. Software WebGL (CI, laptops without a GPU)
   * can't afford redrawing them, and a page that falls behind holds up every other page sharing its GPU process.
   */
  private still = new Container();
  private stillCanvas: HTMLCanvasElement | null = null;
  private parent: HTMLElement | null = null;
  private table = new Graphics();
  /** Board and scenery in world coordinates; it follows the world's scale and origin, without the shake. */
  private backdrop = new Container();
  private world = new Container();
  private board = new Graphics();
  /** Forts and the shrine's stones; redrawn only when `sceneryKey` changes. */
  private scenery = new Graphics();
  private sceneryKey = "";
  private field = new Graphics();
  /** What the pads were last drawn from; they are redrawn only when it changes or a pad animates. */
  private gridKey = "";
  private grid = new Graphics();
  private units = new Graphics();
  private effects = new Graphics();
  private labels = new Container();
  private floaters = new Container();
  private padLabels: Text[] = [];
  private shown = new Map<number, Shown>();
  private fallen: Fallen[] = [];
  private active: ActiveFx[] = [];
  private floating: Floater[] = [];
  private latest: UnitView[] = [];
  private art = new Map<string, string>();
  /** Left and right build grids; the right one only shows while `showBoth` is set. */
  private boards: [Board, Board] = [
    { grid: [], levels: [] },
    { grid: [], levels: [] },
  ];
  private showBoth = false;
  /** Seconds left of the flash on a pad that just levelled up, per board cell. */
  private padFlash = new Array<number>(2 * ROWS * COLS).fill(0);
  private shrine = { owner: -1, control: 0 };
  /** HP per tower, by side; 0 once fallen. */
  private towers: [number[], number[]] = [[], []];
  private towerFlash: [number[], number[]] = [[], []];
  private hoverCell = -1;
  private shake = 0;
  private baseFlash = [0, 0];
  private time = 0;
  private origin = { x: 0, y: 0 };

  /** The local player's side. They are always drawn on the left. */
  mySide = 0;
  /** The unit card waiting for a pad, or "" when nothing is being placed. */
  placing = "";
  /** Own pad picked for selling, or -1. */
  selectedCell = -1;
  /** Whether the left pads react to the mouse; off for spectators. */
  interactive = true;
  /** Left click: a pad, or -1 for anywhere else. */
  onCell: (cell: number) => void = () => {};
  onSellCell: (cell: number) => void = () => {};

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
    this.backdrop.addChild(this.board, this.scenery);
    this.still.addChild(this.table, this.backdrop);
    this.world.addChild(this.field, this.grid, this.labels, this.units, this.effects, this.floaters);
    this.app.stage.addChild(this.world);
    for (let i = 0; i < 2 * CELLS; i++) {
      const [board, cell] = [Math.floor(i / CELLS), i % CELLS];
      const label = new Text({ text: "", style: { fontFamily: FONT, fontSize: 12, fontWeight: "700", fill: TABLE.ink } });
      label.anchor.set(0.5, 0);
      label.position.set(padX(board, cell) + PAD_SIZE / 2, padTop(cell) + PAD_SIZE - 21);
      this.padLabels.push(label);
      this.labels.addChild(label);
    }
    this.drawBoard();
    this.app.renderer.on("resize", () => this.fit());
    this.fit();

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.app.stage.on("pointermove", (e) => {
      this.hoverCell = this.cellAt(this.world.toLocal(e.global));
      const clickable = this.hoverCell !== -1 && (this.placing !== "" || !!this.boards[0].grid[this.hoverCell]);
      this.app.canvas.style.cursor = clickable ? "pointer" : "";
    });
    this.app.stage.on("pointerdown", (e) => {
      const cell = this.cellAt(this.world.toLocal(e.global));
      if (e.button !== 2) this.onCell(cell);
      else if (cell !== -1) this.onSellCell(cell);
    });
    this.app.ticker.add((ticker) => this.frame(Math.min(0.1, ticker.deltaMS / 1000)));
  }

  setUnits(units: UnitView[]): void {
    this.latest = units;
  }

  /** `right` is the opponent's board, shown to spectators; null shows only the left one. */
  setBoards(left: Board, right: Board | null): void {
    const boards: [Board, Board | null] = [left, right];
    for (let board = 0; board < 2; board++) {
      const next = boards[board];
      const before = this.boards[board];
      if (!next || !before.grid.length) continue;
      for (let cell = 0; cell < next.levels.length; cell++) {
        if ((next.levels[cell] ?? 0) > (before.levels[cell] ?? 0) && next.grid[cell] === before.grid[cell]) this.padFlash[board * CELLS + cell] = 0.6;
      }
    }
    this.boards[0] = left;
    if (right) this.boards[1] = right;
    if (this.showBoth !== !!right) {
      this.showBoth = !!right;
      this.drawBoard();
      this.fit();
    }
  }

  setShrine(owner: number, control: number): void {
    this.shrine = { owner, control };
  }

  /** Tower HP by side; a drop shows a damage number and a flash. */
  setTowers(towers: [number[], number[]]): void {
    for (const side of [0, 1]) {
      towers[side].forEach((hp, i) => {
        const before = this.towers[side][i];
        if (before !== undefined && hp < before) {
          this.towerFlash[side][i] = FLASH_SECONDS;
          const { x, y } = this.towerAt(side, i);
          this.float(`-${before - hp}`, x, y - 64, 0xffffff, 15);
        }
      });
      this.towers[side] = towers[side];
    }
  }

  /** Where a side's tower stands, as drawn. */
  private towerAt(side: number, index: number): { x: number; y: number } {
    return { x: this.vx(side === 0 ? TOWER.x : FIELD_WIDTH - TOWER.x), y: rowCenter(TOWER.rows[index]) };
  }

  addFx(events: Fx[]): void {
    for (const fx of events) {
      const by = fx.type === "hit" ? (fx.id === 0 ? "turret" : (this.shown.get(fx.id)?.card ?? "")) : "";
      this.active.push({ fx, age: 0, life: FX_SECONDS[fx.type], by });
      if (fx.type === "hit" && !fx.ranged) {
        const attacker = this.shown.get(fx.id);
        if (attacker) {
          const dx = this.vx(fx.tx) - this.vx(fx.x);
          const dy = fx.ty - fx.y;
          const d = Math.hypot(dx, dy) || 1;
          Object.assign(attacker, { lunge: LUNGE_SECONDS, lungeX: dx / d, lungeY: dy / d });
        }
      } else if (fx.type === "death") {
        // The unit leaves the state in the same tick, so its last HP drop never arrives; show it here.
        const victim = this.shown.get(fx.id);
        if (victim && !victim.dead) {
          victim.dead = true;
          if (victim.hp > 0) {
            this.float(`-${victim.hp}`, victim.x, victim.y - miniHeight(victim.card, miniRadius(victim.card)) - 6, 0xffffff, 15);
            victim.hp = 0;
          }
          const r = miniRadius(victim.card) * MINI_SCALE * (LEVEL_SIZE[victim.level - 1] ?? 1);
          this.fallen.push({ card: victim.card, side: victim.side, x: victim.x, y: victim.y, r, age: 0 });
        }
      } else if (fx.type === "breach") {
        const victim = fx.side === 0 ? 1 : 0;
        this.baseFlash[victim] = 0.3;
        if (victim === this.mySide) this.shake = Math.min(14, this.shake + 6 + fx.damage / 10);
        this.float(`-${fx.damage}`, this.vx(fx.x), fx.y - 20, 0xff8a7a, 30);
      } else if (fx.type === "tower") {
        if (fx.side === this.mySide) this.shake = Math.min(14, this.shake + 8);
        this.float("Tower down", this.vx(fx.x), fx.y - 70, this.color(fx.side), 20);
      } else if (fx.type === "shrine" && fx.owner !== -1) {
        const text = fx.owner === this.mySide ? `Shrine +${SHRINE.income}/s` : "Shrine lost";
        this.float(text, this.vx(SHRINE.x), SHRINE.y - SHRINE.radius - 16, this.color(fx.owner), 22);
      }
    }
  }

  /** Screen position of the centre of one of the local player's build pads. */
  cellOnScreen(cell: number): { x: number; y: number } {
    const p = this.world.toGlobal({ x: padX(0, cell) + PAD_SIZE / 2, y: padTop(cell) + PAD_SIZE / 2 });
    return { x: p.x, y: p.y };
  }

  /**
   * Card art as a PNG data URL: the unit's miniature in the local player's colour, or a spell's emblem.
   * Empty until the renderer is ready.
   */
  cardArt(cardId: string): string {
    const cached = this.art.get(cardId);
    if (cached !== undefined) return cached;
    if (!this.app.renderer) return "";
    const [w, h] = [128, 72];
    const g = new Graphics();
    const card = CARDS[cardId];
    if (card?.kind === "unit") {
      const r = Math.max(18, Math.min(24, miniRadius(cardId) * 1.3));
      const spots = cardId === "swarm" ? [[-32, 2], [0, -8], [32, 2]] : [[0, 0]];
      for (const [dx, dy] of spots) this.drawPiece(g, cardId, w / 2 + dx, h - 14 + dy, cardId === "swarm" ? r * 0.75 : r, 1, { paint: PALETTE.me, time: 0.3 });
    } else {
      g.translateTransform(w / 2, h / 2);
      drawSpellIcon(g, cardId, 26);
    }
    const canvas = this.app.renderer.extract.canvas({ target: g, frame: new Rectangle(0, 0, w, h), resolution: 2 }) as HTMLCanvasElement;
    const url = canvas.toDataURL();
    g.destroy();
    this.art.set(cardId, url);
    return url;
  }

  /** Field x as drawn: mirrored for side 1 so the local player is always on the left. */
  private vx(x: number): number {
    return this.mySide === 0 ? x : FIELD_WIDTH - x;
  }

  private color(side: number): number {
    return side === this.mySide ? PALETTE.me : PALETTE.them;
  }

  /** 1 for pieces walking right (the local player's), -1 for the enemy's. */
  private facing(side: number): number {
    return side === this.mySide ? 1 : -1;
  }

  /** The local player's pad under a point, or -1. */
  private cellAt(p: { x: number; y: number }): number {
    if (!this.interactive) return -1;
    for (let cell = 0; cell < CELLS; cell++) {
      const x = padX(0, cell);
      const y = padTop(cell);
      if (p.x >= x && p.x < x + PAD_SIZE && p.y >= y && p.y < y + PAD_SIZE) return cell;
    }
    return -1;
  }

  private frame(dt: number): void {
    this.time += dt;
    const shaking = this.shake > 0;
    this.shake = Math.max(0, this.shake - dt * 40);
    const [dx, dy] = [(Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake];
    this.world.position.set(this.origin.x + dx, this.origin.y + dy);
    if (shaking && this.stillCanvas) this.stillCanvas.style.transform = this.shake > 0 ? `translate(${dx}px, ${dy}px)` : "";
    this.drawField(dt);
    const gridKey = JSON.stringify([this.boards, this.showBoth, this.interactive, this.placing, this.hoverCell, this.selectedCell]);
    // Pads that take the armed card pulse, and a levelled-up pad flashes; otherwise the pads stay as drawn.
    if (gridKey !== this.gridKey || this.placing !== "" || this.padFlash.some((t) => t > 0)) {
      this.gridKey = gridKey;
      this.drawGrid(dt);
    }
    this.drawUnits(dt);
    this.drawEffects(dt);
    this.updateFloaters(dt);
  }

  /** A miniature with its shadow, base centred on (x, y), facing `f`, tipped over by `tilt` radians. */
  private drawPiece(g: Graphics, card: string, x: number, y: number, r: number, f: number, style: Parameters<typeof drawMini>[3], tilt = 0, lift = 0): void {
    const alpha = style.alpha ?? 1;
    g.ellipse(x + 3, y + 5, r * (1.05 - lift / 40), r * (0.5 - lift / 80)).fill({ color: 0x000000, alpha: 0.28 * alpha });
    g.save();
    g.scaleTransform(f, 1);
    g.rotateTransform(tilt * f);
    g.translateTransform(x, y - lift);
    drawMini(g, card, r, style);
    g.restore();
  }

  private drawGrid(dt: number): void {
    const g = this.grid.clear();
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 6);
    for (let board = 0; board < 2; board++) {
      const { grid, levels } = this.boards[board];
      const color = board === 0 ? PALETTE.me : PALETTE.them;
      for (let cell = 0; cell < CELLS; cell++) {
        const label = this.padLabels[board * CELLS + cell];
        label.visible = board === 0 || this.showBoth;
        if (!label.visible) continue;
        const x = padX(board, cell);
        const y = padTop(cell);
        const card = grid[cell] ?? "";
        const level = levels[cell] ?? 0;
        const mine = board === 0 && this.interactive;
        // While placing, a pad takes the card if it is empty or holds the same card below max level.
        const fits = mine && this.placing !== "" && (!card || (card === this.placing && level < MAX_LEVEL));
        const hover = mine && cell === this.hoverCell && (this.placing !== "" || card !== "");
        const blocked = hover && this.placing !== "" && !fits;

        // A recessed card slot in the wooden tray.
        g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 10).fill(hover && !blocked ? shade(PALETTE.slot, 1.25) : PALETTE.slot);
        g.roundRect(x + 2, y + 2, PAD_SIZE - 4, 6, 3).fill({ color: 0x000000, alpha: 0.18 });
        dashedRect(g, x + 7, y + 7, PAD_SIZE - 14, PAD_SIZE - 14, { color: PALETTE.stitch, width: 1.5, alpha: 0.28 });

        // Hovering a pad that takes the card previews it there, one level up.
        const preview = hover && fits;
        const upgrade = preview && card !== "";
        const shown = preview ? this.placing : card;
        const shownLevel = preview ? level + 1 : level;
        const cx = x + PAD_SIZE / 2;
        const alpha = preview ? (upgrade ? 0.85 : 0.6) : 1;
        if (shown) {
          // The unit's card lies in the slot with its miniature standing on it.
          const [cardX, cardY, cardW, cardH] = [x + 5, y + 3, PAD_SIZE - 10, PAD_SIZE - 6];
          g.roundRect(cardX + 2, cardY + 3, cardW, cardH, 6).fill({ color: 0x000000, alpha: 0.3 * alpha });
          g.roundRect(cardX, cardY, cardW, cardH, 6).fill({ color: PALETTE.paper, alpha }).stroke({ color: TABLE.ink, width: 1.5, alpha });
          g.roundRect(cardX + 4, cardY + 4, cardW - 8, cardH - 26, 4).fill({ color: mix(PALETTE.felt[0], color, 0.18), alpha });
          const rim = shownLevel > 1 ? rankColor(shownLevel) : undefined;
          const r = Math.max(15, Math.min(19, miniRadius(shown) * 1.2)) * (LEVEL_SIZE[shownLevel - 1] ?? 1) * 0.92;
          this.drawPiece(g, shown, cx, cardY + cardH - 30, r, board === 0 ? 1 : -1, { paint: color, alpha, rim });
          if (shownLevel > 1 && !preview) g.roundRect(cardX, cardY, cardW, cardH, 6).stroke({ color: rankColor(shownLevel), width: 3 });
          if (shownLevel > 1) drawRank(g, x + PAD_SIZE - 16, y + 16, shownLevel, preview ? 0.7 : 1);
        } else {
          g.rect(cx - 7, y + PAD_SIZE / 2 - 1, 14, 2).fill({ color: PALETTE.stitch, alpha: 0.3 });
          g.rect(cx - 1, y + PAD_SIZE / 2 - 7, 2, 14).fill({ color: PALETTE.stitch, alpha: 0.3 });
        }
        const flash = board * CELLS + cell;
        if (this.padFlash[flash] > 0) {
          g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 10).fill({ color: rankColor(level), alpha: this.padFlash[flash] * 0.6 });
          this.padFlash[flash] = Math.max(0, this.padFlash[flash] - dt);
        }
        if (mine && cell === this.selectedCell) g.roundRect(x - 2, y - 2, PAD_SIZE + 4, PAD_SIZE + 4, 12).stroke({ color: PALETTE.white, width: 3 });
        else if (blocked) g.roundRect(x - 1, y - 1, PAD_SIZE + 2, PAD_SIZE + 2, 11).stroke({ color: PALETTE.blocked, width: 3 });
        else if (fits) g.roundRect(x - 1, y - 1, PAD_SIZE + 2, PAD_SIZE + 2, 11).stroke({ color: PALETTE.target, width: 3, alpha: hover ? 1 : 0.4 * pulse });

        // Owned pads show their level with chevrons and border; the label only spells it out while previewing an upgrade.
        const blockedMax = blocked && card === this.placing;
        const name = upgrade ? `Level ${level + 1}` : blockedMax ? "Max level" : (CARDS[shown]?.name ?? "");
        if (label.text !== name) label.text = name;
        label.alpha = preview ? 0.7 : 1;
      }
    }
  }

  private drawUnits(dt: number): void {
    const g = this.units.clear();
    const blend = 1 - Math.exp(-SMOOTHING * dt);
    const seen = new Set<number>();
    // Pieces nearer the bottom of the board stand in front.
    const ordered = [...this.latest].sort((a, b) => a.y - b.y || a.id - b.id);
    for (const u of ordered) {
      seen.add(u.id);
      const vx = this.vx(u.x);
      let s = this.shown.get(u.id);
      if (!s) {
        s = { card: u.card, side: u.side, level: u.level, x: vx, y: u.y, hp: u.hp, age: 0, flash: 0, lunge: 0, lungeX: 0, lungeY: 0, walk: 0 };
        this.shown.set(u.id, s);
      }
      if (s.dead) continue;
      const step = Math.abs(vx - s.x) + Math.abs(u.y - s.y);
      s.x += (vx - s.x) * blend;
      s.y += (u.y - s.y) * blend;
      s.age += dt;
      s.level = u.level;
      if (step > 0.4 && !u.frozen) s.walk += dt;
      if (u.hp < s.hp) {
        s.flash = FLASH_SECONDS;
        this.float(`-${s.hp - u.hp}`, s.x, s.y - miniHeight(u.card, miniRadius(u.card)) - 6, 0xffffff, 15);
      } else if (u.hp > s.hp) {
        this.float(`+${u.hp - s.hp}`, s.x, s.y - miniHeight(u.card, miniRadius(u.card)) - 6, PALETTE.heal, 15);
      }
      s.hp = u.hp;
      s.flash = Math.max(0, s.flash - dt);
      s.lunge = Math.max(0, s.lunge - dt);

      const reach = Math.sin((Math.PI * s.lunge) / LUNGE_SECONDS) * 9;
      const x = s.x + s.lungeX * reach;
      const y = s.y + s.lungeY * reach;
      const grow = Math.min(1, s.age / SPAWN_SECONDS);
      const r = miniRadius(u.card) * MINI_SCALE * (LEVEL_SIZE[u.level - 1] ?? 1) * (0.6 + 0.4 * grow);
      // Pieces drop onto the board when they spawn, then hop along as they walk.
      const hop = step > 0.4 && !u.frozen ? Math.abs(Math.sin(s.walk * 11 + u.id)) * 3.5 : 0;
      const lift = (1 - grow) * 24 + hop;
      const color = this.color(u.side);
      const f = this.facing(u.side);

      // Level 3 units stand on a soft gold glow so they stand out in a crowd.
      if (u.level >= 3) g.ellipse(x, y, r + 9 + Math.sin(this.time * 5) * 1.5, (r + 9) * 0.5).fill({ color: PALETTE.gold, alpha: 0.3 });
      if (u.fury) g.ellipse(x, y, r + 6, (r + 6) * 0.5).stroke({ color: PALETTE.fury, width: 3, alpha: 0.6 + 0.3 * Math.sin(this.time * 14) });
      if (u.hasted) {
        // Dust kicked up behind a hasted piece.
        for (let i = 0; i < 3; i++) {
          const k = (this.time * 3 + i / 3) % 1;
          g.circle(x - f * (r + 4 + 18 * k), y + 2 - 6 * k, 3 + 4 * k).fill({ color: PALETTE.dust, alpha: 0.5 * (1 - k) });
        }
      }
      let paint = u.frozen ? mix(color, PALETTE.frost, 0.7) : color;
      if (s.flash > 0) paint = mix(paint, PALETTE.white, s.flash / FLASH_SECONDS);
      const rim = u.level > 1 ? rankColor(u.level) : undefined;
      this.drawPiece(g, u.card, x, y, r, f, { paint, rim, time: this.time + u.id }, 0, lift);
      const height = miniHeight(u.card, r);
      if (u.frozen) {
        g.roundRect(x - r * 1.1, y - lift - height - 4, r * 2.2, height + r * 0.6, 6)
          .fill({ color: PALETTE.frost, alpha: 0.3 })
          .stroke({ color: PALETTE.white, width: 1.5, alpha: 0.7 });
      }
      if (u.level > 1) drawRank(g, x, y + r * 0.5 + 9, u.level, 1, 1.3);
      if (u.hp < u.maxHp) {
        const w = Math.max(24, r * 2);
        const top = y - lift - height - 12;
        g.roundRect(x - w / 2 - 2, top - 1, w + 4, 7, 3).fill(PALETTE.hpBack);
        g.roundRect(x - w / 2, top + 1, (w * Math.max(0, u.hp)) / u.maxHp, 3, 1.5).fill(u.side === this.mySide ? PALETTE.hp : PALETTE.hpThem);
      }
    }
    // Keep removed units briefly so a death event that arrives after the state patch can still find them.
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      s.gone ??= this.time;
      if (this.time - s.gone > 1) this.shown.delete(id);
    }
    // Fallen pieces tip over backwards, then fade.
    this.fallen = this.fallen.filter((p) => (p.age += dt) < FALL_SECONDS);
    for (const p of this.fallen) {
      const tip = Math.min(1, p.age / 0.25);
      const alpha = Math.min(1, 2.5 * (1 - p.age / FALL_SECONDS));
      const f = this.facing(p.side);
      this.drawPiece(g, p.card, p.x, p.y, p.r, f, { paint: shade(this.color(p.side), 0.8), alpha }, -(Math.PI / 2) * tip * tip);
    }
  }

  private drawEffects(dt: number): void {
    const g = this.effects.clear();
    this.active = this.active.filter((a) => (a.age += dt) < a.life);
    for (const { fx, age, life, by } of this.active) {
      const t = age / life;
      const alpha = 1 - t;
      if (fx.type === "hit") {
        const [x, tx] = [this.vx(fx.x), this.vx(fx.tx)];
        const [y, ty] = [fx.y - 16, fx.ty - 12];
        if (fx.ranged) {
          // The projectile flies for the first 40% of the effect, then the impact shows.
          const f = Math.min(1, t / 0.4);
          if (f < 1) {
            this.drawProjectile(g, by, x, y, tx, ty, f);
            continue;
          }
          const k = (t - 0.4) / 0.6;
          if (fx.splash) {
            g.circle(tx, ty, fx.splash * (0.5 + 0.5 * k)).fill({ color: 0xffb347, alpha: 0.35 * (1 - k) });
            g.circle(tx, ty, fx.splash * (0.5 + 0.5 * k)).stroke({ color: 0xffe0a0, width: 3, alpha: 1 - k });
            for (let i = 0; i < 7; i++) {
              const a = (i / 7) * Math.PI * 2 + fx.tx;
              g.circle(tx + Math.cos(a) * fx.splash * 0.7 * k, ty + Math.sin(a) * fx.splash * 0.4 * k - 20 * k * (1 - k), 3).fill({ color: TABLE.woodDark, alpha: 1 - k });
            }
          } else {
            g.circle(tx, ty, 4 + 9 * k).fill({ color: PALETTE.dust, alpha: 0.5 * (1 - k) });
          }
        } else {
          // Melee: a short slash spark at the target.
          const s = 6 + 10 * t;
          g.moveTo(tx - s, ty - s).lineTo(tx + s, ty + s).stroke({ color: PALETTE.white, width: 3, alpha });
          g.moveTo(tx + s, ty - s).lineTo(tx - s, ty + s).stroke({ color: PALETTE.white, width: 2, alpha: alpha * 0.6 });
        }
      } else if (fx.type === "heal") {
        const [tx, ty] = [this.vx(fx.tx), fx.ty - 14];
        g.moveTo(this.vx(fx.x), fx.y - 14).lineTo(tx, ty).stroke({ color: PALETTE.heal, width: 2, alpha: alpha * 0.6 });
        for (let i = 0; i < 3; i++) {
          const px = tx + (i - 1) * 10;
          const py = ty - 8 - 26 * t - i * 4;
          g.rect(px - 4, py - 1.5, 8, 3).fill({ color: PALETTE.heal, alpha }).rect(px - 1.5, py - 4, 3, 8).fill({ color: PALETTE.heal, alpha });
        }
      } else if (fx.type === "breach") {
        // Splinters fly off the fort wall.
        const x = this.vx(fx.x);
        const away = x < FIELD_WIDTH / 2 ? 1 : -1;
        g.circle(x, fx.y, 14 + 70 * t).stroke({ color: this.color(fx.side), width: 8 * alpha + 1, alpha });
        for (let i = 0; i < 10; i++) {
          const a = ((i / 10) * Math.PI - Math.PI / 2) * 1.2;
          const d = 10 + 70 * t;
          const px = x + away * Math.cos(a) * d;
          const py = fx.y + Math.sin(a) * d + 60 * t * t;
          g.rect(px - 3, py - 1.5, 7, 3).fill({ color: i % 2 ? TABLE.wood : TABLE.stone, alpha });
        }
      } else if (fx.type === "tower") {
        // The tower crumbles: a dust cloud and tumbling blocks.
        const x = this.vx(fx.x);
        g.circle(x, fx.y - 10, 20 + 50 * t).fill({ color: PALETTE.dust, alpha: 0.5 * alpha });
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const d = 8 + 55 * t;
          g.rect(x + Math.cos(a) * d - 3, fx.y - 20 + Math.sin(a) * d * 0.6 + 50 * t * t, 7, 5).fill({ color: i % 3 ? TABLE.stone : this.color(fx.side), alpha });
        }
      } else if (fx.type === "death") {
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3 + 0.4;
          const d = 8 + 26 * t;
          g.circle(this.vx(fx.x) + Math.cos(a) * d, fx.y + Math.sin(a) * d * 0.5, 6 * alpha + 2).fill({ color: PALETTE.dust, alpha: alpha * 0.6 });
        }
      } else if (fx.type === "shrine") {
        const color = fx.owner === -1 ? PALETTE.shrine : this.color(fx.owner);
        g.circle(this.vx(SHRINE.x), SHRINE.y, SHRINE.radius * (1 + t)).stroke({ color, width: 8 * alpha + 1, alpha });
      } else {
        this.drawSpell(g, fx, t);
      }
    }
  }

  /** Arrows fly straight; bombs and boulders arc. `f` is the share of the flight done. */
  private drawProjectile(g: Graphics, by: string, x: number, y: number, tx: number, ty: number, f: number): void {
    const d = Math.hypot(tx - x, ty - y) || 1;
    const [dx, dy] = [(tx - x) / d, (ty - y) / d];
    const px = x + (tx - x) * f;
    if (by === "bomber" || by === "catapult") {
      const py = y + (ty - y) * f - Math.sin(Math.PI * f) * d * 0.3;
      const size = by === "catapult" ? 8 : 5;
      g.circle(px, py, size).fill(by === "catapult" ? TABLE.stone : TABLE.bomb).stroke({ color: TABLE.ink, width: 1.5 });
      if (by === "bomber") g.circle(px + 3, py - 5, 2.5).fill(TABLE.spark);
      return;
    }
    const py = y + (ty - y) * f;
    if (by === "sniper") {
      g.moveTo(px - dx * 40, py - dy * 40).lineTo(px, py).stroke({ color: 0xfff3c0, width: 2.5, alpha: 0.9 });
      return;
    }
    // An arrow: shaft, head and fletching.
    g.moveTo(px - dx * 16, py - dy * 16).lineTo(px, py).stroke({ color: TABLE.woodLight, width: 2 });
    g.poly([px + dx * 5, py + dy * 5, px - dx * 2 - dy * 3, py - dy * 2 + dx * 3, px - dx * 2 + dy * 3, py - dy * 2 - dx * 3]).fill(TABLE.steel);
    g.moveTo(px - dx * 16, py - dy * 16).lineTo(px - dx * 12, py - dy * 12).stroke({ color: TABLE.cloth, width: 4 });
  }

  private drawSpell(g: Graphics, fx: Extract<Fx, { type: "spell" }>, t: number): void {
    const alpha = 1 - t;
    for (const [px, y] of fx.points) {
      const x = this.vx(px);
      if (fx.card === "lightning") {
        const top = -80;
        const steps = 5;
        g.moveTo(x, top);
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          g.lineTo(x + (i === steps ? 0 : (i % 2 ? 14 : -14)), top + (y - top) * k);
        }
        g.stroke({ color: PALETTE.lightning, width: 5 * alpha + 1, alpha });
        g.circle(x, y, 10 + 30 * t).fill({ color: PALETTE.lightning, alpha: 0.4 * alpha });
      } else if (fx.card === "frost") {
        g.circle(x, y, 10 + 26 * t).fill({ color: PALETTE.frost, alpha: 0.35 * alpha });
        for (let i = 0; i < 3; i++) {
          const a = (i * Math.PI) / 3 + t;
          const s = 8 + 18 * t;
          g.moveTo(x - Math.cos(a) * s, y - Math.sin(a) * s).lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s).stroke({ color: PALETTE.white, width: 2, alpha });
        }
      } else if (fx.card === "meteor") {
        // Falls from the upper right for the first 30%, then a wide blast.
        const radius = CARDS.meteor.kind === "spell" && CARDS.meteor.effect.type === "meteor" ? CARDS.meteor.effect.radius : 80;
        if (t < 0.3) {
          const k = t / 0.3;
          const [sx, sy] = [x + 220 * (1 - k), y - 320 * (1 - k)];
          g.moveTo(sx + 50, sy - 70).lineTo(sx, sy).stroke({ color: PALETTE.meteor, width: 10, alpha: 0.7 });
          g.circle(sx, sy, 14).fill(TABLE.stoneDark).stroke({ color: PALETTE.meteor, width: 4 });
        } else {
          const k = (t - 0.3) / 0.7;
          g.circle(x, y, radius * (0.6 + 0.4 * k)).fill({ color: PALETTE.meteor, alpha: 0.45 * (1 - k) });
          g.circle(x, y, radius * (0.6 + 0.5 * k)).stroke({ color: 0xffe0a0, width: 5 * (1 - k) + 1, alpha: 1 - k });
          g.circle(x, y, 18 * (1 - k)).fill({ color: PALETTE.white, alpha: 1 - k });
        }
      } else if (fx.card === "fury") {
        g.circle(x, y, 10 + 22 * t).stroke({ color: PALETTE.fury, width: 5 * alpha + 1, alpha });
        for (let i = 0; i < 3; i++) {
          const fx0 = x + (i - 1) * 8;
          g.poly([fx0 - 4, y - 14 - 22 * t, fx0, y - 24 - 22 * t, fx0 + 4, y - 14 - 22 * t]).fill({ color: PALETTE.fury, alpha });
        }
      } else if (fx.card === "muster") {
        g.rect(x - 2, y - 40 * (1 - t) - 30, 4, 30).fill({ color: TABLE.woodLight, alpha });
        g.circle(x, y, 14 + 30 * t).stroke({ color: this.color(fx.side), width: 4 * alpha + 1, alpha });
      } else if (fx.card === "mend") {
        const s = 10 + 8 * t;
        g.rect(x - s, y - 3 - 20 * t, s * 2, 6).fill({ color: PALETTE.heal, alpha });
        g.rect(x - 3, y - s - 20 * t, 6, s * 2).fill({ color: PALETTE.heal, alpha });
      } else {
        g.circle(x, y, 12 + 24 * t).stroke({ color: PALETTE.haste, width: 4, alpha });
      }
    }
  }

  private float(text: string, x: number, y: number, fill: number, size: number): void {
    const label = new Text({
      text,
      style: { fontFamily: FONT, fontSize: size, fontWeight: "800", fill, stroke: { color: TABLE.ink, width: 4 } },
    });
    label.anchor.set(0.5);
    label.position.set(x + (Math.random() - 0.5) * 10, y);
    this.floaters.addChild(label);
    this.floating.push({ text: label, age: 0, life: size > 20 ? 1.2 : 0.7, vy: size > 20 ? -40 : -55 });
  }

  private updateFloaters(dt: number): void {
    this.floating = this.floating.filter((f) => {
      f.age += dt;
      if (f.age >= f.life) {
        f.text.destroy();
        return false;
      }
      f.text.y += f.vy * dt;
      f.text.alpha = Math.min(1, 2 * (1 - f.age / f.life));
      return true;
    });
  }

  /** World x range the board covers, frame excluded. */
  private boardSpan(): [number, number] {
    return [-LEFT - MARGIN_X, FIELD_WIDTH + (this.showBoth ? LEFT : BASE_WIDTH) + MARGIN_X];
  }

  /** The static board: frame, felt lanes with their path, and the card trays. Redrawn only when the layout changes. */
  private drawBoard(): void {
    const g = this.board.clear();
    const [left, right] = this.boardSpan();
    const [top, bottom] = [-MARGIN_Y, FIELD_HEIGHT + MARGIN_Y];
    const [w, h] = [right - left, bottom - top];

    // Shadow on the table, wooden frame with brass corners, and the felt inside.
    g.roundRect(left - FRAME + 10, top - FRAME + 16, w + 2 * FRAME, h + 2 * FRAME, 18).fill({ color: 0x000000, alpha: 0.4 });
    g.roundRect(left - FRAME, top - FRAME, w + 2 * FRAME, h + 2 * FRAME, 16).fill(PALETTE.frame).stroke({ color: TABLE.ink, width: 3 });
    g.roundRect(left - FRAME + 5, top - FRAME + 5, w + 2 * FRAME - 10, h + 2 * FRAME - 10, 12).stroke({ color: TABLE.woodLight, width: 2, alpha: 0.45 });
    for (let i = 0; i < 6; i++) {
      const y = top - FRAME + 4 + hash(i) * (h + 2 * FRAME - 8);
      g.moveTo(left - FRAME + 20 + hash(i + 9) * 200, y).lineTo(right + FRAME - 20 - hash(i + 3) * 200, y).stroke({ color: TABLE.woodLight, width: 1, alpha: 0.12 });
    }
    for (const [cx, cy] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
      g.roundRect(cx - FRAME - 2, cy - FRAME - 2, FRAME + 6, FRAME + 6, 4).fill(PALETTE.brass).stroke({ color: TABLE.ink, width: 2 });
      g.circle(cx - FRAME / 2 + 1, cy - FRAME / 2 + 1, 2.5).fill(shade(PALETTE.brass, 0.6));
    }
    g.rect(left, top, w, h).fill(PALETTE.feltEdge).stroke({ color: TABLE.ink, width: 2 });

    // Lanes: felt with a worn dirt path down the middle and stitched seams between them.
    for (let row = 0; row < ROWS; row++) {
      const y = row * ROW_HEIGHT;
      g.rect(0, y, FIELD_WIDTH, ROW_HEIGHT).fill(PALETTE.felt[row % 2]);
      const mid = y + ROW_HEIGHT / 2;
      g.roundRect(0, mid - 22, FIELD_WIDTH, 44, 22).fill({ color: PALETTE.path, alpha: 0.22 });
      g.roundRect(0, mid - 14, FIELD_WIDTH, 28, 14).fill({ color: PALETTE.path, alpha: 0.18 });
      for (let i = 0; i < 26; i++) {
        const px = hash(row * 100 + i) * FIELD_WIDTH;
        const py = mid + (hash(row * 100 + i + 50) - 0.5) * 38;
        g.circle(px, py, 1.5 + hash(i + row) * 2).fill({ color: PALETTE.path, alpha: 0.35 });
      }
      // Grass tufts off the path.
      for (let i = 0; i < 18; i++) {
        const px = 20 + hash(row * 31 + i * 7) * (FIELD_WIDTH - 40);
        const side = i % 2 ? -1 : 1;
        const py = mid + side * (32 + hash(row * 17 + i) * 28);
        g.moveTo(px - 5, py - 6).lineTo(px - 2, py).lineTo(px, py - 8).lineTo(px + 2, py).lineTo(px + 5, py - 6)
          .stroke({ color: PALETTE.tuft, width: 1.5, alpha: 0.6, join: "round", cap: "round" });
      }
      if (row > 0) dashedLine(g, 0, y, FIELD_WIDTH, y, { color: PALETTE.stitch, width: 2, alpha: 0.4 });
    }
    dashedRect(g, 3, 3, FIELD_WIDTH - 6, FIELD_HEIGHT - 6, { color: PALETTE.stitch, width: 1.5, alpha: 0.25 });

    // Card trays behind the bases.
    for (let board = 0; board < (this.showBoth ? 2 : 1); board++) {
      const x = board === 0 ? -LEFT - 8 : FIELD_WIDTH + LEFT - GRID_WIDTH - 8;
      g.roundRect(x + 3, -5, GRID_WIDTH + 16, FIELD_HEIGHT + 16, 12).fill({ color: 0x000000, alpha: 0.35 });
      g.roundRect(x, -8, GRID_WIDTH + 16, FIELD_HEIGHT + 16, 12).fill(PALETTE.tray).stroke({ color: TABLE.ink, width: 2 });
      for (let i = 0; i < 9; i++) {
        const y = -4 + hash(i + board * 20 + 70) * (FIELD_HEIGHT + 8);
        g.moveTo(x + 8, y).lineTo(x + GRID_WIDTH + 8, y).stroke({ color: TABLE.woodLight, width: 1, alpha: 0.15 });
      }
      for (let row = 1; row < ROWS; row++) g.rect(x + 10, row * ROW_HEIGHT - 1, GRID_WIDTH - 4, 2).fill({ color: 0x000000, alpha: 0.18 });
    }
  }

  /** Forts (left is always the local player's) and the shrine's stones, tinted by its owner. */
  private drawScenery(): void {
    const g = this.scenery.clear();
    this.drawShrine(g);
    this.drawFort(g, -BASE_WIDTH, this.mySide);
    this.drawFort(g, FIELD_WIDTH, 1 - this.mySide);
    for (const side of [0, 1]) {
      for (let i = 0; i < TOWER.rows.length; i++) {
        const { x, y } = this.towerAt(side, i);
        if ((this.towers[side][i] ?? TOWER.hp) > 0) this.drawTower(g, x, y, side);
        else this.drawRubble(g, x, y, side);
      }
    }
  }

  /** A round stone tower with battlements and a band in its side's colour. */
  private drawTower(g: Graphics, x: number, y: number, side: number): void {
    const color = this.color(side);
    const ink = { color: TABLE.ink, width: 2 };
    g.ellipse(x + 4, y + 4, 28, 12).fill({ color: 0x000000, alpha: 0.3 });
    g.ellipse(x, y, 22, 9).fill(TABLE.stoneDark).stroke(ink);
    g.rect(x - 20, y - 42, 40, 42).fill(TABLE.stone);
    g.moveTo(x - 20, y).lineTo(x - 20, y - 42).moveTo(x + 20, y).lineTo(x + 20, y - 42).stroke(ink);
    for (const row of [-12, -28]) g.moveTo(x - 20, y + row).lineTo(x + 20, y + row).stroke({ color: TABLE.stoneDark, width: 1, alpha: 0.6 });
    g.rect(x - 20, y - 24, 40, 7).fill(color).stroke({ color: TABLE.ink, width: 1.5 });
    g.rect(x - 2.5, y - 38, 5, 11).fill(TABLE.ink);
    g.rect(x - 14, y - 40, 6, 36).fill({ color: 0xffffff, alpha: 0.12 });
    for (let i = 0; i < 4; i++) g.rect(x - 22 + i * 12, y - 52, 8, 11).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1.5 });
    g.rect(x - 22, y - 44, 44, 4).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1.5 });
  }

  /** What is left of a fallen tower. */
  private drawRubble(g: Graphics, x: number, y: number, side: number): void {
    g.ellipse(x + 3, y + 3, 28, 11).fill({ color: 0x000000, alpha: 0.25 });
    g.ellipse(x, y, 22, 9).fill(TABLE.stoneDark).stroke({ color: TABLE.ink, width: 2 });
    g.poly([x - 20, y, x - 20, y - 14, x - 10, y - 8, x - 2, y - 18, x + 8, y - 6, x + 20, y - 12, x + 20, y]).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1.5 });
    g.rect(x - 20, y - 5, 40, 4).fill({ color: this.color(side), alpha: 0.7 });
    for (const [dx, dy, w] of [[-28, 6, 9], [24, 4, 8], [10, 10, 7], [-12, 9, 6]]) {
      g.roundRect(x + dx - w / 2, y + dy - 3, w, 6, 2).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1 });
    }
  }

  /** The parts of the board that move: banners, the shrine's crystal and capture ring, and fort flashes. */
  private drawField(dt = 0): void {
    const standing = this.towers.map((side) => side.map((hp) => (hp > 0 ? 1 : 0)).join("")).join("/");
    const sceneryKey = `${this.mySide}|${this.shrine.owner}|${standing}`;
    if (sceneryKey !== this.sceneryKey) {
      this.sceneryKey = sceneryKey;
      this.drawScenery();
      this.renderStill();
    }
    const g = this.field.clear();
    this.drawCrystal(g);
    for (const [x, side] of [
      [-BASE_WIDTH, this.mySide],
      [FIELD_WIDTH, 1 - this.mySide],
    ] as const) {
      this.drawBanner(g, x, side);
      if (this.baseFlash[side] > 0) {
        g.roundRect(x + 4, -12, BASE_WIDTH - 8, FIELD_HEIGHT + 24, 8).fill({ color: PALETTE.white, alpha: this.baseFlash[side] * 2 });
        this.baseFlash[side] = Math.max(0, this.baseFlash[side] - dt);
      }
    }
    // Hurt towers show their health; a hit flashes them.
    for (const side of [0, 1]) {
      this.towers[side].forEach((hp, i) => {
        if (hp <= 0) return;
        const { x, y } = this.towerAt(side, i);
        const flash = this.towerFlash[side][i] ?? 0;
        if (flash > 0) {
          g.rect(x - 22, y - 52, 44, 52).fill({ color: PALETTE.white, alpha: (0.5 * flash) / FLASH_SECONDS });
          this.towerFlash[side][i] = Math.max(0, flash - dt);
        }
        if (hp >= TOWER.hp) return;
        const [w, top] = [44, y - 62];
        g.roundRect(x - w / 2 - 2, top - 1, w + 4, 8, 3).fill(PALETTE.hpBack);
        g.roundRect(x - w / 2, top + 1, (w * hp) / TOWER.hp, 4, 2).fill(side === this.mySide ? PALETTE.hp : PALETTE.hpThem);
      });
    }
  }

  /** A stone wall with battlements on the field side and three towers; the middle one flies the banner. */
  private drawFort(g: Graphics, x: number, side: number): void {
    const color = this.color(side);
    const inward = x < 0 ? 1 : -1;
    const ink = { color: TABLE.ink, width: 2 };
    const [wallX, wallW] = [x + 12, BASE_WIDTH - 24];
    g.rect(wallX + 4, -2, wallW, FIELD_HEIGHT + 8).fill({ color: 0x000000, alpha: 0.3 });
    g.rect(wallX, -6, wallW, FIELD_HEIGHT + 12).fill(TABLE.stone).stroke(ink);
    for (let i = 0, y = 12; y < FIELD_HEIGHT; i++, y += 18) {
      g.moveTo(wallX, y).lineTo(wallX + wallW, y).stroke({ color: TABLE.stoneDark, width: 1, alpha: 0.6 });
      const jx = wallX + (i % 2 ? wallW / 3 : (2 * wallW) / 3);
      g.moveTo(jx, y - 18).lineTo(jx, y).stroke({ color: TABLE.stoneDark, width: 1, alpha: 0.6 });
    }
    const edge = inward === 1 ? wallX + wallW : wallX - 8;
    for (let y = 4; y < FIELD_HEIGHT - 8; y += 22) g.rect(edge, y, 8, 11).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1.5 });
    for (const ty of [8, FIELD_HEIGHT / 2, FIELD_HEIGHT - 8]) {
      const cx = x + BASE_WIDTH / 2;
      g.circle(cx + 3, ty + 4, 27).fill({ color: 0x000000, alpha: 0.3 });
      g.circle(cx, ty, 27).fill(TABLE.stone).stroke(ink);
      g.circle(cx, ty, 20).fill(color).stroke(ink);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + 0.3;
        g.moveTo(cx, ty).lineTo(cx + Math.cos(a) * 20, ty + Math.sin(a) * 20).stroke({ color: TABLE.ink, width: 1, alpha: 0.35 });
      }
      g.circle(cx - 6, ty - 6, 6).fill({ color: 0xffffff, alpha: 0.18 });
      g.circle(cx, ty, 4).fill(PALETTE.brass).stroke({ color: TABLE.ink, width: 1 });
    }
  }

  /** The banner streams back from the fort's middle tower. */
  private drawBanner(g: Graphics, x: number, side: number): void {
    const color = this.color(side);
    const inward = x < 0 ? 1 : -1;
    const [px, py] = [x + BASE_WIDTH / 2, FIELD_HEIGHT / 2];
    g.moveTo(px, py).lineTo(px, py - 62).stroke({ color: TABLE.ink, width: 4, cap: "round" }).moveTo(px, py).lineTo(px, py - 62).stroke({ color: TABLE.woodLight, width: 2, cap: "round" });
    const back = -inward;
    const flag: number[] = [];
    const bottomEdge: number[] = [];
    for (let i = 0; i <= 5; i++) {
      const k = i / 5;
      const wave = Math.sin(this.time * 4 - i * 0.9) * 3 * k;
      flag.push(px + back * 40 * k, py - 60 + wave);
      bottomEdge.unshift(px + back * 40 * k, py - 38 + wave - (i === 5 ? 6 : 0));
    }
    g.poly([...flag, ...bottomEdge]).fill(color).stroke({ color: TABLE.ink, width: 2, join: "round" });
  }

  /** Neutral capture point: a ring of standing stones, tinted by its owner. */
  private drawShrine(g: Graphics): void {
    const { owner } = this.shrine;
    const x = this.vx(SHRINE.x);
    const y = SHRINE.y;
    const r = SHRINE.radius;
    const tint = owner === -1 ? PALETTE.shrine : this.color(owner);
    g.circle(x, y, r).fill({ color: PALETTE.path, alpha: 0.3 });
    g.circle(x, y, r).fill({ color: tint, alpha: owner === -1 ? 0.06 : 0.16 });
    dashedCircle(g, x, y, r - 4, { color: tint, width: 2, alpha: 0.5 });
    // Back stones first so the front ones overlap them.
    const stones = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4 + Math.PI / 8).sort((a, b) => Math.sin(a) - Math.sin(b));
    for (const a of stones) {
      const sx = x + Math.cos(a) * (r - 4);
      const sy = y + Math.sin(a) * (r - 4) * 0.92;
      g.ellipse(sx + 2, sy + 2, 8, 4).fill({ color: 0x000000, alpha: 0.3 });
      g.roundRect(sx - 6, sy - 18, 12, 20, 4).fill(TABLE.stone).stroke({ color: TABLE.ink, width: 1.5 });
      g.rect(sx - 3, sy - 14, 3, 12).fill({ color: 0xffffff, alpha: 0.15 });
      if (owner !== -1) g.circle(sx, sy - 9, 2.2).fill(tint);
    }
  }

  /** The shrine's floating crystal and the ring that fills toward whoever is taking it. */
  private drawCrystal(g: Graphics): void {
    const { owner, control } = this.shrine;
    const x = this.vx(SHRINE.x);
    const y = SHRINE.y;
    const r = SHRINE.radius;
    const tint = owner === -1 ? PALETTE.shrine : this.color(owner);
    const k = Math.abs(control) / SHRINE.captureTicks;
    if (k > 0 && k < 1) {
      const toward = control > 0 ? 0 : 1;
      // Start a fresh sub-path at the top; otherwise Pixi joins the arc to the previous shape with a stray line.
      const start = -Math.PI / 2;
      g.moveTo(x, y - r).arc(x, y, r, start, start + k * Math.PI * 2).stroke({ color: this.color(toward), width: 6, alpha: 0.95 });
    }
    const bob = Math.sin(this.time * 2.5) * 3;
    const s = 16;
    g.ellipse(x, y + 6, 12 - bob, 5).fill({ color: 0x000000, alpha: 0.3 });
    g.circle(x, y - 14 + bob, 24).fill({ color: tint, alpha: 0.18 });
    const cy = y - 14 + bob;
    g.poly([x, cy - s, x + s * 0.6, cy, x, cy + s, x - s * 0.6, cy]).fill({ color: tint, alpha: owner === -1 ? 0.75 : 1 }).stroke({ color: TABLE.ink, width: 2 });
    g.poly([x, cy - s, x + s * 0.6, cy, x, cy]).fill({ color: 0xffffff, alpha: 0.3 });
  }

  /** Wooden planks that fill the screen behind the board. */
  private drawTable(): void {
    const { width, height } = this.app.screen;
    const g = this.table.clear();
    const plank = 96;
    for (let i = 0, y = 0; y < height; i++, y += plank) {
      g.rect(0, y, width, plank).fill(PALETTE.tablePlanks[i % 3]);
      for (let k = 0; k < 5; k++) {
        const gy = y + 10 + hash(i * 11 + k) * (plank - 20);
        g.moveTo(0, gy);
        for (let x = 0; x <= width; x += 40) g.lineTo(x, gy + Math.sin(x / 90 + i + k) * 3);
        g.stroke({ color: 0x000000, width: 1, alpha: 0.1 });
      }
      g.rect(0, y + plank - 2, width, 2).fill({ color: 0x000000, alpha: 0.35 });
      const joint = hash(i * 5) * width;
      g.rect(joint, y, 2, plank).fill({ color: 0x000000, alpha: 0.3 });
    }
  }

  private fit(): void {
    const { width, height } = this.app.screen;
    this.drawTable();
    const [left, right] = this.boardSpan();
    // Spectators see both grids; a player sees only their own, so the enemy base ends the view.
    const total = right - left + 2 * FRAME;
    const tall = FIELD_HEIGHT + 2 * (MARGIN_Y + FRAME);
    // Spectators have no hand, so the field can use the space at the bottom.
    const bottom = this.interactive ? HUD_BOTTOM : HUD_TOP;
    const scale = Math.min((width - 32) / total, (height - HUD_TOP - bottom) / tall);
    this.world.scale.set(scale);
    this.origin = {
      x: (width - total * scale) / 2 + (FRAME - left) * scale,
      y: HUD_TOP + (height - HUD_TOP - bottom - FIELD_HEIGHT * scale) / 2,
    };
    this.world.position.set(this.origin.x, this.origin.y);
    this.backdrop.scale.set(scale);
    this.backdrop.position.set(this.origin.x, this.origin.y);
    this.renderStill();
  }

  /** Renders the table, board and scenery into the canvas behind the Pixi canvas. */
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
}

function padTop(cell: number): number {
  return Math.floor(cell / COLS) * ROW_HEIGHT + (ROW_HEIGHT - PAD_SIZE) / 2;
}

function rankColor(level: number): number {
  return level >= 3 ? PALETTE.gold : level === 2 ? PALETTE.silver : PALETTE.stitch;
}

type LineStyle = { color: number; width: number; alpha: number };

function dashedLine(g: Graphics, x1: number, y1: number, x2: number, y2: number, style: LineStyle, dash = 8, gap = 6): void {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const [dx, dy] = [(x2 - x1) / d, (y2 - y1) / d];
  for (let p = 0; p < d; p += dash + gap) {
    const q = Math.min(d, p + dash);
    g.moveTo(x1 + dx * p, y1 + dy * p).lineTo(x1 + dx * q, y1 + dy * q);
  }
  g.stroke({ ...style, cap: "round" });
}

function dashedRect(g: Graphics, x: number, y: number, w: number, h: number, style: LineStyle): void {
  dashedLine(g, x, y, x + w, y, style);
  dashedLine(g, x + w, y, x + w, y + h, style);
  dashedLine(g, x + w, y + h, x, y + h, style);
  dashedLine(g, x, y + h, x, y, style);
}

function dashedCircle(g: Graphics, x: number, y: number, r: number, style: LineStyle): void {
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r).arc(x, y, r, a, a + (Math.PI * 2) / n / 1.8);
  }
  g.stroke({ ...style, cap: "round" });
}

/** Rank chevrons centred at (x, y): two silver for level 2, three gold for level 3. Level 1 has none. */
function drawRank(g: Graphics, x: number, y: number, level: number, alpha = 1, size = 1): void {
  const color = rankColor(level);
  const w = 7 * size;
  const gap = 5 * size;
  const total = (level - 1) * gap;
  for (let i = 0; i < level; i++) {
    const cy = y - total / 2 + i * gap;
    const h = 2 * size;
    g.moveTo(x - w, cy - h).lineTo(x, cy + h).lineTo(x + w, cy - h).stroke({ color: TABLE.ink, width: 5 * size, alpha: alpha * 0.8, cap: "round", join: "round" });
    g.moveTo(x - w, cy - h).lineTo(x, cy + h).lineTo(x + w, cy - h).stroke({ color, width: 2.5 * size, alpha, cap: "round", join: "round" });
  }
}

import { Application, Container, Graphics, Text } from "pixi.js";
import { CARDS, SIZE } from "../shared/cards";
import { COLS, FIELD_HEIGHT, FIELD_WIDTH, type Fx, MAX_LEVEL, ROW_HEIGHT, ROWS, SHRINE } from "../shared/sim";

export const PALETTE = {
  page: 0x1e2230,
  lane: [0x2b3245, 0x283043],
  zone: 0x232838,
  pad: 0x2f3750,
  padHover: 0x46527a,
  padBorder: 0x3d4766,
  target: 0xffd166,
  blocked: 0xff6b6b,
  level: 0xffd166,
  me: 0x4f8fe0,
  them: 0xe0624f,
  outline: 0x12141c,
  hpBack: 0x12141c,
  hp: 0x7fd38a,
  heal: 0x7fd38a,
  frost: 0x9fdcff,
  haste: 0xffd166,
  lightning: 0xfff3a0,
  shrine: 0xc9b6ff,
  fury: 0xff5a3c,
  meteor: 0xff9a3c,
  /** Rank colours for levels 2 and 3. */
  silver: 0xdfe6f2,
  gold: 0xffc93c,
  white: 0xffffff,
};

/** Units grow a little with each level, on top of their rank marks. */
const LEVEL_SIZE = [1, 1.15, 1.32];

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
  x: number;
  y: number;
  hp: number;
  age: number;
  flash: number;
  lunge: number;
  lungeX: number;
  lungeY: number;
  /** Time the unit left the state. */
  gone?: number;
}

interface ActiveFx {
  fx: Fx;
  age: number;
  life: number;
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
const HUD_TOP = 80;
const HUD_BOTTOM = 210;
/** Higher is snappier; positions arrive 20 times a second. */
const SMOOTHING = 18;
const FX_SECONDS = { hit: 0.3, heal: 0.4, death: 0.5, breach: 0.8, spell: 0.7, shrine: 0.9 };
const FLASH_SECONDS = 0.12;
const LUNGE_SECONDS = 0.16;
const SPAWN_SECONDS = 0.2;

/** Left edge of a build pad slot on the left (0) or right (1) board. Column COLS - 1 sits next to the base. */
function slotX(board: number, col: number): number {
  return board === 0 ? -LEFT + col * SLOT_WIDTH : FIELD_WIDTH + LEFT - (col + 1) * SLOT_WIDTH;
}

/** Left edge of a build pad. */
function padX(board: number, cell: number): number {
  return slotX(board, cell % COLS) + (SLOT_WIDTH - PAD_SIZE) / 2;
}

export class Renderer {
  readonly app = new Application();
  private world = new Container();
  private field = new Graphics();
  private grid = new Graphics();
  private units = new Graphics();
  private effects = new Graphics();
  private labels = new Container();
  private floaters = new Container();
  private padLabels: Text[] = [];
  private shown = new Map<number, Shown>();
  private active: ActiveFx[] = [];
  private floating: Floater[] = [];
  private latest: UnitView[] = [];
  /** Left and right build grids; the right one only shows while `showBoth` is set. */
  private boards: [Board, Board] = [
    { grid: [], levels: [] },
    { grid: [], levels: [] },
  ];
  private showBoth = false;
  /** Seconds left of the flash on a pad that just levelled up, per board cell. */
  private padFlash = new Array<number>(2 * ROWS * COLS).fill(0);
  private shrine = { owner: -1, control: 0 };
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
      background: PALETTE.page,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    parent.appendChild(this.app.canvas);
    this.world.addChild(this.field, this.grid, this.labels, this.units, this.effects, this.floaters);
    this.app.stage.addChild(this.world);
    for (let i = 0; i < 2 * CELLS; i++) {
      const [board, cell] = [Math.floor(i / CELLS), i % CELLS];
      const label = new Text({ text: "", style: { fontFamily: "Segoe UI, sans-serif", fontSize: 13, fontWeight: "600", fill: 0xc9d0e0 } });
      label.anchor.set(0.5, 0);
      label.position.set(padX(board, cell) + PAD_SIZE / 2, padTop(cell) + PAD_SIZE - 20);
      this.padLabels.push(label);
      this.labels.addChild(label);
    }
    this.drawField();
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
      this.fit();
    }
  }

  setShrine(owner: number, control: number): void {
    this.shrine = { owner, control };
  }

  addFx(events: Fx[]): void {
    for (const fx of events) {
      this.active.push({ fx, age: 0, life: FX_SECONDS[fx.type] });
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
        if (victim && victim.hp > 0) {
          this.float(`-${victim.hp}`, victim.x, victim.y - 20, 0xffffff, 15);
          victim.hp = 0;
        }
      } else if (fx.type === "breach") {
        const victim = fx.side === 0 ? 1 : 0;
        this.baseFlash[victim] = 0.3;
        if (victim === this.mySide) this.shake = Math.min(14, this.shake + 6 + fx.damage / 10);
        this.float(`-${fx.damage}`, this.vx(fx.x), fx.y, 0xff8a7a, 30);
      } else if (fx.type === "shrine" && fx.owner !== -1) {
        const text = fx.owner === this.mySide ? `Shrine +${SHRINE.income}/s` : "Shrine lost";
        this.float(text, this.vx(SHRINE.x), SHRINE.y - SHRINE.radius - 10, this.color(fx.owner), 22);
      }
    }
  }

  /** Screen position of the centre of one of the local player's build pads. */
  cellOnScreen(cell: number): { x: number; y: number } {
    const p = this.world.toGlobal({ x: padX(0, cell) + PAD_SIZE / 2, y: padTop(cell) + PAD_SIZE / 2 });
    return { x: p.x, y: p.y };
  }

  /** Field x as drawn: mirrored for side 1 so the local player is always on the left. */
  private vx(x: number): number {
    return this.mySide === 0 ? x : FIELD_WIDTH - x;
  }

  private color(side: number): number {
    return side === this.mySide ? PALETTE.me : PALETTE.them;
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
    this.shake = Math.max(0, this.shake - dt * 40);
    this.world.position.set(
      this.origin.x + (Math.random() - 0.5) * this.shake,
      this.origin.y + (Math.random() - 0.5) * this.shake,
    );
    this.drawField(dt);
    this.drawGrid(dt);
    this.drawUnits(dt);
    this.drawEffects(dt);
    this.updateFloaters(dt);
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
        g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).fill(hover && !blocked ? PALETTE.padHover : PALETTE.pad);
        if (mine && cell === this.selectedCell) g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.white, width: 3 });
        else if (blocked) g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.blocked, width: 2 });
        else if (fits) g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.target, width: 2, alpha: hover ? 1 : 0.35 * pulse });
        else g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.padBorder, width: 1 });

        // Hovering a pad that takes the card previews it there, one level up.
        const preview = hover && fits;
        const upgrade = preview && card !== "";
        const shown = preview ? this.placing : card;
        const shownLevel = preview ? level + 1 : level;
        const cx = x + PAD_SIZE / 2;
        const cy = y + PAD_SIZE / 2 - 8;
        const flash = board * CELLS + cell;
        if (this.padFlash[flash] > 0) {
          g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).fill({ color: rankColor(level), alpha: this.padFlash[flash] * 0.6 });
          this.padFlash[flash] = Math.max(0, this.padFlash[flash] - dt);
        }
        if (shown) drawShape(g, shown, cx, cy, color, 1.15, preview ? (upgrade ? 0.8 : 0.5) : 1);
        else g.rect(cx - 6, cy + 7, 12, 2).fill({ color: PALETTE.padBorder }).rect(cx - 1, cy + 2, 2, 12).fill({ color: PALETTE.padBorder });
        if (shownLevel > 1) drawRank(g, cx, y + 12, shownLevel, preview ? 0.7 : 1);
        if (shownLevel > 1 && !preview) g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: rankColor(shownLevel), width: 2, alpha: 0.8 });
        // Owned pads show their level with chevrons and border; the label only spells it out while previewing an upgrade.
        const blockedMax = blocked && card === this.placing;
        const name = upgrade ? `Level ${level + 1}` : blockedMax ? "Max level" : (CARDS[shown]?.name ?? "");
        if (label.text !== name) label.text = name;
        label.alpha = preview ? 0.6 : 1;
      }
    }
  }

  private drawUnits(dt: number): void {
    const g = this.units.clear();
    const blend = 1 - Math.exp(-SMOOTHING * dt);
    const seen = new Set<number>();
    for (const u of this.latest) {
      seen.add(u.id);
      const vx = this.vx(u.x);
      let s = this.shown.get(u.id);
      if (!s) this.shown.set(u.id, (s = { x: vx, y: u.y, hp: u.hp, age: 0, flash: 0, lunge: 0, lungeX: 0, lungeY: 0 }));
      s.x += (vx - s.x) * blend;
      s.y += (u.y - s.y) * blend;
      s.age += dt;
      if (u.hp < s.hp) {
        s.flash = FLASH_SECONDS;
        this.float(`-${s.hp - u.hp}`, s.x, s.y - 20, 0xffffff, 15);
      } else if (u.hp > s.hp) {
        this.float(`+${u.hp - s.hp}`, s.x, s.y - 20, PALETTE.heal, 15);
      }
      s.hp = u.hp;
      s.flash = Math.max(0, s.flash - dt);
      s.lunge = Math.max(0, s.lunge - dt);

      const reach = Math.sin((Math.PI * s.lunge) / LUNGE_SECONDS) * 9;
      const x = s.x + s.lungeX * reach;
      const y = s.y + s.lungeY * reach;
      const scale = Math.min(1, 0.4 + (0.6 * s.age) / SPAWN_SECONDS) * (LEVEL_SIZE[u.level - 1] ?? 1);
      const r = SIZE[roleOf(u.card)] * scale;
      const color = this.color(u.side);

      // Level 3 units carry a soft gold glow under them so they stand out in a crowd.
      if (u.level >= 3) g.circle(x, y, r + 9 + Math.sin(this.time * 5) * 1.5).fill({ color: PALETTE.gold, alpha: 0.18 });
      if (u.fury) g.circle(x, y, r + 6).stroke({ color: PALETTE.fury, width: 3, alpha: 0.6 + 0.3 * Math.sin(this.time * 14) });

      if (u.hasted) {
        const back = u.side === this.mySide ? -1 : 1;
        for (const off of [-r / 2, 0, r / 2]) {
          g.moveTo(x + back * (r + 4), y + off).lineTo(x + back * (r + 14), y + off).stroke({ color: PALETTE.haste, width: 2, alpha: 0.8 });
        }
      }
      drawShape(g, u.card, x, y, u.frozen ? PALETTE.frost : color, scale, 1, u.level > 1 ? rankColor(u.level) : PALETTE.outline);
      if (s.flash > 0) drawShape(g, u.card, x, y, PALETTE.white, scale, s.flash / FLASH_SECONDS);
      if (u.level > 1) drawRank(g, x, y + r + 10, u.level, 1, 1.3);
      if (u.hp < u.maxHp) {
        const w = Math.max(24, r * 2);
        g.rect(x - w / 2 - 1, y - r - 11, w + 2, 6).fill(PALETTE.hpBack);
        g.rect(x - w / 2, y - r - 10, (w * Math.max(0, u.hp)) / u.maxHp, 4).fill(u.side === this.mySide ? PALETTE.hp : 0xf2a65a);
      }
    }
    // Keep removed units briefly so a death event that arrives after the state patch can still find them.
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      s.gone ??= this.time;
      if (this.time - s.gone > 1) this.shown.delete(id);
    }
  }

  private drawEffects(dt: number): void {
    const g = this.effects.clear();
    this.active = this.active.filter((a) => (a.age += dt) < a.life);
    for (const { fx, age, life } of this.active) {
      const t = age / life;
      const alpha = 1 - t;
      if (fx.type === "hit") {
        const [x, tx] = [this.vx(fx.x), this.vx(fx.tx)];
        const color = this.color(fx.side);
        if (fx.ranged) {
          // Projectile flies for the first 40% of the effect, then the impact shows.
          const f = Math.min(1, t / 0.4);
          if (f < 1) {
            const px = x + (tx - x) * f;
            const py = fx.y + (fx.ty - fx.y) * f;
            const d = Math.hypot(tx - x, fx.ty - fx.y) || 1;
            g.moveTo(px - ((tx - x) / d) * 14, py - ((fx.ty - fx.y) / d) * 14)
              .lineTo(px, py)
              .stroke({ color, width: 3 });
            g.circle(px, py, 3).fill(PALETTE.white);
            continue;
          }
          const k = (t - 0.4) / 0.6;
          if (fx.splash) {
            g.circle(tx, fx.ty, fx.splash * (0.5 + 0.5 * k)).fill({ color: 0xffb347, alpha: 0.35 * (1 - k) });
            g.circle(tx, fx.ty, fx.splash * (0.5 + 0.5 * k)).stroke({ color: 0xffd8a0, width: 3, alpha: 1 - k });
          } else {
            g.circle(tx, fx.ty, 5 + 8 * k).stroke({ color: PALETTE.white, width: 2, alpha: 1 - k });
          }
        } else {
          // Melee: a short slash spark at the target.
          const s = 6 + 10 * t;
          g.moveTo(tx - s, fx.ty - s).lineTo(tx + s, fx.ty + s).stroke({ color: PALETTE.white, width: 3, alpha });
          g.moveTo(tx + s, fx.ty - s).lineTo(tx - s, fx.ty + s).stroke({ color: PALETTE.white, width: 2, alpha: alpha * 0.6 });
        }
      } else if (fx.type === "heal") {
        g.moveTo(this.vx(fx.x), fx.y).lineTo(this.vx(fx.tx), fx.ty).stroke({ color: PALETTE.heal, width: 3, alpha });
        g.circle(this.vx(fx.tx), fx.ty, 8 + 10 * t).stroke({ color: PALETTE.heal, width: 2, alpha });
      } else if (fx.type === "breach") {
        const x = this.vx(fx.x);
        g.circle(x, fx.y, 14 + 70 * t).stroke({ color: this.color(fx.side), width: 8 * alpha + 1, alpha });
        g.circle(x, fx.y, 30 * alpha).fill({ color: PALETTE.white, alpha: alpha * 0.7 });
      } else if (fx.type === "death") {
        const x = this.vx(fx.x);
        const color = this.color(fx.side);
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4 + 0.3;
          const d = 6 + 30 * t;
          g.circle(x + Math.cos(a) * d, fx.y + Math.sin(a) * d, 4 * alpha + 1).fill({ color, alpha });
        }
      } else if (fx.type === "shrine") {
        const color = fx.owner === -1 ? PALETTE.shrine : this.color(fx.owner);
        g.circle(this.vx(SHRINE.x), SHRINE.y, SHRINE.radius * (1 + t)).stroke({ color, width: 8 * alpha + 1, alpha });
      } else {
        this.drawSpell(g, fx, t);
      }
    }
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
        g.circle(x, y, 10 + 26 * t).stroke({ color: PALETTE.white, width: 2, alpha });
      } else if (fx.card === "meteor") {
        // Falls from the upper right for the first 30%, then a wide blast.
        const radius = CARDS.meteor.kind === "spell" && CARDS.meteor.effect.type === "meteor" ? CARDS.meteor.effect.radius : 80;
        if (t < 0.3) {
          const k = t / 0.3;
          const [sx, sy] = [x + 220 * (1 - k), y - 320 * (1 - k)];
          g.moveTo(sx + 50, sy - 70).lineTo(sx, sy).stroke({ color: PALETTE.meteor, width: 8, alpha: 0.7 });
          g.circle(sx, sy, 12).fill(PALETTE.white).circle(sx, sy, 16).stroke({ color: PALETTE.meteor, width: 4 });
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
        g.rect(x - 2, y - 40 * (1 - t) - 30, 4, 30).fill({ color: PALETTE.white, alpha });
        g.circle(x, y, 14 + 30 * t).stroke({ color: PALETTE.me, width: 4 * alpha + 1, alpha });
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
      style: { fontFamily: "Segoe UI, sans-serif", fontSize: size, fontWeight: "800", fill, stroke: { color: PALETTE.outline, width: 4 } },
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

  private drawField(dt = 0): void {
    const g = this.field.clear();
    // Deploy zone behind your base, with each lane running from your pads to the enemy base.
    g.roundRect(-LEFT - 8, -8, GRID_WIDTH + 16, FIELD_HEIGHT + 16, 16).fill(PALETTE.zone);
    if (this.showBoth) g.roundRect(FIELD_WIDTH + LEFT - GRID_WIDTH - 8, -8, GRID_WIDTH + 16, FIELD_HEIGHT + 16, 16).fill(PALETTE.zone);
    for (let row = 0; row < ROWS; row++) {
      g.rect(0, row * ROW_HEIGHT, FIELD_WIDTH, ROW_HEIGHT).fill(PALETTE.lane[row % 2]);
      for (let x = 60; x < FIELD_WIDTH; x += 120) {
        const y = row * ROW_HEIGHT + ROW_HEIGHT / 2;
        g.poly([x, y - 8, x + 8, y, x, y + 8, x + 3, y]).fill({ color: 0xffffff, alpha: 0.03 });
      }
    }
    this.drawShrine(g);
    for (const [x, side] of [
      [-BASE_WIDTH, this.mySide],
      [FIELD_WIDTH, 1 - this.mySide],
    ] as const) {
      const color = this.color(side);
      g.roundRect(x, -10, BASE_WIDTH, FIELD_HEIGHT + 20, 10).fill(color);
      for (let i = 0; i < 6; i++) g.rect(x + 8, 10 + (i * (FIELD_HEIGHT - 20)) / 6, BASE_WIDTH - 16, 6).fill({ color: PALETTE.outline, alpha: 0.2 });
      g.circle(x + BASE_WIDTH / 2, FIELD_HEIGHT / 2, 18).fill(PALETTE.outline).circle(x + BASE_WIDTH / 2, FIELD_HEIGHT / 2, 12).fill(color);
      if (this.baseFlash[side] > 0) {
        g.roundRect(x, -10, BASE_WIDTH, FIELD_HEIGHT + 20, 10).fill({ color: PALETTE.white, alpha: this.baseFlash[side] * 2 });
        this.baseFlash[side] = Math.max(0, this.baseFlash[side] - dt);
      }
    }
  }

  /** Neutral capture point: tinted by its owner, with a ring that fills toward whoever is taking it. */
  private drawShrine(g: Graphics): void {
    const { owner, control } = this.shrine;
    const x = this.vx(SHRINE.x);
    const r = SHRINE.radius;
    const tint = owner === -1 ? PALETTE.shrine : this.color(owner);
    g.circle(x, SHRINE.y, r).fill({ color: tint, alpha: owner === -1 ? 0.06 : 0.14 });
    g.circle(x, SHRINE.y, r).stroke({ color: tint, width: 2, alpha: 0.35 });
    const k = Math.abs(control) / SHRINE.captureTicks;
    if (k > 0 && k < 1) {
      const toward = control > 0 ? 0 : 1;
      // Start a fresh sub-path at the top; otherwise Pixi joins the arc to the previous shape with a stray line.
      const start = -Math.PI / 2;
      g.moveTo(x, SHRINE.y - r).arc(x, SHRINE.y, r, start, start + k * Math.PI * 2).stroke({ color: this.color(toward), width: 5, alpha: 0.9 });
    }
    const s = 14 + Math.sin(this.time * 3) * 1.5;
    g.poly([x, SHRINE.y - s, x + s * 0.7, SHRINE.y, x, SHRINE.y + s, x - s * 0.7, SHRINE.y])
      .fill({ color: tint, alpha: owner === -1 ? 0.5 : 0.9 })
      .stroke({ color: PALETTE.outline, width: 2 });
  }

  private fit(): void {
    const { width, height } = this.app.screen;
    // Spectators see both grids; a player sees only their own, so the enemy base ends the view.
    const total = LEFT + FIELD_WIDTH + (this.showBoth ? LEFT : BASE_WIDTH);
    // Spectators have no hand, so the field can use the space at the bottom.
    const bottom = this.interactive ? HUD_BOTTOM : HUD_TOP;
    const scale = Math.min((width - 32) / total, (height - HUD_TOP - bottom) / (FIELD_HEIGHT + 20));
    this.world.scale.set(scale);
    this.origin = {
      x: (width - total * scale) / 2 + LEFT * scale,
      y: HUD_TOP + (height - HUD_TOP - bottom - FIELD_HEIGHT * scale) / 2,
    };
    this.world.position.set(this.origin.x, this.origin.y);
  }
}

function padTop(cell: number): number {
  return Math.floor(cell / COLS) * ROW_HEIGHT + (ROW_HEIGHT - PAD_SIZE) / 2;
}

function rankColor(level: number): number {
  return level >= 3 ? PALETTE.gold : level === 2 ? PALETTE.silver : PALETTE.padBorder;
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
    g.moveTo(x - w, cy - h).lineTo(x, cy + h).lineTo(x + w, cy - h).stroke({ color: PALETTE.outline, width: 5 * size, alpha: alpha * 0.8, cap: "round", join: "round" });
    g.moveTo(x - w, cy - h).lineTo(x, cy + h).lineTo(x + w, cy - h).stroke({ color, width: 2.5 * size, alpha, cap: "round", join: "round" });
  }
}

function roleOf(cardId: string) {
  const card = CARDS[cardId];
  return card?.kind === "unit" ? card.role : "melee";
}

/** Each role gets its own silhouette so units read at a glance. */
function drawShape(g: Graphics, cardId: string, x: number, y: number, color: number, scale = 1, alpha = 1, outline?: number): void {
  const card = CARDS[cardId];
  if (card?.kind !== "unit") return;
  const r = SIZE[card.role] * scale;
  const fill = { color, alpha };
  switch (card.role) {
    case "melee":
      g.circle(x, y, r);
      break;
    case "ranged":
      g.poly([x, y - r, x + r, y + r * 0.8, x - r, y + r * 0.8]);
      break;
    case "tank":
      g.roundRect(x - r, y - r, r * 2, r * 2, 5);
      break;
    case "fast":
      g.poly([x, y - r, x + r, y, x, y + r, x - r, y]);
      break;
    case "splash": {
      const points: number[] = [];
      for (let i = 0; i < 6; i++) points.push(x + r * Math.cos((i * Math.PI) / 3), y + r * Math.sin((i * Math.PI) / 3));
      g.poly(points);
      break;
    }
    case "healer":
      g.poly([
        x - r / 3, y - r, x + r / 3, y - r, x + r / 3, y - r / 3, x + r, y - r / 3, x + r, y + r / 3, x + r / 3, y + r / 3,
        x + r / 3, y + r, x - r / 3, y + r, x - r / 3, y + r / 3, x - r, y + r / 3, x - r, y - r / 3, x - r / 3, y - r / 3,
      ]);
      break;
  }
  g.fill(fill);
  // Levelled units get a thicker outline in their rank colour.
  if (outline !== undefined) g.stroke({ color: outline, width: outline === PALETTE.outline ? 2.5 : 3.5, alpha: outline === PALETTE.outline ? 0.8 : 1 });
  // A heavier card gets a ring so a Golem doesn't look like a Brute.
  if (card.cost >= 55) g.circle(x, y, r + 4).stroke({ color, width: 2, alpha: 0.7 * alpha });
}

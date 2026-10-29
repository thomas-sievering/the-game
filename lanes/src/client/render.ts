import { Application, Container, Graphics, Text } from "pixi.js";
import { CARDS, SIZE } from "../shared/cards";
import { COLS, FIELD_HEIGHT, FIELD_WIDTH, type Fx, ROW_HEIGHT, ROWS } from "../shared/sim";

export const PALETTE = {
  page: 0x1e2230,
  lane: [0x2b3245, 0x283043],
  zone: 0x232838,
  pad: 0x2f3750,
  padHover: 0x46527a,
  padBorder: 0x3d4766,
  target: 0xffd166,
  me: 0x4f8fe0,
  them: 0xe0624f,
  outline: 0x12141c,
  hpBack: 0x12141c,
  hp: 0x7fd38a,
  heal: 0x7fd38a,
  frost: 0x9fdcff,
  haste: 0xffd166,
  lightning: 0xfff3a0,
  white: 0xffffff,
};

export interface UnitView {
  id: number;
  side: number;
  card: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  hasted: boolean;
  frozen: boolean;
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
const TOTAL_WIDTH = LEFT + FIELD_WIDTH + BASE_WIDTH;
const HUD_TOP = 80;
const HUD_BOTTOM = 210;
/** Higher is snappier; positions arrive 20 times a second. */
const SMOOTHING = 18;
const FX_SECONDS = { hit: 0.3, heal: 0.4, death: 0.5, breach: 0.8, spell: 0.7 };
const FLASH_SECONDS = 0.12;
const LUNGE_SECONDS = 0.16;
const SPAWN_SECONDS = 0.2;

/** Left edge of a build pad slot. Column COLS - 1 sits next to the base. */
function slotX(col: number): number {
  return -LEFT + col * SLOT_WIDTH;
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
  private myGrid: string[] = [];
  private hoverCell = -1;
  private shake = 0;
  private baseFlash = [0, 0];
  private time = 0;
  private origin = { x: 0, y: 0 };

  /** The local player's side. They are always drawn on the left. */
  mySide = 0;
  /** The unit card waiting for a pad, or "" when nothing is being placed. */
  placing = "";
  onCell: (cell: number) => void = () => {};

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
    for (let cell = 0; cell < ROWS * COLS; cell++) {
      const label = new Text({ text: "", style: { fontFamily: "Segoe UI, sans-serif", fontSize: 13, fontWeight: "600", fill: 0xc9d0e0 } });
      label.anchor.set(0.5, 0);
      label.position.set(slotX(cell % COLS) + SLOT_WIDTH / 2, padTop(cell) + PAD_SIZE - 20);
      this.padLabels.push(label);
      this.labels.addChild(label);
    }
    this.drawField();
    this.app.renderer.on("resize", () => this.fit());
    this.fit();

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointermove", (e) => {
      this.hoverCell = this.cellAt(this.world.toLocal(e.global));
      this.app.canvas.style.cursor = this.hoverCell !== -1 && this.placing ? "pointer" : "";
    });
    this.app.stage.on("pointerdown", (e) => {
      const cell = this.cellAt(this.world.toLocal(e.global));
      if (cell !== -1) this.onCell(cell);
    });
    this.app.ticker.add((ticker) => this.frame(Math.min(0.1, ticker.deltaMS / 1000)));
  }

  setUnits(units: UnitView[]): void {
    this.latest = units;
  }

  setGrid(grid: string[]): void {
    this.myGrid = grid;
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
      } else if (fx.type === "breach") {
        const victim = fx.side === 0 ? 1 : 0;
        this.baseFlash[victim] = 0.3;
        if (victim === this.mySide) this.shake = Math.min(14, this.shake + 6 + fx.damage / 10);
        this.float(`-${fx.damage}`, this.vx(fx.x), fx.y, 0xff8a7a, 30);
      }
    }
  }

  /** Screen position of the centre of one of the local player's build pads. */
  cellOnScreen(cell: number): { x: number; y: number } {
    const p = this.world.toGlobal({ x: slotX(cell % COLS) + SLOT_WIDTH / 2, y: padTop(cell) + PAD_SIZE / 2 });
    return { x: p.x, y: p.y };
  }

  /** Field x as drawn: mirrored for side 1 so the local player is always on the left. */
  private vx(x: number): number {
    return this.mySide === 0 ? x : FIELD_WIDTH - x;
  }

  private color(side: number): number {
    return side === this.mySide ? PALETTE.me : PALETTE.them;
  }

  private cellAt(p: { x: number; y: number }): number {
    for (let cell = 0; cell < ROWS * COLS; cell++) {
      const x = slotX(cell % COLS) + (SLOT_WIDTH - PAD_SIZE) / 2;
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
    this.drawGrid();
    this.drawUnits(dt);
    this.drawEffects(dt);
    this.updateFloaters(dt);
  }

  private drawGrid(): void {
    const g = this.grid.clear();
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 6);
    for (let cell = 0; cell < ROWS * COLS; cell++) {
      const x = slotX(cell % COLS) + (SLOT_WIDTH - PAD_SIZE) / 2;
      const y = padTop(cell);
      const hover = cell === this.hoverCell && this.placing !== "";
      g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).fill(hover ? PALETTE.padHover : PALETTE.pad);
      if (this.placing) g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.target, width: 2, alpha: hover ? 1 : 0.35 * pulse });
      else g.roundRect(x, y, PAD_SIZE, PAD_SIZE, 12).stroke({ color: PALETTE.padBorder, width: 1 });

      const card = this.myGrid[cell] ?? "";
      const cx = x + PAD_SIZE / 2;
      const cy = y + PAD_SIZE / 2 - 8;
      if (hover) drawShape(g, this.placing, cx, cy, PALETTE.me, 1.15, 0.5);
      else if (card) drawShape(g, card, cx, cy, PALETTE.me, 1.15);
      else g.rect(cx - 6, cy + 7, 12, 2).fill({ color: PALETTE.padBorder }).rect(cx - 1, cy + 2, 2, 12).fill({ color: PALETTE.padBorder });
      const name = hover ? (CARDS[this.placing]?.name ?? "") : (CARDS[card]?.name ?? "");
      if (this.padLabels[cell].text !== name) this.padLabels[cell].text = name;
      this.padLabels[cell].alpha = hover ? 0.6 : 1;
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
      const scale = Math.min(1, 0.4 + (0.6 * s.age) / SPAWN_SECONDS);
      const r = SIZE[roleOf(u.card)] * scale;
      const color = this.color(u.side);

      if (u.hasted) {
        const back = u.side === this.mySide ? -1 : 1;
        for (const off of [-r / 2, 0, r / 2]) {
          g.moveTo(x + back * (r + 4), y + off).lineTo(x + back * (r + 14), y + off).stroke({ color: PALETTE.haste, width: 2, alpha: 0.8 });
        }
      }
      drawShape(g, u.card, x, y, u.frozen ? PALETTE.frost : color, scale, 1, true);
      if (s.flash > 0) drawShape(g, u.card, x, y, PALETTE.white, scale, s.flash / FLASH_SECONDS);
      if (u.hp < u.maxHp) {
        const w = Math.max(24, r * 2);
        g.rect(x - w / 2 - 1, y - r - 11, w + 2, 6).fill(PALETTE.hpBack);
        g.rect(x - w / 2, y - r - 10, (w * Math.max(0, u.hp)) / u.maxHp, 4).fill(u.side === this.mySide ? PALETTE.hp : 0xf2a65a);
      }
    }
    for (const id of this.shown.keys()) if (!seen.has(id)) this.shown.delete(id);
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
    for (let row = 0; row < ROWS; row++) {
      g.rect(0, row * ROW_HEIGHT, FIELD_WIDTH, ROW_HEIGHT).fill(PALETTE.lane[row % 2]);
      for (let x = 60; x < FIELD_WIDTH; x += 120) {
        const y = row * ROW_HEIGHT + ROW_HEIGHT / 2;
        g.poly([x, y - 8, x + 8, y, x, y + 8, x + 3, y]).fill({ color: 0xffffff, alpha: 0.03 });
      }
    }
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

  private fit(): void {
    const { width, height } = this.app.screen;
    const scale = Math.min((width - 32) / TOTAL_WIDTH, (height - HUD_TOP - HUD_BOTTOM) / (FIELD_HEIGHT + 20));
    this.world.scale.set(scale);
    this.origin = {
      x: (width - TOTAL_WIDTH * scale) / 2 + LEFT * scale,
      y: HUD_TOP + (height - HUD_TOP - HUD_BOTTOM - FIELD_HEIGHT * scale) / 2,
    };
    this.world.position.set(this.origin.x, this.origin.y);
  }
}

function padTop(cell: number): number {
  return Math.floor(cell / COLS) * ROW_HEIGHT + (ROW_HEIGHT - PAD_SIZE) / 2;
}

function roleOf(cardId: string) {
  const card = CARDS[cardId];
  return card?.kind === "unit" ? card.role : "melee";
}

/** Each role gets its own silhouette so units read at a glance. */
function drawShape(g: Graphics, cardId: string, x: number, y: number, color: number, scale = 1, alpha = 1, outline = false): void {
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
  if (outline) g.stroke({ color: PALETTE.outline, width: 2.5, alpha: 0.8 });
  // A heavier card gets a ring so a Golem doesn't look like a Brute.
  if (card.cost >= 55) g.circle(x, y, r + 4).stroke({ color, width: 2, alpha: 0.7 * alpha });
}

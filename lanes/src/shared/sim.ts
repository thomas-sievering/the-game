// Deterministic battle simulation shared by server and tests.
// Use only + - * / and Math.sqrt on non-integers, and keep iteration order stable.
// The RNG uses integer % on values below 2^53, which is exact.

import { CARDS, SIZE, type SpellCard, STARTER_DECK, unitCard } from "./cards";

export const TICK_RATE = 20;
export const FIELD_WIDTH = 1200;
export const ROWS = 3;
export const COLS = 4;
export const ROW_HEIGHT = 140;
export const FIELD_HEIGHT = ROWS * ROW_HEIGHT;
export const BASE_HP = 1500;
export const WAVE_TICKS = 20 * TICK_RATE;
export const MATCH_TICKS = 10 * 60 * TICK_RATE;
export const HAND_SIZE = 4;
export const START_GOLD = 100;
export const START_INCOME = 4;
export const INVEST_COST = 75;
export const INVEST_COST_STEP = 25;
/** How far away a unit notices enemies and leaves its row to fight them. */
export const AGGRO_RANGE = 170;
/** Each column closer to the field spawns this much further forward. */
export const COLUMN_SPAWN_STEP = 15;
export const DRAW = 2;
/** Each base shoots the nearest enemy in reach. */
export const TURRET = { damage: 25, range: 160, attackTicks: 20 };

export type Side = 0 | 1;

export interface Unit {
  id: number;
  side: Side;
  card: string;
  row: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number;
  hasteTicks: number;
  hasteMultiplier: number;
  frozenTicks: number;
  breached?: boolean;
}

export interface Player {
  gold: number;
  /** Gold gained per second. */
  income: number;
  investCost: number;
  baseHp: number;
  /** Draw pile; the next card is the last element. */
  deck: string[];
  hand: string[];
  discard: string[];
  /** Card id per build cell (index row * COLS + col), "" when empty. Column COLS - 1 is nearest the field. */
  grid: string[];
  /** Tick at which each spell can be cast again. */
  ready: Record<string, number>;
  turretCooldown: number;
}

export type Fx =
  /** `id` is the attacker, or 0 for a base turret. */
  | { type: "hit"; id: number; side: Side; x: number; y: number; tx: number; ty: number; ranged: boolean; splash: number }
  | { type: "heal"; x: number; y: number; tx: number; ty: number }
  | { type: "death"; id: number; side: Side; x: number; y: number }
  | { type: "breach"; side: Side; x: number; y: number; damage: number }
  | { type: "spell"; side: Side; card: string; points: [number, number][] };

export interface Battle {
  tick: number;
  nextId: number;
  seed: number;
  units: Unit[];
  players: [Player, Player];
  /** -1 while playing, then the winning side or DRAW. */
  winner: Side | typeof DRAW | -1;
  /** Visual events since the last drain; not needed for the outcome. */
  events: Fx[];
}

export interface BattleOptions {
  seed?: number;
  decks?: [string[], string[]];
}

export function createBattle({ seed = 1, decks = [STARTER_DECK, STARTER_DECK] }: BattleOptions = {}): Battle {
  const battle: Battle = {
    tick: 0,
    nextId: 1,
    seed: seed % 2147483647 || 1,
    units: [],
    players: [createPlayer(), createPlayer()],
    winner: -1,
    events: [],
  };
  for (const side of [0, 1] as const) {
    const player = battle.players[side];
    player.deck = shuffle(battle, [...decks[side]]);
    for (let i = 0; i < HAND_SIZE; i++) player.hand.push(draw(battle, player));
  }
  return battle;
}

function createPlayer(): Player {
  return {
    gold: START_GOLD,
    income: START_INCOME,
    investCost: INVEST_COST,
    baseHp: BASE_HP,
    deck: [],
    hand: [],
    discard: [],
    grid: new Array<string>(ROWS * COLS).fill(""),
    ready: {},
    turretCooldown: 0,
  };
}

function random(battle: Battle): number {
  battle.seed = (battle.seed * 48271) % 2147483647;
  return battle.seed;
}

function shuffle(battle: Battle, cards: string[]): string[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = random(battle) % (i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function draw(battle: Battle, player: Player): string {
  if (player.deck.length === 0) {
    player.deck = shuffle(battle, player.discard);
    player.discard = [];
  }
  return player.deck.pop() ?? "";
}

export function rowCenter(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Plays the card in a hand slot. Unit cards need a build cell; placing on an occupied cell replaces it. Returns an error message or null. */
export function play(battle: Battle, side: Side, handIndex: number, cell?: number): string | null {
  if (battle.winner !== -1) return "The match is over";
  const player = battle.players[side];
  const card = CARDS[player.hand[handIndex] ?? ""];
  if (!card) return "No card in that slot";
  if (card.kind === "unit") {
    if (cell === undefined || !Number.isInteger(cell) || cell < 0 || cell >= ROWS * COLS) return "Pick a cell on your grid";
  } else if ((player.ready[card.id] ?? 0) > battle.tick) {
    return `${card.name} is on cooldown`;
  }
  if (player.gold < card.cost) return "Not enough gold";

  player.gold -= card.cost;
  if (card.kind === "unit") player.grid[cell!] = card.id;
  else cast(battle, side, card);
  player.discard.push(card.id);
  player.hand[handIndex] = draw(battle, player);
  return null;
}

/** Spends gold for +1 income per second. Returns an error message or null. */
export function invest(battle: Battle, side: Side): string | null {
  if (battle.winner !== -1) return "The match is over";
  const player = battle.players[side];
  if (player.gold < player.investCost) return "Not enough gold";
  player.gold -= player.investCost;
  player.income += 1;
  player.investCost += INVEST_COST_STEP;
  return null;
}

function cast(battle: Battle, side: Side, card: SpellCard): void {
  battle.players[side].ready[card.id] = battle.tick + card.cooldownTicks;
  const effect = card.effect;
  const mine = battle.units.filter((u) => u.side === side && u.hp > 0);
  const theirs = battle.units.filter((u) => u.side !== side && u.hp > 0);
  let hit: Unit[] = [];
  if (effect.type === "haste") {
    hit = mine;
    for (const u of hit) {
      u.hasteTicks = effect.ticks;
      u.hasteMultiplier = effect.multiplier;
    }
  } else if (effect.type === "heal") {
    hit = mine;
    for (const u of hit) u.hp = Math.min(u.maxHp, u.hp + effect.amount);
  } else if (effect.type === "freeze") {
    hit = theirs;
    for (const u of hit) u.frozenTicks = effect.ticks;
  } else {
    hit = theirs.sort((a, b) => advance(b) - advance(a) || a.id - b.id).slice(0, effect.targets);
    for (const u of hit) u.hp -= effect.damage;
  }
  battle.events.push({ type: "spell", side, card: card.id, points: hit.map((u) => [u.x, u.y]) });
}

/** How far a unit has pushed toward the enemy base. */
function advance(unit: Unit): number {
  return unit.side === 0 ? unit.x : FIELD_WIDTH - unit.x;
}

/** Puts a unit on the field as if spawned from a build cell. */
export function spawnUnit(battle: Battle, side: Side, cardId: string, row: number, col = 0, index = 0, count = 1): Unit {
  const card = unitCard(cardId);
  const offset = col * COLUMN_SPAWN_STEP;
  const unit: Unit = {
    id: battle.nextId++,
    side,
    card: cardId,
    row,
    x: side === 0 ? offset : FIELD_WIDTH - offset,
    y: rowCenter(row) + (index - (count - 1) / 2) * 16,
    hp: card.hp,
    maxHp: card.hp,
    cooldown: 0,
    hasteTicks: 0,
    hasteMultiplier: 1,
    frozenTicks: 0,
  };
  battle.units.push(unit);
  return unit;
}

function spawnWave(battle: Battle): void {
  for (const side of [0, 1] as const) {
    const grid = battle.players[side].grid;
    for (let cell = 0; cell < grid.length; cell++) {
      if (!grid[cell]) continue;
      const count = unitCard(grid[cell]).count ?? 1;
      for (let i = 0; i < count; i++) spawnUnit(battle, side, grid[cell], (cell - (cell % COLS)) / COLS, cell % COLS, i, count);
    }
  }
}

/** Ticks until the next wave spawns. */
export function ticksToWave(battle: Battle): number {
  return WAVE_TICKS - (battle.tick % WAVE_TICKS);
}

/** Advances the battle by one tick. */
export function step(battle: Battle): void {
  if (battle.winner !== -1) return;
  battle.tick++;
  if (battle.tick % TICK_RATE === 0) for (const player of battle.players) player.gold += player.income;
  if (battle.tick % WAVE_TICKS === 0) spawnWave(battle);

  for (const side of [0, 1] as const) fireTurret(battle, side);
  for (const unit of battle.units) if (unit.hp > 0) act(battle, unit);
  separate(battle);

  const alive: Unit[] = [];
  for (const unit of battle.units) {
    if (unit.hp > 0) {
      alive.push(unit);
      continue;
    }
    if (unit.breached) continue;
    battle.players[unit.side === 0 ? 1 : 0].gold += unitCard(unit.card).bounty;
    battle.events.push({ type: "death", id: unit.id, side: unit.side, x: unit.x, y: unit.y });
  }
  battle.units = alive;

  const [hp0, hp1] = [battle.players[0].baseHp, battle.players[1].baseHp];
  if (hp0 <= 0 || hp1 <= 0 || battle.tick >= MATCH_TICKS) {
    battle.winner = hp0 === hp1 || (hp0 <= 0 && hp1 <= 0) ? DRAW : hp0 > hp1 ? 0 : 1;
  }
}

/** Nudges overlapping allies apart so a wave reads as a group, not a single blob. */
function separate(battle: Battle): void {
  const units = battle.units;
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    if (a.hp <= 0) continue;
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      if (b.side !== a.side || b.hp <= 0) continue;
      const min = SIZE[unitCard(a.card).role] + SIZE[unitCard(b.card).role];
      const dx = b.x - a.x;
      let dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      let d = Math.sqrt(d2);
      if (d === 0) {
        dy = 1;
        d = 1;
      }
      const push = ((min - d) * 0.25) / d;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
    }
  }
  for (const u of units) {
    u.x = Math.min(FIELD_WIDTH, Math.max(0, u.x));
    u.y = Math.min(FIELD_HEIGHT, Math.max(0, u.y));
  }
}

function fireTurret(battle: Battle, side: Side): void {
  const player = battle.players[side];
  if (player.turretCooldown > 0) {
    player.turretCooldown--;
    return;
  }
  const baseX = side === 0 ? 0 : FIELD_WIDTH;
  let target: Unit | null = null;
  for (const unit of battle.units) {
    if (unit.side === side || unit.hp <= 0) continue;
    const reach = (unit.x - baseX) * (side === 0 ? 1 : -1);
    if (reach <= TURRET.range && (!target || reach < (target.x - baseX) * (side === 0 ? 1 : -1))) target = unit;
  }
  if (!target) return;
  target.hp -= TURRET.damage;
  player.turretCooldown = TURRET.attackTicks;
  battle.events.push({ type: "hit", id: 0, side, x: baseX, y: target.y, tx: target.x, ty: target.y, ranged: true, splash: 0 });
}

function act(battle: Battle, unit: Unit): void {
  if (unit.frozenTicks > 0) {
    unit.frozenTicks--;
    return;
  }
  const card = unitCard(unit.card);
  if (unit.cooldown > 0) unit.cooldown--;
  let speed = card.speed / TICK_RATE;
  if (unit.hasteTicks > 0) {
    unit.hasteTicks--;
    speed *= unit.hasteMultiplier;
  }
  const dir = unit.side === 0 ? 1 : -1;

  if (card.role === "healer") {
    const patient = mostHurtAlly(battle, unit, card.range);
    if (patient) {
      if (unit.cooldown === 0) {
        patient.hp = Math.min(patient.maxHp, patient.hp + card.damage);
        unit.cooldown = card.attackTicks;
        battle.events.push({ type: "heal", x: unit.x, y: unit.y, tx: patient.x, ty: patient.y });
      }
    } else if (!nearestEnemy(battle, unit, card.range)) {
      unit.x += dir * speed;
    }
    return;
  }

  const target = nearestEnemy(battle, unit, Math.max(card.range, AGGRO_RANGE));
  if (target) {
    const dx = target.x - unit.x;
    const dy = target.y - unit.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > card.range) {
      unit.x += (dx / distance) * speed;
      unit.y += (dy / distance) * speed;
    } else if (unit.cooldown === 0) {
      unit.cooldown = card.attackTicks;
      const splash = card.splash ?? 0;
      for (const other of splash ? battle.units : [target]) {
        if (other.side === unit.side || other.hp <= 0) continue;
        const sx = other.x - target.x;
        const sy = other.y - target.y;
        if (other === target || sx * sx + sy * sy <= splash * splash) other.hp -= card.damage;
      }
      battle.events.push({ type: "hit", id: unit.id, side: unit.side, x: unit.x, y: unit.y, tx: target.x, ty: target.y, ranged: card.range > 40, splash });
    }
    return;
  }

  const baseX = unit.side === 0 ? FIELD_WIDTH : 0;
  if ((baseX - unit.x) * dir > 0) {
    unit.x += dir * speed;
    return;
  }
  // Reaching the base breaches it once; the unit is spent and pays no bounty.
  const enemy = battle.players[unit.side === 0 ? 1 : 0];
  enemy.baseHp -= card.cost;
  unit.hp = 0;
  unit.breached = true;
  battle.events.push({ type: "breach", side: unit.side, x: baseX, y: unit.y, damage: card.cost });
}

/** Closest living enemy within range, ties going to the older unit. */
function nearestEnemy(battle: Battle, unit: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  let bestDist = range * range;
  for (const other of battle.units) {
    if (other.side === unit.side || other.hp <= 0) continue;
    const dx = other.x - unit.x;
    const dy = other.y - unit.y;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist && (!best || dist < bestDist)) {
      best = other;
      bestDist = dist;
    }
  }
  return best;
}

function mostHurtAlly(battle: Battle, unit: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  for (const other of battle.units) {
    if (other.side !== unit.side || other === unit || other.hp <= 0 || other.hp >= other.maxHp) continue;
    const dx = other.x - unit.x;
    const dy = other.y - unit.y;
    if (dx * dx + dy * dy > range * range) continue;
    if (!best || other.maxHp - other.hp > best.maxHp - best.hp) best = other;
  }
  return best;
}

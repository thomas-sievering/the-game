// Shared farm simulation. The server runs it; tests drive it directly.
// Keep it deterministic: integer maths only, seeded RNG, stable iteration order.

export const TICK_RATE = 10;
export const MATCH_TICKS = 10 * 60 * TICK_RATE;
export const COLS = 16;
export const ROWS = 12;
export const TILE_COUNT = COLS * ROWS;
export const DRAW = 2;

export const START_COINS = 60;
export const START_SIZE = 2;
export const BARN_CAPACITY = 20;

export const LAND = { base: 20, step: 5, rich: 20, clear: 25 };
/** A buyout costs this many times the tile's value; the old owner gets the value back. */
export const BUYOUT = { factor: 2, cooldownTicks: 20 * TICK_RATE, protectTicks: 30 * TICK_RATE };

/** Growth points a crop gains per tick on wet grass; rich soil adds half, dry soil and weeds halve it. */
export const GROWTH_WET = 8;
/** A crop needs growTicks × GROWTH_FULL points, so on wet grass it ripens in exactly growTicks. */
export const GROWTH_FULL = 8;

export const MARKET = {
  /** Price factor in permille of a crop's base price. */
  full: 1000,
  floor: 250,
  dropPerUnit: 40,
  recoverPerTick: 2,
};

export const CONTRACTS = {
  slots: 3,
  refillTicks: 45 * TICK_RATE,
  lifeTicks: 90 * TICK_RATE,
  /** Reward in percent of the goods' base price. */
  bonus: 160,
};

export type Terrain = "grass" | "rich" | "rock" | "pond";
export type CropId = "wheat" | "carrot" | "pumpkin" | "berries";
export type BuildingId = "well" | "scarecrow" | "silo";
export type SabotageId = "crows" | "weeds" | "dump";
export type Side = 0 | 1;

export interface Crop {
  id: CropId;
  name: string;
  seed: number;
  growTicks: number;
  /** Berries grow back after harvest in this many ticks instead of being replanted. */
  regrowTicks?: number;
  price: number;
}

export const CROPS: Record<CropId, Crop> = {
  wheat: { id: "wheat", name: "Wheat", seed: 5, growTicks: 20 * TICK_RATE, price: 14 },
  carrot: { id: "carrot", name: "Carrot", seed: 12, growTicks: 35 * TICK_RATE, price: 34 },
  pumpkin: { id: "pumpkin", name: "Pumpkin", seed: 30, growTicks: 60 * TICK_RATE, price: 85 },
  berries: { id: "berries", name: "Berries", seed: 40, growTicks: 30 * TICK_RATE, regrowTicks: 25 * TICK_RATE, price: 20 },
};
export const CROP_IDS = Object.keys(CROPS) as CropId[];

export interface Building {
  id: BuildingId;
  name: string;
  cost: number;
  text: string;
}

export const BUILDINGS: Record<BuildingId, Building> = {
  well: { id: "well", name: "Well", cost: 60, text: "Waters the 8 tiles around it." },
  scarecrow: { id: "scarecrow", name: "Scarecrow", cost: 40, text: "Crows can't land within 2 tiles." },
  silo: { id: "silo", name: "Silo", cost: 80, text: `Barn holds ${BARN_CAPACITY} more crops.` },
};
export const BUILDING_IDS = Object.keys(BUILDINGS) as BuildingId[];

export interface Sabotage {
  id: SabotageId;
  name: string;
  cost: number;
  cooldownTicks: number;
  text: string;
}

export const SABOTAGE: Record<SabotageId, Sabotage> = {
  crows: { id: "crows", name: "Crows", cost: 40, cooldownTicks: 30 * TICK_RATE, text: "Eat 3 enemy crops, ripe ones first. Scarecrows stop them." },
  weeds: { id: "weeds", name: "Weeds", cost: 30, cooldownTicks: 25 * TICK_RATE, text: "A 2×2 enemy patch grows at half speed for 30 s." },
  dump: { id: "dump", name: "Market dump", cost: 20, cooldownTicks: 45 * TICK_RATE, text: "Throw away 3 of a crop to crash its price for 20 s." },
};
export const SABOTAGE_IDS = Object.keys(SABOTAGE) as SabotageId[];

// Ids arrive from clients: only exact known strings count, never arrays or inherited keys like "constructor".
const isCrop = (id: unknown): id is CropId => typeof id === "string" && (CROP_IDS as string[]).includes(id);
const isBuilding = (id: unknown): id is BuildingId => typeof id === "string" && (BUILDING_IDS as string[]).includes(id);
const isSabotage = (id: unknown): id is SabotageId => typeof id === "string" && (SABOTAGE_IDS as string[]).includes(id);
export const WEEDS_TICKS = 30 * TICK_RATE;
export const DUMP = { units: 3, freezeTicks: 20 * TICK_RATE };
export const CROWS = { count: 3, scarecrowRange: 2 };

export interface Tile {
  terrain: Terrain;
  /** Owning side, or -1 for neutral land. */
  owner: number;
  /** What the owner paid; counts toward net worth. */
  value: number;
  crop: CropId | "";
  growth: number;
  building: BuildingId | "";
  weedsUntil: number;
  /** A tile can't be bought out again until this tick. */
  protectedUntil: number;
  /** Starting tiles can never be bought out. */
  home: boolean;
}

export interface Player {
  coins: number;
  barn: Record<CropId, number>;
  /** Tiles bought so far, which raises the price of the next one. */
  bought: number;
  /** Tick at which each sabotage, and the buyout, can be used again. */
  ready: Record<SabotageId | "buyout", number>;
}

export interface Contract {
  id: number;
  items: { crop: CropId; count: number }[];
  reward: number;
  expiresAt: number;
}

export type Fx =
  | { type: "harvest"; side: Side; tile: number; crop: CropId }
  | { type: "sell"; side: Side; crop: CropId; count: number; coins: number }
  | { type: "buy"; side: Side; tile: number; cost: number }
  | { type: "buyout"; side: Side; tile: number; cost: number }
  | { type: "contract"; side: Side; reward: number }
  | { type: "crows"; side: Side; tiles: number[] }
  | { type: "weeds"; side: Side; tiles: number[] }
  | { type: "dump"; side: Side; crop: CropId };

export interface Farm {
  tick: number;
  seed: number;
  tiles: Tile[];
  players: [Player, Player];
  /** Market price factor per crop, in permille. */
  market: Record<CropId, number>;
  /** Price recovery for a crop is frozen until this tick after a dump. */
  frozenUntil: Record<CropId, number>;
  contracts: Contract[];
  nextContractAt: number;
  nextContractId: number;
  /** -1 while playing, then the winning side or DRAW. */
  winner: number;
  events: Fx[];
}

export interface FarmOptions {
  seed?: number;
}

const perCrop = <T>(value: T) => Object.fromEntries(CROP_IDS.map((id) => [id, value])) as Record<CropId, T>;

export function createFarm({ seed = 1 }: FarmOptions = {}): Farm {
  const farm: Farm = {
    tick: 0,
    seed: seed % 2147483647 || 1,
    tiles: [],
    players: [newPlayer(), newPlayer()],
    market: perCrop(MARKET.full),
    frozenUntil: perCrop(0),
    contracts: [],
    nextContractAt: 0,
    nextContractId: 1,
    winner: -1,
    events: [],
  };
  generateMap(farm);
  // The first orders expire one after another instead of all at once.
  for (let i = 0; i < CONTRACTS.slots; i++) addContract(farm, (i * CONTRACTS.lifeTicks) / CONTRACTS.slots);
  // The first order is a quick one, so the match opens with a race.
  farm.contracts[0].items = [{ crop: "wheat", count: 2 }];
  farm.contracts[0].reward = Math.floor((CROPS.wheat.price * 2 * CONTRACTS.bonus) / 100);
  farm.nextContractAt = CONTRACTS.refillTicks;
  return farm;
}

function newPlayer(): Player {
  return { coins: START_COINS, barn: perCrop(0), bought: 0, ready: { crows: 0, weeds: 0, dump: 0, buyout: 0 } };
}

function random(farm: Farm): number {
  farm.seed = (farm.seed * 48271) % 2147483647;
  return farm.seed;
}

export const tileAt = (x: number, y: number) => y * COLS + x;
export const tileX = (tile: number) => tile % COLS;
export const tileY = (tile: number) => (tile - (tile % COLS)) / COLS;
/** The board is point-symmetric: side 1's tile for side 0's tile. */
export const mirror = (tile: number) => TILE_COUNT - 1 - tile;

/** Generates the top half and mirrors it so both corners are equal. */
function generateMap(farm: Farm) {
  const half: Terrain[] = [];
  for (let i = 0; i < TILE_COUNT / 2; i++) {
    const roll = random(farm) % 100;
    half.push(roll < 14 ? "rich" : roll < 24 ? "rock" : roll < 28 ? "pond" : "grass");
  }
  for (let i = 0; i < TILE_COUNT / 2; i++) {
    const x = tileX(i);
    const y = tileY(i);
    // Keep the corner around the start plain, and give each player a pond that waters half their start.
    if (x <= START_SIZE + 1 && y <= START_SIZE + 1) half[i] = "grass";
  }
  half[tileAt(START_SIZE, 1)] = "pond";
  for (let i = 0; i < TILE_COUNT; i++) {
    const terrain = i < TILE_COUNT / 2 ? half[i] : half[mirror(i)];
    farm.tiles.push({ terrain, owner: -1, value: 0, crop: "", growth: 0, building: "", weedsUntil: 0, protectedUntil: 0, home: false });
  }
  for (let y = 0; y < START_SIZE; y++) {
    for (let x = 0; x < START_SIZE; x++) {
      for (const [side, tile] of [
        [0, tileAt(x, y)],
        [1, mirror(tileAt(x, y))],
      ]) {
        Object.assign(farm.tiles[tile], { owner: side, value: LAND.base, home: true });
      }
    }
  }
}

function neighbours(tile: number, diagonal: boolean): number[] {
  const x = tileX(tile);
  const y = tileY(tile);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx === 0 && dy === 0) || (!diagonal && dx !== 0 && dy !== 0)) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) out.push(tileAt(nx, ny));
    }
  }
  return out;
}

const distance = (a: number, b: number) => Math.max(Math.abs(tileX(a) - tileX(b)), Math.abs(tileY(a) - tileY(b)));

/** A tile is wet next to a pond or a well. */
export function isWet(farm: Farm, tile: number): boolean {
  return neighbours(tile, true).some((n) => farm.tiles[n].terrain === "pond" || farm.tiles[n].building === "well");
}

function bordersOwn(farm: Farm, side: Side, tile: number): boolean {
  return neighbours(tile, false).some((n) => farm.tiles[n].owner === side);
}

export function landPrice(farm: Farm, side: Side, tile: number): number {
  return LAND.base + farm.players[side].bought * LAND.step + (farm.tiles[tile].terrain === "rich" ? LAND.rich : 0);
}

export function buyoutPrice(farm: Farm, tile: number): number {
  return farm.tiles[tile].value * BUYOUT.factor;
}

export function capacity(farm: Farm, side: Side): number {
  const silos = farm.tiles.filter((t) => t.owner === side && t.building === "silo").length;
  return BARN_CAPACITY * (1 + silos);
}

export function barnCount(player: Player): number {
  return CROP_IDS.reduce((sum, id) => sum + player.barn[id], 0);
}

export function price(farm: Farm, crop: CropId): number {
  return Math.max(1, Math.floor((CROPS[crop].price * farm.market[crop]) / MARKET.full));
}

export function isRipe(tile: Tile): boolean {
  return tile.crop !== "" && tile.growth >= CROPS[tile.crop].growTicks * GROWTH_FULL;
}

/** Growth from 0 to 100. */
export function growthPercent(tile: Tile): number {
  if (!tile.crop) return 0;
  return Math.min(100, Math.floor((100 * tile.growth) / (CROPS[tile.crop].growTicks * GROWTH_FULL)));
}

type Result = string | null;

function check(farm: Farm, tile: number): Result {
  if (farm.winner !== -1) return "The match is over";
  if (!Number.isInteger(tile) || tile < 0 || tile >= TILE_COUNT) return "That's not a tile";
  return null;
}

function owned(farm: Farm, side: Side, tile: number): Result {
  return check(farm, tile) ?? (farm.tiles[tile].owner === side ? null : "That's not your land");
}

function pay(player: Player, cost: number): Result {
  if (player.coins < cost) return `You need ${cost} coins`;
  player.coins -= cost;
  return null;
}

/** Buys a neutral tile next to your land, or buys out an enemy tile next to your land. */
export function buy(farm: Farm, side: Side, tile: number): Result {
  const error = check(farm, tile);
  if (error) return error;
  const t = farm.tiles[tile];
  const player = farm.players[side];
  if (t.owner === side) return "You already own that";
  if (t.terrain === "pond") return "You can't buy a pond";
  if (!bordersOwn(farm, side, tile)) return "You can only buy land next to yours";
  if (t.owner === -1) {
    const cost = landPrice(farm, side, tile);
    const paid = pay(player, cost);
    if (paid) return paid;
    Object.assign(t, { owner: side, value: cost });
    player.bought++;
    farm.events.push({ type: "buy", side, tile, cost });
    return null;
  }
  if (t.home) return "Starting land can't be bought out";
  if (t.building) return "Land with a building can't be bought out";
  if (t.protectedUntil > farm.tick) return "That land was just bought out";
  if (player.ready.buyout > farm.tick) return "Buyout is on cooldown";
  const cost = buyoutPrice(farm, tile);
  const paid = pay(player, cost);
  if (paid) return paid;
  farm.players[t.owner as Side].coins += t.value;
  // The crop changes hands with the land.
  Object.assign(t, { owner: side, value: cost, protectedUntil: farm.tick + BUYOUT.protectTicks });
  player.ready.buyout = farm.tick + BUYOUT.cooldownTicks;
  farm.events.push({ type: "buyout", side, tile, cost });
  return null;
}

export function clearRock(farm: Farm, side: Side, tile: number): Result {
  const error = owned(farm, side, tile);
  if (error) return error;
  const t = farm.tiles[tile];
  if (t.terrain !== "rock") return "There's no rock there";
  const paid = pay(farm.players[side], LAND.clear);
  if (paid) return paid;
  t.terrain = "grass";
  return null;
}

export function plant(farm: Farm, side: Side, tile: number, crop: CropId): Result {
  const error = owned(farm, side, tile);
  if (error) return error;
  const t = farm.tiles[tile];
  if (!isCrop(crop)) return "Unknown crop";
  if (t.terrain === "rock") return "Clear the rock first";
  if (t.crop || t.building) return "That tile is in use";
  const player = farm.players[side];
  // A broke farmer with nothing growing or stored gets wheat seed for free, so nobody gets stuck.
  const stuck = crop === "wheat" && player.coins < CROPS.wheat.seed && barnCount(player) === 0 && !farm.tiles.some((o) => o.owner === side && o.crop);
  const paid = stuck ? null : pay(player, CROPS[crop].seed);
  if (paid) return paid;
  Object.assign(t, { crop, growth: 0 });
  return null;
}

export function harvest(farm: Farm, side: Side, tile: number): Result {
  const error = owned(farm, side, tile);
  if (error) return error;
  const t = farm.tiles[tile];
  if (!isRipe(t)) return "Nothing ripe there";
  const player = farm.players[side];
  if (barnCount(player) >= capacity(farm, side)) return "Your barn is full";
  const crop = t.crop as CropId;
  player.barn[crop]++;
  const { regrowTicks, growTicks } = CROPS[crop];
  if (regrowTicks) t.growth = (growTicks - regrowTicks) * GROWTH_FULL;
  else Object.assign(t, { crop: "", growth: 0 });
  farm.events.push({ type: "harvest", side, tile, crop });
  return null;
}

export function build(farm: Farm, side: Side, tile: number, building: BuildingId): Result {
  const error = owned(farm, side, tile);
  if (error) return error;
  const t = farm.tiles[tile];
  if (!isBuilding(building)) return "Unknown building";
  if (t.terrain === "rock") return "Clear the rock first";
  if (t.crop || t.building) return "That tile is in use";
  // Buildings can't be removed, so keep one plot that can grow crops; otherwise a broke farmer could be stuck for good.
  const plots = farm.tiles.filter((o, i) => i !== tile && o.owner === side && o.terrain !== "rock" && !o.building).length;
  if (plots === 0) return "Keep at least one plot for crops";
  const paid = pay(farm.players[side], BUILDINGS[building].cost);
  if (paid) return paid;
  t.building = building;
  return null;
}

/** Pulls weeds from one of your own tiles. */
export function weed(farm: Farm, side: Side, tile: number): Result {
  const error = owned(farm, side, tile);
  if (error) return error;
  if (farm.tiles[tile].weedsUntil <= farm.tick) return "There are no weeds there";
  farm.tiles[tile].weedsUntil = 0;
  return null;
}

/** Sells crops one by one; each unit sold lowers the price for both players. */
export function sell(farm: Farm, side: Side, crop: CropId, count: number): Result {
  if (farm.winner !== -1) return "The match is over";
  if (!isCrop(crop)) return "Unknown crop";
  const player = farm.players[side];
  const n = Math.min(Math.floor(count), player.barn[crop]);
  if (!(n > 0)) return "You have none to sell";
  let coins = 0;
  for (let i = 0; i < n; i++) {
    coins += price(farm, crop);
    farm.market[crop] = Math.max(MARKET.floor, farm.market[crop] - MARKET.dropPerUnit);
  }
  player.barn[crop] -= n;
  player.coins += coins;
  farm.events.push({ type: "sell", side, crop, count: n, coins });
  return null;
}

export function fill(farm: Farm, side: Side, contractId: number): Result {
  if (farm.winner !== -1) return "The match is over";
  const index = farm.contracts.findIndex((c) => c.id === contractId);
  if (index === -1) return "That order is gone";
  const contract = farm.contracts[index];
  const player = farm.players[side];
  if (contract.items.some((item) => player.barn[item.crop] < item.count)) return "You don't have the goods";
  for (const item of contract.items) player.barn[item.crop] -= item.count;
  player.coins += contract.reward;
  farm.contracts.splice(index, 1);
  farm.events.push({ type: "contract", side, reward: contract.reward });
  return null;
}

/** Crows need no target, weeds target the top-left tile of a 2×2 patch, a dump targets a crop. */
export function sabotage(farm: Farm, side: Side, id: SabotageId, target?: number | CropId): Result {
  if (farm.winner !== -1) return "The match is over";
  if (!isSabotage(id)) return "Unknown sabotage";
  const spec = SABOTAGE[id];
  const player = farm.players[side];
  if (player.ready[id] > farm.tick) return `${spec.name} is on cooldown`;
  if (player.coins < spec.cost) return `You need ${spec.cost} coins`;
  const enemy = (1 - side) as Side;
  let tiles: number[] = [];
  if (id === "crows") {
    const scarecrows = farm.tiles.flatMap((t, i) => (t.owner === enemy && t.building === "scarecrow" ? [i] : []));
    const targets = farm.tiles.flatMap((t, i) =>
      t.owner === enemy && t.crop && !scarecrows.some((s) => distance(s, i) <= CROWS.scarecrowRange) ? [i] : [],
    );
    if (!targets.length) return "No enemy crops the crows can reach";
    const ripe = targets.filter((i) => isRipe(farm.tiles[i]));
    const pool = ripe.length ? ripe : targets;
    while (tiles.length < CROWS.count && pool.length) tiles.push(pool.splice(random(farm) % pool.length, 1)[0]);
    // Top up with growing crops when there are fewer than 3 ripe ones.
    const growing = targets.filter((i) => !tiles.includes(i));
    while (tiles.length < CROWS.count && growing.length) tiles.push(growing.splice(random(farm) % growing.length, 1)[0]);
    for (const tile of tiles) Object.assign(farm.tiles[tile], { crop: "", growth: 0 });
  } else if (id === "weeds") {
    const corner = Number(target);
    if (!Number.isInteger(corner) || corner < 0 || corner >= TILE_COUNT) return "Pick a spot for the weeds";
    const x = Math.min(tileX(corner), COLS - 2);
    const y = Math.min(tileY(corner), ROWS - 2);
    tiles = [tileAt(x, y), tileAt(x + 1, y), tileAt(x, y + 1), tileAt(x + 1, y + 1)].filter((i) => farm.tiles[i].owner === enemy);
    if (!tiles.length) return "Weeds have to hit enemy land";
    for (const tile of tiles) farm.tiles[tile].weedsUntil = farm.tick + WEEDS_TICKS;
  } else {
    const crop = target as CropId;
    if (!isCrop(crop)) return "Pick a crop to dump";
    if (player.barn[crop] < DUMP.units) return `You need ${DUMP.units} ${CROPS[crop].name.toLowerCase()} to dump`;
    player.barn[crop] -= DUMP.units;
    farm.market[crop] = MARKET.floor;
    farm.frozenUntil[crop] = farm.tick + DUMP.freezeTicks;
  }
  player.coins -= spec.cost;
  player.ready[id] = farm.tick + spec.cooldownTicks;
  if (id === "dump") farm.events.push({ type: "dump", side, crop: target as CropId });
  else farm.events.push({ type: id, side, tiles });
  return null;
}

/** Growth points per tick for a crop on this tile. */
export function growthRate(farm: Farm, tile: number): number {
  const t = farm.tiles[tile];
  return rateFor(t.terrain, isWet(farm, tile), t.weedsUntil > farm.tick);
}

/** Growth points per tick from a tile's conditions; the client uses it to show time left. */
export function rateFor(terrain: Terrain | string, wet: boolean, weeds: boolean): number {
  let rate = GROWTH_WET;
  if (terrain === "rich") rate += GROWTH_WET / 2;
  if (!wet) rate /= 2;
  if (weeds) rate /= 2;
  return rate;
}

function addContract(farm: Farm, extraLife = 0) {
  // Later orders ask for pricier crops.
  const minutes = Math.floor(farm.tick / (60 * TICK_RATE));
  const pool = CROP_IDS.slice(0, Math.min(CROP_IDS.length, 2 + Math.floor(minutes / 2)));
  const first = pool[random(farm) % pool.length];
  const items = [{ crop: first, count: contractCount(farm, first) }];
  if (random(farm) % 2 === 0) {
    const rest = pool.filter((id) => id !== first);
    const second = rest[random(farm) % rest.length];
    items.push({ crop: second, count: contractCount(farm, second) });
  }
  const worth = items.reduce((sum, item) => sum + CROPS[item.crop].price * item.count, 0);
  farm.contracts.push({
    id: farm.nextContractId++,
    items,
    reward: Math.floor((worth * CONTRACTS.bonus) / 100),
    expiresAt: farm.tick + CONTRACTS.lifeTicks + extraLife,
  });
}

function contractCount(farm: Farm, crop: CropId): number {
  const max = crop === "pumpkin" ? 3 : crop === "carrot" ? 5 : 8;
  return 2 + (random(farm) % (max - 1));
}

export function netWorth(farm: Farm, side: Side): number {
  const player = farm.players[side];
  let worth = player.coins;
  for (const id of CROP_IDS) worth += player.barn[id] * price(farm, id);
  for (const t of farm.tiles) {
    if (t.owner !== side) continue;
    worth += t.value;
    if (t.building) worth += BUILDINGS[t.building].cost / 2;
    // A crop is worth its market price in proportion to how far it has grown.
    if (t.crop) worth += Math.floor((price(farm, t.crop) * t.growth) / (CROPS[t.crop].growTicks * GROWTH_FULL));
  }
  return worth;
}

/** Ends the match early: the side that left loses. */
export function forfeit(farm: Farm, side: Side) {
  if (farm.winner === -1) farm.winner = 1 - side;
}

export function step(farm: Farm) {
  if (farm.winner !== -1) return;
  farm.tick++;
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = farm.tiles[i];
    if (t.crop && !isRipe(t)) t.growth = Math.min(CROPS[t.crop].growTicks * GROWTH_FULL, t.growth + growthRate(farm, i));
  }
  for (const id of CROP_IDS) {
    if (farm.frozenUntil[id] <= farm.tick) farm.market[id] = Math.min(MARKET.full, farm.market[id] + MARKET.recoverPerTick);
  }
  farm.contracts = farm.contracts.filter((c) => c.expiresAt > farm.tick);
  if (farm.tick >= farm.nextContractAt) {
    if (farm.contracts.length < CONTRACTS.slots) addContract(farm);
    farm.nextContractAt = farm.tick + CONTRACTS.refillTicks;
  }
  if (farm.tick >= MATCH_TICKS) {
    const a = netWorth(farm, 0);
    const b = netWorth(farm, 1);
    farm.winner = a > b ? 0 : b > a ? 1 : DRAW;
  }
}

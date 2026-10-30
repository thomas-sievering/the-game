// Plays greedy bots against each other for a full match and prints how the economy went.
// Run: npx tsx scripts/balance.ts [matches] [--no-research-1]  (the flag stops side 1 researching, to compare)
import {
  CROPS,
  CROP_IDS,
  type CropId,
  type Farm,
  MATCH_TICKS,
  TECH,
  type Side,
  type TechId,
  TICK_RATE,
  TILE_COUNT,
  buy,
  build,
  createFarm,
  fill,
  isRipe,
  isWet,
  landPrice,
  netWorth,
  plant,
  research,
  harvest,
  sabotage,
  sell,
  step,
} from "../src/shared/sim";

/** The order bots research in, when they have coins to spare. */
const RESEARCH: TechId[] = ["fertilizer", "haggling", "survey", "guild", "irrigation", "wholesale", "fences", "hybrid", "dogs"];
const NO_RESEARCH = process.argv.includes("--no-research-1");

/** Each bot acts once a second, like a busy human clicking around. */
function bot(farm: Farm, side: Side, style: "farmer" | "saboteur") {
  const player = farm.players[side];
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = farm.tiles[i];
    if (t.owner !== side) continue;
    if (t.weedsUntil > farm.tick) t.weedsUntil = 0;
    if (isRipe(t)) harvest(farm, side, i);
  }
  for (const c of [...farm.contracts]) fill(farm, side, c.id);
  for (const id of CROP_IDS) if (player.barn[id] > 2) sell(farm, side, id, player.barn[id]);
  if (style === "saboteur" && farm.tick % 300 === 0) sabotage(farm, side, "crows");
  // Research the next tech once selling leaves enough to keep farming.
  const next = RESEARCH.find((id) => !player.tech[id]);
  if (next && !(NO_RESEARCH && side === 1) && player.coins >= TECH[next].cost + 40) research(farm, side, next);
  // Expand while land is cheap compared to coins, preferring wet tiles.
  const options = farm.tiles
    .map((_, i) => i)
    .filter((i) => farm.tiles[i].owner === -1 && farm.tiles[i].terrain !== "pond" && farm.tiles[i].terrain !== "rock")
    .sort((a, b) => Number(isWet(farm, b)) - Number(isWet(farm, a)));
  for (const i of options) {
    if (player.coins < landPrice(farm, side, i) + 40) break;
    buy(farm, side, i);
  }
  if (player.coins > 150 && farm.tiles.filter((t) => t.owner === side && t.building === "well").length < 2) {
    const dry = farm.tiles.findIndex((t, i) => t.owner === side && !t.crop && !t.building && t.terrain !== "rock" && !isWet(farm, i));
    if (dry !== -1) build(farm, side, dry, "well");
  }
  const best: CropId[] = ["pumpkin", "carrot", "berries", "wheat"];
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = farm.tiles[i];
    if (t.owner !== side || t.crop || t.building || t.terrain === "rock") continue;
    const crop = best.find((id) => CROPS[id].seed * 3 <= player.coins) ?? "wheat";
    plant(farm, side, i, crop);
  }
}

const matches = Number(process.argv[2] ?? 5);
for (let m = 0; m < matches; m++) {
  const farm = createFarm({ seed: m + 1 });
  const marks: string[] = [];
  while (farm.winner === -1) {
    if (farm.tick % TICK_RATE === 0) {
      bot(farm, 0, "farmer");
      bot(farm, 1, m % 2 ? "saboteur" : "farmer");
    }
    step(farm);
    farm.events.length = 0;
    if (farm.tick % (2 * 60 * TICK_RATE) === 0 || farm.tick === MATCH_TICKS) {
      const owned = (s: number) => farm.tiles.filter((t) => t.owner === s).length;
      marks.push(`${farm.tick / TICK_RATE / 60}m ${netWorth(farm, 0)}/${netWorth(farm, 1)} land ${owned(0)}/${owned(1)}`);
    }
  }
  console.log(`seed ${m + 1} winner ${farm.winner}: ${marks.join(" | ")}`);
}

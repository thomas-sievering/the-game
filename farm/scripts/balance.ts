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
  claim,
  claimPrice,
  createFarm,
  fill,
  isRipe,
  isWet,
  tileX,
  tileY,
  landPrice,
  netWorth,
  plant,
  research,
  harvest,
  isBehind,
  outpost,
  outpostPrice,
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
  for (const id of CROP_IDS) if (player.barn[id] > 2 || player.coins < 20) sell(farm, side, id, player.barn[id]);
  if (style === "saboteur" && farm.tick % 300 === 0) sabotage(farm, side, "crows");
  const enemy = (1 - side) as Side;
  const centre = (i: number) => Math.abs(2 * tileX(i) - 15) + Math.abs(2 * tileY(i) - 11);
  // Set up the outpost early, on open land near the middle of the board.
  if (!player.outpost && farm.tick >= 30 * TICK_RATE) {
    const spot = farm.tiles
      .map((_, i) => i)
      .filter((i) => farm.tiles[i].owner === -1 && farm.tiles[i].terrain !== "pond" && farm.tiles[i].terrain !== "rock")
      .sort((a, b) => centre(a) - centre(b))[0];
    if (spot !== undefined && player.coins >= outpostPrice(farm, side, spot) + 20) outpost(farm, side, spot);
  }
  // Behind: steal from their barn and claim their best crop.
  if (isBehind(farm, side)) {
    sabotage(farm, side, "rustlers");
    const target = farm.tiles
      .map((_, i) => i)
      .filter((i) => farm.tiles[i].owner === enemy && !farm.tiles[i].home && (!farm.tiles[i].building || farm.tiles[i].building === "goats"))
      .sort((a, b) => Number(farm.tiles[b].building === "goats") - Number(farm.tiles[a].building === "goats") || Number(isRipe(farm.tiles[b])) - Number(isRipe(farm.tiles[a])))[0];
    if (target !== undefined && player.coins >= claimPrice(farm, target) + 40) claim(farm, side, target);
  }
  // A goat pen where it reaches the most enemy crops.
  const pens = farm.tiles.filter((t) => t.owner === side && t.building === "goats").length;
  if (player.coins > 150 && pens < 2) {
    const reach = (i: number) => farm.tiles.filter((t, j) => t.owner === enemy && t.crop && Math.max(Math.abs(tileX(i) - tileX(j)), Math.abs(tileY(i) - tileY(j))) <= 3).length;
    const spot = farm.tiles
      .map((_, i) => i)
      .filter((i) => farm.tiles[i].owner === side && !farm.tiles[i].crop && !farm.tiles[i].building && farm.tiles[i].terrain !== "rock")
      .sort((a, b) => reach(b) - reach(a))[0];
    if (spot !== undefined && reach(spot) >= 3) build(farm, side, spot, "goats");
  }
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
/** Snowball check: how often the leader at 2 minutes wins, and how far apart the farms end up. */
let leaderWins = 0;
const ratios: number[] = [];
for (let m = 0; m < matches; m++) {
  let leader = -1;
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
      if (farm.tick === 2 * 60 * TICK_RATE) leader = netWorth(farm, 0) >= netWorth(farm, 1) ? 0 : 1;
    }
  }
  if (farm.winner === leader) leaderWins++;
  const worth = [netWorth(farm, 0), netWorth(farm, 1)].sort((a, b) => a - b);
  ratios.push(worth[1] / Math.max(1, worth[0]));
  console.log(`seed ${m + 1} winner ${farm.winner}: ${marks.join(" | ")}`);
}
ratios.sort((a, b) => a - b);
console.log(`2-minute leader won ${leaderWins}/${matches}; final net worth ratio median ${ratios[Math.floor(matches / 2)].toFixed(2)}, max ${ratios.at(-1)!.toFixed(2)}`);

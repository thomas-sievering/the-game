import { describe, expect, it } from "vitest";
import {
  BARN_CAPACITY,
  BUILDINGS,
  BEHIND,
  BUYOUT,
  CLAIM,
  CONTRACTS,
  CROPS,
  CROWS,
  DRAW,
  DUMP,
  type Farm,
  GOATS,
  GROWTH_FULL,
  LAND,
  MARKET,
  MATCH_TICKS,
  OUTPOST,
  RUSTLERS,
  SABOTAGE,
  START_COINS,
  TAX,
  TECH,
  TICK_RATE,
  TILE_COUNT,
  WEEDS_TICKS,
  build,
  buy,
  buyoutPrice,
  capacity,
  claim,
  clearRock,
  createFarm,
  fill,
  forfeit,
  harvest,
  isBehind,
  isBehindWorth,
  isRipe,
  isWet,
  landPrice,
  landTax,
  mirror,
  netWorth,
  outpost,
  plant,
  price,
  research,
  sabotage,
  sell,
  step,
  tileAt,
  weed,
} from "../src/shared/sim";

const run = (farm: Farm, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(farm);
};

/** A farm with plain terrain so tests don't depend on the generated map. */
function plainFarm(seed = 1): Farm {
  const farm = createFarm({ seed });
  for (const tile of farm.tiles) tile.terrain = "grass";
  return farm;
}

const rich = (farm: Farm) => {
  for (const player of farm.players) player.coins = 100_000;
  return farm;
};

/** Gives a side a tile directly, as if bought. */
function own(farm: Farm, side: 0 | 1, tile: number, value: number = LAND.base) {
  Object.assign(farm.tiles[tile], { owner: side, value });
}

describe("map", () => {
  it("is point-symmetric and starts each player in a 2×2 corner", () => {
    for (const seed of [1, 7, 12345]) {
      const farm = createFarm({ seed });
      for (let i = 0; i < TILE_COUNT; i++) expect(farm.tiles[i].terrain).toBe(farm.tiles[mirror(i)].terrain);
      for (const tile of [tileAt(0, 0), tileAt(1, 0), tileAt(0, 1), tileAt(1, 1)]) {
        expect(farm.tiles[tile]).toMatchObject({ owner: 0, home: true, terrain: "grass" });
        expect(farm.tiles[mirror(tile)]).toMatchObject({ owner: 1, home: true });
      }
      expect(farm.tiles.filter((t) => t.owner !== -1)).toHaveLength(8);
      expect(farm.players.map((p) => p.coins)).toEqual([START_COINS, START_COINS]);
    }
  });

  it("different seeds make different maps", () => {
    const maps = new Set([1, 2, 3, 4].map((seed) => createFarm({ seed }).tiles.map((t) => t.terrain[0]).join("")));
    expect(maps.size).toBeGreaterThan(1);
  });

  it("gives each player a pond next to their start", () => {
    const farm = createFarm({ seed: 99 });
    expect(farm.tiles[tileAt(2, 1)].terrain).toBe("pond");
    expect(isWet(farm, tileAt(1, 1))).toBe(true);
    expect(isWet(farm, mirror(tileAt(1, 1)))).toBe(true);
    expect(isWet(farm, tileAt(0, 0))).toBe(false);
  });
});

describe("buying land", () => {
  it("only buys neutral land next to your own, each tile dearer than the last", () => {
    const farm = rich(plainFarm());
    expect(buy(farm, 0, tileAt(5, 5))).toMatch(/next to yours/);
    const first = landPrice(farm, 0, tileAt(2, 0));
    expect(first).toBe(LAND.base);
    expect(buy(farm, 0, tileAt(2, 0))).toBeNull();
    expect(farm.tiles[tileAt(2, 0)]).toMatchObject({ owner: 0, value: first });
    expect(landPrice(farm, 0, tileAt(3, 0))).toBe(LAND.base + LAND.step);
    // Diagonal neighbours don't count.
    expect(buy(farm, 0, tileAt(2, 2))).toMatch(/next to yours/);
    expect(buy(farm, 0, tileAt(0, 0))).toMatch(/already own/);
  });

  it("charges extra for rich soil and refuses ponds and missing coins", () => {
    const farm = plainFarm();
    farm.tiles[tileAt(2, 0)].terrain = "rich";
    farm.tiles[tileAt(0, 2)].terrain = "pond";
    expect(landPrice(farm, 0, tileAt(2, 0))).toBe(LAND.base + LAND.rich);
    expect(buy(farm, 0, tileAt(0, 2))).toMatch(/pond/);
    farm.players[0].coins = 5;
    expect(buy(farm, 0, tileAt(2, 0))).toMatch(/need/);
    expect(farm.tiles[tileAt(2, 0)].owner).toBe(-1);
  });

  it("buys one outpost anywhere at a premium, which then extends your land", () => {
    const farm = rich(plainFarm());
    const far = tileAt(8, 6);
    const cost = landPrice(farm, 0, far);
    expect(outpost(farm, 0, far)).toBeNull();
    expect(farm.tiles[far]).toMatchObject({ owner: 0, value: Math.floor((cost * OUTPOST.percent) / 100) });
    expect(farm.players[0].bought).toBe(1);
    // Land next to the outpost can be bought the normal way.
    expect(buy(farm, 0, tileAt(9, 6))).toBeNull();
    expect(outpost(farm, 0, tileAt(4, 4))).toMatch(/already have/);
    expect(outpost(farm, 1, far)).toMatch(/neutral/);
    farm.tiles[tileAt(4, 4)].terrain = "pond";
    expect(outpost(farm, 1, tileAt(4, 4))).toMatch(/pond/);
  });

  it("clears rock before it can be planted", () => {
    const farm = plainFarm();
    const tile = tileAt(1, 1);
    farm.tiles[tile].terrain = "rock";
    expect(plant(farm, 0, tile, "wheat")).toMatch(/rock/);
    expect(clearRock(farm, 0, tile)).toBeNull();
    expect(farm.players[0].coins).toBe(START_COINS - LAND.clear);
    expect(plant(farm, 0, tile, "wheat")).toBeNull();
  });
});

describe("buyouts", () => {
  /** Side 1 owns (2,0), which borders side 0's start. */
  function contested() {
    const farm = rich(plainFarm());
    own(farm, 1, tileAt(2, 0), 30);
    return farm;
  }

  it("takes an enemy tile for twice its value and refunds the old owner, crop included", () => {
    const farm = contested();
    const tile = tileAt(2, 0);
    expect(plant(farm, 1, tile, "pumpkin")).toBeNull();
    const before = farm.players.map((p) => p.coins);
    expect(buyoutPrice(farm, tile)).toBe(60);
    expect(buy(farm, 0, tile)).toBeNull();
    // The tile is now worth what the buyer paid, so buying it back costs twice that.
    expect(farm.tiles[tile]).toMatchObject({ owner: 0, value: 60, crop: "pumpkin" });
    expect(buyoutPrice(farm, tile)).toBe(120);
    expect(farm.players[0].coins).toBe(before[0] - 60);
    expect(farm.players[1].coins).toBe(before[1] + 30);
    expect(farm.events.at(-1)).toMatchObject({ type: "buyout", side: 0, tile });
  });

  it("protects the tile afterwards and has a cooldown", () => {
    const farm = contested();
    const tile = tileAt(2, 0);
    expect(buy(farm, 0, tile)).toBeNull();
    // Side 1 still borders it through (3,0).
    own(farm, 1, tileAt(3, 0));
    expect(buy(farm, 1, tile)).toMatch(/just bought out/);
    run(farm, BUYOUT.protectTicks);
    expect(buy(farm, 1, tile)).toBeNull();
    own(farm, 1, tileAt(0, 2));
    expect(buy(farm, 1, tileAt(0, 2))).toMatch(/already own/);
    own(farm, 0, tileAt(4, 0));
    own(farm, 1, tileAt(5, 0));
    expect(buy(farm, 1, tileAt(4, 0))).toMatch(/cooldown/);
  });

  it("can't take starting land or land with a building", () => {
    const farm = contested();
    own(farm, 1, tileAt(2, 1));
    expect(buy(farm, 1, tileAt(1, 1))).toMatch(/Starting land/);
    expect(build(farm, 1, tileAt(2, 0), "well")).toBeNull();
    expect(buy(farm, 0, tileAt(2, 0))).toMatch(/building/);
  });

  it("takes a goat pen along with its land", () => {
    const farm = contested();
    own(farm, 1, tileAt(3, 0));
    expect(build(farm, 1, tileAt(2, 0), "goats")).toBeNull();
    expect(buy(farm, 0, tileAt(2, 0))).toBeNull();
    expect(farm.tiles[tileAt(2, 0)]).toMatchObject({ owner: 0, building: "goats" });
  });
});

describe("crops", () => {
  it("grows on wet grass in exactly its grow time, and twice as long on dry land", () => {
    const farm = plainFarm();
    const wet = tileAt(1, 1);
    const dry = tileAt(0, 0);
    farm.tiles[tileAt(2, 1)].terrain = "pond";
    farm.tiles[tileAt(3, 1)].terrain = "grass";
    expect(isWet(farm, wet)).toBe(true);
    expect(isWet(farm, dry)).toBe(false);
    farm.players[0].coins = 100;
    plant(farm, 0, wet, "wheat");
    plant(farm, 0, dry, "wheat");
    expect(farm.players[0].coins).toBe(100 - 2 * CROPS.wheat.seed);
    run(farm, CROPS.wheat.growTicks - 1);
    expect(isRipe(farm.tiles[wet])).toBe(false);
    step(farm);
    expect(isRipe(farm.tiles[wet])).toBe(true);
    expect(isRipe(farm.tiles[dry])).toBe(false);
    run(farm, CROPS.wheat.growTicks);
    expect(isRipe(farm.tiles[dry])).toBe(true);
  });

  it("grows faster on rich soil", () => {
    const farm = plainFarm();
    const tile = tileAt(1, 1);
    farm.tiles[tile].terrain = "rich";
    farm.tiles[tileAt(2, 1)].terrain = "pond";
    farm.tiles[tileAt(3, 1)].terrain = "grass";
    plant(farm, 0, tile, "wheat");
    run(farm, Math.ceil((CROPS.wheat.growTicks * 2) / 3));
    expect(isRipe(farm.tiles[tile])).toBe(true);
  });

  it("a well waters its neighbours", () => {
    const farm = rich(plainFarm());
    farm.tiles[tileAt(3, 1)].terrain = "grass";
    expect(isWet(farm, tileAt(0, 0))).toBe(false);
    expect(build(farm, 0, tileAt(1, 1), "well")).toBeNull();
    expect(isWet(farm, tileAt(0, 0))).toBe(true);
    expect(plant(farm, 0, tileAt(1, 1), "wheat")).toMatch(/in use/);
  });

  it("harvests into the barn up to its capacity, and berries grow back", () => {
    const farm = rich(plainFarm());
    const tile = tileAt(0, 0);
    expect(harvest(farm, 0, tile)).toMatch(/Nothing ripe/);
    plant(farm, 0, tile, "berries");
    run(farm, CROPS.berries.growTicks * 2);
    expect(harvest(farm, 0, tile)).toBeNull();
    expect(farm.players[0].barn.berries).toBe(1);
    expect(farm.tiles[tile].crop).toBe("berries");
    expect(isRipe(farm.tiles[tile])).toBe(false);
    run(farm, CROPS.berries.regrowTicks! * 2);
    expect(isRipe(farm.tiles[tile])).toBe(true);

    farm.players[0].barn.wheat = BARN_CAPACITY - 1;
    expect(harvest(farm, 0, tile)).toMatch(/barn is full/);
    expect(capacity(farm, 0)).toBe(BARN_CAPACITY);
    build(farm, 0, tileAt(1, 1), "silo");
    expect(capacity(farm, 0)).toBe(2 * BARN_CAPACITY);
    expect(harvest(farm, 0, tile)).toBeNull();
  });

  it("rejects ids that aren't plain known names", () => {
    const farm = rich(plainFarm());
    const coins = farm.players[0].coins;
    for (const bad of [["wheat"], "constructor", "__proto__", "toString", 3, null]) {
      expect(plant(farm, 0, tileAt(0, 0), bad as never)).toMatch(/Unknown/);
      expect(build(farm, 0, tileAt(0, 0), bad as never)).toMatch(/Unknown/);
      expect(sell(farm, 0, bad as never, 1)).toMatch(/Unknown/);
      expect(sabotage(farm, 0, bad as never)).toMatch(/Unknown/);
      expect(sabotage(farm, 0, "dump", bad as never)).toMatch(/Pick a crop/);
    }
    expect(farm.tiles[tileAt(0, 0)]).toMatchObject({ crop: "", building: "" });
    expect(farm.players[0].coins).toBe(coins);
  });

  it("gives free wheat seed to a broke farmer with nothing growing or stored", () => {
    const farm = plainFarm();
    farm.players[0].coins = BUILDINGS.well.cost;
    expect(build(farm, 0, tileAt(0, 0), "well")).toBeNull();
    expect(farm.players[0].coins).toBe(0);
    expect(plant(farm, 0, tileAt(1, 0), "carrot")).toMatch(/need/);
    expect(plant(farm, 0, tileAt(1, 0), "wheat")).toBeNull();
    // With wheat growing they have to wait for it.
    expect(plant(farm, 0, tileAt(0, 1), "wheat")).toMatch(/need/);
  });

  it("won't build on the last plot that can grow crops", () => {
    const farm = rich(plainFarm());
    expect(build(farm, 0, tileAt(0, 0), "well")).toBeNull();
    expect(build(farm, 0, tileAt(1, 0), "silo")).toBeNull();
    farm.tiles[tileAt(0, 1)].terrain = "rock";
    expect(build(farm, 0, tileAt(1, 1), "scarecrow")).toMatch(/at least one plot/);
    expect(plant(farm, 0, tileAt(1, 1), "wheat")).toBeNull();
  });

  it("only works the owner's land", () => {
    const farm = rich(plainFarm());
    expect(plant(farm, 1, tileAt(0, 0), "wheat")).toMatch(/not your land/);
    expect(plant(farm, 0, tileAt(0, 0), "nope" as never)).toMatch(/Unknown/);
    expect(build(farm, 0, tileAt(0, 0), "castle" as never)).toMatch(/Unknown/);
  });
});

describe("market", () => {
  it("each unit sold lowers the price for both players, and it recovers over time", () => {
    const farm = plainFarm();
    farm.players[0].barn.wheat = 5;
    expect(price(farm, "wheat")).toBe(CROPS.wheat.price);
    expect(sell(farm, 0, "wheat", 5)).toBeNull();
    let expected = 0;
    for (let i = 0; i < 5; i++) expected += Math.floor((CROPS.wheat.price * (MARKET.full - i * MARKET.dropPerUnit)) / MARKET.full);
    expect(farm.players[0].coins).toBe(START_COINS + expected);
    expect(farm.market.wheat).toBe(MARKET.full - 5 * MARKET.dropPerUnit);
    expect(price(farm, "wheat")).toBeLessThan(CROPS.wheat.price);
    // Side 1 gets the lower price too.
    farm.players[1].barn.wheat = 1;
    const low = price(farm, "wheat");
    sell(farm, 1, "wheat", 1);
    expect(farm.players[1].coins).toBe(START_COINS + low);
    expect(price(farm, "carrot")).toBe(CROPS.carrot.price);
    run(farm, (6 * MARKET.dropPerUnit) / MARKET.recoverPerTick);
    expect(farm.market.wheat).toBe(MARKET.full);
  });

  it("never drops below the floor and refuses empty sales", () => {
    const farm = plainFarm();
    farm.players[0].barn.wheat = 50;
    sell(farm, 0, "wheat", 50);
    expect(farm.market.wheat).toBe(MARKET.floor);
    expect(sell(farm, 0, "wheat", 1)).toMatch(/none/);
    farm.players[0].barn.carrot = 2;
    expect(sell(farm, 0, "carrot", 10)).toBeNull();
    expect(farm.players[0].barn.carrot).toBe(0);
  });
});

describe("contracts", () => {
  it("starts with three orders and the first player to deliver gets the reward", () => {
    const farm = plainFarm();
    expect(farm.contracts).toHaveLength(CONTRACTS.slots);
    const contract = farm.contracts[0];
    expect(fill(farm, 0, contract.id)).toMatch(/goods/);
    for (const player of farm.players) for (const item of contract.items) player.barn[item.crop] += item.count;
    expect(fill(farm, 1, contract.id)).toBeNull();
    expect(farm.players[1].coins).toBe(START_COINS + contract.reward);
    expect(farm.players[1].barn).toEqual({ wheat: 0, carrot: 0, pumpkin: 0, berries: 0 });
    expect(fill(farm, 0, contract.id)).toMatch(/gone/);
    const worth = contract.items.reduce((sum, item) => sum + CROPS[item.crop].price * item.count, 0);
    expect(contract.reward).toBeGreaterThan(worth);
  });

  it("the first order is a quick one for 2 wheat", () => {
    expect(plainFarm(5).contracts[0].items).toEqual([{ crop: "wheat", count: 2 }]);
  });

  it("orders expire and new ones come in", () => {
    const farm = plainFarm();
    const first = farm.contracts[0];
    run(farm, first.expiresAt);
    expect(farm.contracts.some((c) => c.id === first.id)).toBe(false);
    run(farm, CONTRACTS.refillTicks * 2);
    expect(farm.contracts.length).toBeGreaterThan(0);
    expect(Math.max(...farm.contracts.map((c) => c.id))).toBeGreaterThan(CONTRACTS.slots);
  });
});

describe("sabotage", () => {
  it("crows eat ripe enemy crops first, cost coins and go on cooldown", () => {
    const farm = rich(plainFarm());
    const tiles = [tileAt(0, 0), tileAt(1, 0), tileAt(0, 1), tileAt(1, 1)];
    for (const tile of tiles) plant(farm, 0, tile, "wheat");
    run(farm, CROPS.wheat.growTicks * 2);
    for (const tile of tiles.slice(0, 2)) harvest(farm, 0, tile);
    for (const tile of tiles.slice(0, 2)) plant(farm, 0, tile, "carrot");
    const coins = farm.players[1].coins;
    expect(sabotage(farm, 1, "crows")).toBeNull();
    expect(farm.players[1].coins).toBe(coins - SABOTAGE.crows.cost);
    // Both ripe wheat tiles are eaten, plus one growing carrot.
    expect(tiles.filter((t) => farm.tiles[t].crop === "")).toHaveLength(CROWS.count);
    expect(tiles.slice(2).every((t) => farm.tiles[t].crop === "")).toBe(true);
    expect(sabotage(farm, 1, "crows")).toMatch(/cooldown/);
  });

  it("a scarecrow keeps the crows away", () => {
    const farm = rich(plainFarm());
    plant(farm, 0, tileAt(0, 0), "wheat");
    build(farm, 0, tileAt(1, 1), "scarecrow");
    expect(sabotage(farm, 1, "crows")).toMatch(/No enemy crops/);
    expect(farm.players[1].coins).toBe(100_000);
  });

  it("weeds halve enemy growth until they wear off or are pulled", () => {
    const farm = rich(plainFarm());
    for (const tile of [tileAt(0, 0), tileAt(1, 0)]) plant(farm, 0, tile, "wheat");
    expect(sabotage(farm, 1, "weeds", tileAt(5, 5))).toMatch(/enemy land/);
    expect(sabotage(farm, 1, "weeds", tileAt(0, 0))).toBeNull();
    expect(farm.tiles[tileAt(1, 1)].weedsUntil).toBe(farm.tick + WEEDS_TICKS);
    expect(weed(farm, 0, tileAt(1, 0))).toBeNull();
    expect(weed(farm, 0, tileAt(1, 0))).toMatch(/no weeds/);
    run(farm, 10);
    expect(farm.tiles[tileAt(1, 0)].growth).toBe(2 * farm.tiles[tileAt(0, 0)].growth);
    run(farm, WEEDS_TICKS);
    expect(farm.tiles[tileAt(0, 0)].weedsUntil).toBeLessThan(farm.tick);
  });

  it("a market dump crashes a price and freezes it", () => {
    const farm = rich(plainFarm());
    expect(sabotage(farm, 0, "dump", "pumpkin")).toMatch(/need 3/);
    farm.players[0].barn.pumpkin = DUMP.units;
    expect(sabotage(farm, 0, "dump", "pumpkin")).toBeNull();
    expect(farm.players[0].barn.pumpkin).toBe(0);
    expect(farm.market.pumpkin).toBe(MARKET.floor);
    run(farm, DUMP.freezeTicks - 1);
    expect(farm.market.pumpkin).toBe(MARKET.floor);
    run(farm, 2);
    expect(farm.market.pumpkin).toBeGreaterThan(MARKET.floor);
  });
});

describe("land tax", () => {
  it("charges tiles² / divisor every period, never below zero coins", () => {
    const farm = plainFarm();
    for (let x = 2; x < 10; x++) own(farm, 0, tileAt(x, 0));
    // 12 tiles against side 1's 4.
    farm.players[0].coins = 1000;
    run(farm, TAX.everyTicks - 1);
    expect(farm.players[0].coins).toBe(1000);
    step(farm);
    expect(landTax(12)).toBe(Math.floor(144 / TAX.divisor));
    expect(farm.players[0].coins).toBe(1000 - landTax(12));
    expect(farm.players[1].coins).toBe(START_COINS - landTax(4));
    farm.players[0].coins = 2;
    run(farm, TAX.everyTicks);
    expect(farm.players[0].coins).toBe(0);
  });
});

describe("goat pens", () => {
  it("eat the nearest ripe enemy crop in range every period, unless fences keep them out", () => {
    const farm = rich(plainFarm());
    own(farm, 1, tileAt(4, 0));
    own(farm, 1, tileAt(9, 0));
    expect(build(farm, 1, tileAt(4, 0), "goats")).toBeNull();
    plant(farm, 0, tileAt(0, 0), "wheat");
    plant(farm, 0, tileAt(1, 0), "pumpkin");
    // Wheat at (0,0) is 4 away, out of range; the pumpkin at (1,0) is 3 away.
    run(farm, GOATS.everyTicks - (farm.tick % GOATS.everyTicks));
    expect(farm.tiles[tileAt(1, 0)].crop).toBe("");
    expect(farm.tiles[tileAt(0, 0)].crop).toBe("wheat");
    expect(farm.events.find((e) => e.type === "goat")).toMatchObject({ side: 1, from: tileAt(4, 0), tile: tileAt(1, 0) });

    // A ripe crop further away goes before a growing one next to the pen.
    own(farm, 0, tileAt(5, 0));
    own(farm, 0, tileAt(7, 0));
    plant(farm, 0, tileAt(7, 0), "wheat");
    farm.tiles[tileAt(7, 0)].growth = CROPS.wheat.growTicks * GROWTH_FULL;
    plant(farm, 0, tileAt(5, 0), "pumpkin");
    run(farm, GOATS.everyTicks - (farm.tick % GOATS.everyTicks));
    expect(farm.tiles[tileAt(7, 0)].crop).toBe("");
    expect(farm.tiles[tileAt(5, 0)].crop).toBe("pumpkin");

    for (const id of ["survey", "fences"] as const) research(farm, 0, id);
    run(farm, GOATS.everyTicks);
    expect(farm.tiles[tileAt(5, 0)].crop).toBe("pumpkin");
  });
});

describe("comebacks", () => {
  /** Side 1 is far behind side 0. */
  function lopsided() {
    const farm = plainFarm();
    farm.players[0].coins = 1000;
    farm.players[1].coins = 200;
    return farm;
  }

  it("a farmer below the threshold is behind and pays less for sabotage", () => {
    const farm = lopsided();
    expect(isBehind(farm, 1)).toBe(true);
    expect(isBehind(farm, 0)).toBe(false);
    // Early on a big percentage gap is only a few coins, which doesn't count.
    expect(isBehindWorth(100, 200)).toBe(false);
    expect(isBehindWorth(300, 500)).toBe(true);
    plant(farm, 0, tileAt(0, 0), "wheat");
    expect(sabotage(farm, 1, "crows")).toBeNull();
    expect(farm.players[1].coins).toBe(200 - Math.floor((SABOTAGE.crows.cost * (100 - BEHIND.discount)) / 100));
    // The leader pays full price.
    plant(farm, 1, mirror(tileAt(0, 0)), "wheat");
    const coins = farm.players[0].coins;
    expect(sabotage(farm, 0, "crows")).toBeNull();
    expect(farm.players[0].coins).toBe(coins - SABOTAGE.crows.cost);
  });

  it("rustlers steal the priciest stored crops, only for a farmer who is behind", () => {
    const farm = lopsided();
    farm.players[0].barn.wheat = 4;
    farm.players[0].barn.pumpkin = 3;
    expect(sabotage(farm, 0, "rustlers")).toMatch(/behind/);
    expect(sabotage(farm, 1, "rustlers")).toBeNull();
    expect(farm.players[1].barn).toMatchObject({ pumpkin: 3, wheat: RUSTLERS.count - 3 });
    expect(farm.players[0].barn).toMatchObject({ pumpkin: 0, wheat: 4 - (RUSTLERS.count - 3) });
    expect(farm.events.at(-1)).toMatchObject({ type: "rustlers", side: 1 });
    expect(sabotage(farm, 1, "rustlers")).toMatch(/cooldown/);
  });

  it("rustlers need something to steal and room to keep it", () => {
    const farm = lopsided();
    expect(sabotage(farm, 1, "rustlers")).toMatch(/empty/);
    farm.players[0].barn.wheat = 5;
    farm.players[1].barn.carrot = capacity(farm, 1) - 2;
    // The carrots keep side 1 behind but leave room for only 2.
    farm.players[1].coins = 0;
    expect(sabotage(farm, 1, "rustlers")).toMatch(/need/);
    farm.players[1].coins = 30;
    expect(sabotage(farm, 1, "rustlers")).toBeNull();
    expect(farm.players[1].barn.wheat).toBe(2);
  });

  it("a land claim takes any enemy tile at a discount, only when behind", () => {
    const farm = lopsided();
    const far = tileAt(8, 6);
    own(farm, 0, far, 40);
    expect(claim(farm, 0, mirror(far))).toMatch(/behind/);
    expect(claim(farm, 1, tileAt(0, 0))).toMatch(/Starting land/);
    expect(claim(farm, 1, tileAt(3, 3))).toMatch(/their land/);
    expect(claim(farm, 1, far)).toBeNull();
    const cost = Math.floor((40 * BUYOUT.factor * CLAIM.percent) / 100);
    expect(farm.tiles[far]).toMatchObject({ owner: 1, value: cost });
    expect(farm.players[1].coins).toBe(200 - cost);
    expect(farm.players[0].coins).toBe(1040);
    own(farm, 0, tileAt(9, 6), 40);
    expect(claim(farm, 1, tileAt(9, 6))).toMatch(/cooldown/);
    run(farm, CLAIM.cooldownTicks);
    expect(claim(farm, 1, tileAt(9, 6))).toBeNull();
  });
});

describe("tech tree", () => {
  /** Researches a tech and everything above it in its branch. */
  const learn = (farm: Farm, side: 0 | 1, id: keyof typeof TECH) => {
    const requires = TECH[id].requires;
    if (requires) learn(farm, side, requires);
    expect(research(farm, side, id)).toBeNull();
  };

  it("costs coins, needs the step above it and can't be repeated", () => {
    const farm = plainFarm();
    expect(research(farm, 0, "irrigation")).toMatch(/Fertilizer first/);
    expect(research(farm, 0, "nope" as any)).toMatch(/Unknown/);
    farm.players[0].coins = TECH.fertilizer.cost - 1;
    expect(research(farm, 0, "fertilizer")).toMatch(/need/);
    farm.players[0].coins = TECH.fertilizer.cost;
    expect(research(farm, 0, "fertilizer")).toBeNull();
    expect(farm.players[0].coins).toBe(0);
    expect(farm.players[0].tech.fertilizer).toBe(true);
    expect(farm.players[1].tech.fertilizer).toBe(false);
    expect(research(farm, 0, "fertilizer")).toMatch(/already/);
    expect(farm.events.at(-1)).toEqual({ type: "research", side: 0, tech: "fertilizer" });
  });

  it("counts toward net worth at half its cost", () => {
    const farm = plainFarm();
    farm.players[0].coins = TECH.haggling.cost;
    const before = netWorth(farm, 0);
    research(farm, 0, "haggling");
    expect(netWorth(farm, 0)).toBe(before - TECH.haggling.cost / 2);
  });

  it("fertilizer grows crops 25% faster", () => {
    const farm = rich(plainFarm());
    for (const pond of [tileAt(2, 1), mirror(tileAt(2, 1))]) farm.tiles[pond].terrain = "pond";
    learn(farm, 0, "fertilizer");
    plant(farm, 0, tileAt(1, 1), "wheat");
    plant(farm, 1, mirror(tileAt(1, 1)), "wheat");
    run(farm, (CROPS.wheat.growTicks * 4) / 5);
    expect(isRipe(farm.tiles[tileAt(1, 1)])).toBe(true);
    expect(isRipe(farm.tiles[mirror(tileAt(1, 1))])).toBe(false);
  });

  it("irrigation makes your wells water 2 tiles out", () => {
    const farm = rich(plainFarm());
    for (const x of [2, 3]) own(farm, 0, tileAt(x, 0));
    build(farm, 0, tileAt(0, 0), "well");
    expect(isWet(farm, tileAt(2, 0))).toBe(false);
    learn(farm, 0, "irrigation");
    expect(isWet(farm, tileAt(2, 0))).toBe(true);
    expect(isWet(farm, tileAt(3, 0))).toBe(false);
  });

  it("hybrid seeds give 2 crops per harvest on rich soil while the barn has room", () => {
    const farm = rich(plainFarm());
    learn(farm, 0, "hybrid");
    const tiles = [tileAt(0, 0), tileAt(1, 0), tileAt(0, 1)];
    for (const tile of tiles.slice(0, 2)) farm.tiles[tile].terrain = "rich";
    for (const tile of tiles) plant(farm, 0, tile, "wheat");
    run(farm, CROPS.wheat.growTicks * 2);
    harvest(farm, 0, tiles[2]);
    expect(farm.players[0].barn.wheat).toBe(1);
    harvest(farm, 0, tiles[0]);
    expect(farm.players[0].barn.wheat).toBe(3);
    farm.players[0].barn.carrot = BARN_CAPACITY - 4;
    harvest(farm, 0, tiles[1]);
    expect(farm.players[0].barn.wheat).toBe(4);
  });

  it("haggling sells for 10% more and wholesale lowers the price half as much", () => {
    const farm = plainFarm();
    for (const side of [0, 1] as const) farm.players[side].barn.pumpkin = 1;
    learn(rich(farm), 0, "wholesale");
    sell(farm, 0, "pumpkin", 1);
    expect(farm.market.pumpkin).toBe(MARKET.full - MARKET.dropPerUnit / 2);
    farm.market.pumpkin = MARKET.full;
    const coins = farm.players[0].coins;
    farm.players[0].barn.pumpkin = 1;
    sell(farm, 0, "pumpkin", 1);
    expect(farm.players[0].coins - coins).toBe(Math.floor((CROPS.pumpkin.price * 110) / 100));
  });

  it("the guild pays 25% more for orders", () => {
    const farm = rich(plainFarm());
    learn(farm, 0, "guild");
    const order = farm.contracts[0];
    farm.players[0].barn.wheat = 2;
    const coins = farm.players[0].coins;
    fill(farm, 0, order.id);
    expect(farm.players[0].coins - coins).toBe(Math.floor((order.reward * 125) / 100));
  });

  it("surveying makes land rise in price more slowly", () => {
    const farm = rich(plainFarm());
    farm.players[0].bought = 10;
    const tile = tileAt(2, 0);
    expect(landPrice(farm, 0, tile)).toBe(LAND.base + 10 * LAND.step);
    learn(farm, 0, "survey");
    expect(landPrice(farm, 0, tile)).toBe(LAND.base + 10 * LAND.surveyStep);
  });

  it("fences make your land three times as dear to buy out", () => {
    const farm = rich(plainFarm());
    own(farm, 0, tileAt(2, 0), 30);
    expect(buyoutPrice(farm, tileAt(2, 0))).toBe(60);
    learn(farm, 0, "fences");
    expect(buyoutPrice(farm, tileAt(2, 0))).toBe(90);
  });

  it("farm dogs let crows take only 1 crop and weeds wear off twice as fast", () => {
    const farm = rich(plainFarm());
    learn(farm, 0, "dogs");
    const tiles = [tileAt(0, 0), tileAt(1, 0), tileAt(0, 1), tileAt(1, 1)];
    for (const tile of tiles) plant(farm, 0, tile, "wheat");
    sabotage(farm, 1, "crows");
    expect(tiles.filter((t) => farm.tiles[t].crop === "")).toHaveLength(1);
    sabotage(farm, 1, "weeds", tileAt(0, 0));
    expect(farm.tiles[tileAt(0, 0)].weedsUntil).toBe(farm.tick + WEEDS_TICKS / 2);
  });
});

describe("net worth and the end of the match", () => {
  it("counts a growing crop at market price in proportion to its growth", () => {
    const farm = plainFarm();
    farm.tiles[tileAt(2, 1)].terrain = "pond";
    farm.players[0].coins = CROPS.pumpkin.seed;
    const base = netWorth(farm, 0) - CROPS.pumpkin.seed;
    plant(farm, 0, tileAt(1, 1), "pumpkin");
    expect(netWorth(farm, 0)).toBe(base);
    run(farm, CROPS.pumpkin.growTicks / 2);
    expect(netWorth(farm, 0)).toBe(base + Math.floor(CROPS.pumpkin.price / 2));
    run(farm, CROPS.pumpkin.growTicks);
    expect(netWorth(farm, 0)).toBe(base + CROPS.pumpkin.price);
  });

  it("counts coins, land, half the buildings and crops", () => {
    const farm = plainFarm();
    const base = netWorth(farm, 0);
    expect(base).toBe(START_COINS + 4 * LAND.base);
    farm.players[0].coins += BUILDINGS.well.cost;
    build(farm, 0, tileAt(0, 0), "well");
    expect(netWorth(farm, 0)).toBe(base + BUILDINGS.well.cost / 2);
    farm.players[0].barn.wheat = 2;
    expect(netWorth(farm, 0)).toBe(base + BUILDINGS.well.cost / 2 + 2 * price(farm, "wheat"));
  });

  it("the richer farmer wins when time runs out", () => {
    const farm = plainFarm();
    farm.players[1].coins += 1;
    run(farm, MATCH_TICKS);
    expect(farm.winner).toBe(1);
    expect(buy(farm, 0, tileAt(2, 0))).toMatch(/over/);
    step(farm);
    expect(farm.tick).toBe(MATCH_TICKS);
  });

  it("equal net worth is a draw, and leaving forfeits", () => {
    const farm = plainFarm();
    run(farm, MATCH_TICKS);
    expect(farm.winner).toBe(DRAW);
    const other = plainFarm();
    forfeit(other, 0);
    expect(other.winner).toBe(1);
  });
});

describe("determinism", () => {
  /** Plays a scripted match with both players acting through the sim. */
  function play(seed: number) {
    const farm = createFarm({ seed });
    const order = [tileAt(2, 0), tileAt(0, 2), tileAt(2, 1), tileAt(1, 2), tileAt(3, 0)];
    for (let t = 0; t < 3 * 60 * TICK_RATE; t++) {
      for (const side of [0, 1] as const) {
        const p = farm.players[side];
        const mine = (tile: number) => (side === 0 ? tile : mirror(tile));
        for (let i = 0; i < TILE_COUNT; i++) {
          if (farm.tiles[i].owner !== side) continue;
          if (isRipe(farm.tiles[i])) harvest(farm, side, i);
          else if (!farm.tiles[i].crop && !farm.tiles[i].building) plant(farm, side, i, t % 2 ? "carrot" : "wheat");
        }
        if (p.barn.wheat + p.barn.carrot > 4) {
          sell(farm, side, "wheat", 10);
          sell(farm, side, "carrot", 10);
        }
        if (t % 300 === 0) for (const tile of order) buy(farm, side, mine(tile));
        if (t % 500 === 250) sabotage(farm, side, "crows");
        if (t === 50) outpost(farm, side, mine(tileAt(7, 5)));
        if (t === 900) build(farm, side, mine(tileAt(7, 5)), "goats");
        if (t % 450 === 0) sabotage(farm, side, "rustlers");
        if (farm.contracts[0]) fill(farm, side, farm.contracts[0].id);
      }
      step(farm);
    }
    return farm;
  }

  it("the same seed and actions give the identical state", () => {
    const a = play(42);
    const b = play(42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.players[0].coins).not.toBe(START_COINS);
  });
});

import { describe, expect, it } from "vitest";
import { CARDS, STARTER_DECK, deckError, unitCard } from "../src/shared/cards";
import {
  type Battle,
  BASE_HP,
  COLS,
  DRAW,
  FIELD_WIDTH,
  HAND_SIZE,
  INVEST_COST,
  MATCH_TICKS,
  MAX_LEVEL,
  RESEARCH,
  START_GOLD,
  SHRINE,
  START_INCOME,
  TICK_RATE,
  TOWER,
  TURRET,
  WAVE_TICKS,
  createBattle,
  invest,
  play,
  research,
  rowCenter,
  scaled,
  sell,
  spawnUnit,
  step,
} from "../src/shared/sim";

const run = (battle: Battle, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(battle);
};

/** Battle without the towers in front of the bases, for tests about units reaching or nearing a base. */
const noTowers = (options?: Parameters<typeof createBattle>[0]) => {
  const battle = createBattle(options);
  for (const player of battle.players) player.towers = [];
  return battle;
};

/** Puts a card into hand slot 0 of a side so tests don't depend on the shuffle or tiers. */
const give = (battle: Battle, side: 0 | 1, card: string) => {
  battle.players[side].hand[0] = card;
  battle.players[side].gold = 1000;
  battle.players[side].tier = 3;
};

describe("hand and deck", () => {
  it("deals a hand from a shuffled deck", () => {
    const battle = createBattle();
    for (const player of battle.players) {
      expect(player.hand).toHaveLength(HAND_SIZE);
      expect(player.deck).toHaveLength(STARTER_DECK.length - HAND_SIZE);
      expect([...player.hand, ...player.deck].sort()).toEqual([...STARTER_DECK].sort());
    }
  });

  it("different seeds deal different hands", () => {
    const hands = new Set(Array.from({ length: 5 }, (_, i) => createBattle({ seed: i + 1 }).players[0].hand.join()));
    expect(hands.size).toBeGreaterThan(1);
  });

  it("playing a card draws the next one and reshuffles the discard when the deck runs out", () => {
    const battle = createBattle();
    const player = battle.players[0];
    player.gold = 100_000;
    player.tier = 3;
    for (let i = 0; i < 25; i++) {
      battle.tick += 1000; // keep spells off cooldown
      player.grid.fill(""); // keep the pad free
      player.levels.fill(0);
      expect(play(battle, 0, 0, 0)).toBeNull();
      expect(player.hand.every(Boolean)).toBe(true);
      expect(player.hand.length + player.deck.length + player.discard.length).toBe(STARTER_DECK.length);
    }
  });

  it("deals from a custom deck with duplicate copies", () => {
    const deck = ["knight", "knight", "knight", "sniper", "sniper", "golem", "catapult", "frost", "frost", "mend"];
    const battle = createBattle({ decks: [deck, STARTER_DECK] });
    const player = battle.players[0];
    expect([...player.hand, ...player.deck].sort()).toEqual([...deck].sort());
  });
});

describe("deck rules", () => {
  it("accepts the starter deck and decks with copies", () => {
    expect(deckError(STARTER_DECK)).toBeNull();
    expect(deckError(["knight", "knight", "knight", "golem", "golem", "golem", "frost", "frost", "frost", "mend"])).toBeNull();
  });

  it("rejects bad decks", () => {
    expect(deckError(STARTER_DECK.slice(1))).toMatch(/exactly/);
    expect(deckError([...STARTER_DECK, "knight"])).toMatch(/exactly/);
    expect(deckError("footman")).toMatch(/exactly/);
    expect(deckError([...STARTER_DECK.slice(1), "nope"])).toMatch(/Unknown/);
    expect(deckError([...STARTER_DECK.slice(1), "toString"])).toMatch(/Unknown/);
    expect(deckError(["footman", "footman", "footman", "footman", ...STARTER_DECK.slice(4)])).toMatch(/copies/);
    expect(deckError(["rally", "rally", "rally", "lightning", "lightning", "lightning", "mend", "mend", "frost", "frost"])).toMatch(/unit/);
  });
});

describe("economy", () => {
  it("pays income every second", () => {
    const battle = createBattle();
    run(battle, TICK_RATE * 3);
    expect(battle.players[0].gold).toBe(START_GOLD + START_INCOME * 3);
  });

  it("charges for cards and refuses when gold is short", () => {
    const battle = createBattle();
    battle.players[0].hand[0] = "golem";
    battle.players[0].tier = 3;
    battle.players[0].gold = CARDS.golem.cost - 1;
    expect(play(battle, 0, 0, 0)).toBe("Not enough gold");
    expect(battle.players[0].grid[0]).toBe("");
    battle.players[0].gold = CARDS.golem.cost;
    expect(play(battle, 0, 0, 0)).toBeNull();
    expect(battle.players[0].gold).toBe(0);
  });

  it("investing raises income and the next investment's price", () => {
    const battle = createBattle();
    battle.players[0].gold = INVEST_COST;
    expect(invest(battle, 0)).toBeNull();
    expect(battle.players[0].income).toBe(START_INCOME + 1);
    expect(battle.players[0].gold).toBe(0);
    expect(invest(battle, 0)).toBe("Not enough gold");
  });

  it("killing a unit pays its bounty to the other side", () => {
    const battle = createBattle();
    const victim = spawnUnit(battle, 1, "runner", 0);
    victim.hp = 0;
    const gold = battle.players[0].gold;
    step(battle);
    expect(battle.players[0].gold).toBe(gold + unitCard("runner").bounty);
  });
});

describe("tiers", () => {
  it("every card has a tier and the starter deck is mostly tier 1", () => {
    for (const card of Object.values(CARDS)) expect([1, 2, 3]).toContain(card.tier);
    expect(STARTER_DECK.filter((id) => CARDS[id].tier === 1).length).toBeGreaterThanOrEqual(8);
  });

  it("cards above your tier can't be played", () => {
    const battle = createBattle();
    const player = battle.players[0];
    player.hand[0] = "knight";
    player.gold = 1000;
    expect(play(battle, 0, 0, 0)).toBe("Knight needs tier 2");
    expect(player.gold).toBe(1000);
    player.tier = 2;
    expect(play(battle, 0, 0, 0)).toBeNull();
  });

  it("research costs gold, takes time and tier 3 costs more than tier 2", () => {
    expect(RESEARCH[3].cost).toBeGreaterThan(RESEARCH[2].cost);
    expect(RESEARCH[3].ticks).toBeGreaterThan(RESEARCH[2].ticks);
    const battle = createBattle();
    const player = battle.players[0];
    player.gold = RESEARCH[2].cost - 1;
    expect(research(battle, 0)).toBe("Not enough gold");
    player.gold = 10000;
    expect(research(battle, 0)).toBeNull();
    expect(player.gold).toBe(10000 - RESEARCH[2].cost);
    expect(research(battle, 0)).toBe("Already researching");
    run(battle, RESEARCH[2].ticks - 1);
    expect(player.tier).toBe(1);
    step(battle);
    expect(player.tier).toBe(2);
    const gold = player.gold;
    expect(research(battle, 0)).toBeNull();
    expect(player.gold).toBe(gold - RESEARCH[3].cost);
    run(battle, RESEARCH[3].ticks);
    expect(player.tier).toBe(3);
    expect(research(battle, 0)).toBe("Already at the top tier");
  });
});

describe("placement and waves", () => {
  it("unit cards need a valid cell", () => {
    const battle = createBattle();
    give(battle, 0, "footman");
    expect(play(battle, 0, 0)).toBe("Pick a cell on your grid");
    expect(play(battle, 0, 0, 99)).toBe("Pick a cell on your grid");
  });

  it("placed units spawn every wave in their row, front columns further ahead", () => {
    const battle = createBattle();
    give(battle, 0, "footman");
    play(battle, 0, 0, 1 * COLS + 0); // row 1, back column
    give(battle, 0, "footman");
    play(battle, 0, 0, 1 * COLS + 3); // row 1, front column
    give(battle, 1, "archer");
    play(battle, 1, 0, 2 * COLS + 3);
    run(battle, WAVE_TICKS - 1);
    expect(battle.units).toHaveLength(0);
    step(battle);
    const [back, front, archer] = battle.units;
    expect(back.y).toBe(rowCenter(1));
    expect(front.x).toBeGreaterThan(back.x);
    expect(archer.side).toBe(1);
    expect(archer.x).toBeLessThan(FIELD_WIDTH);
    run(battle, WAVE_TICKS);
    expect(battle.units.filter((u) => u.card === "footman").length).toBeGreaterThanOrEqual(3);
  });

  it("a pad holding another card refuses a new unit", () => {
    const battle = createBattle();
    give(battle, 0, "footman");
    play(battle, 0, 0, 5);
    give(battle, 0, "footman");
    play(battle, 0, 0, 5);
    give(battle, 0, "brute");
    expect(play(battle, 0, 0, 5)).toMatch(/sell it first/);
    expect(battle.players[0].grid[5]).toBe("footman");
    expect(battle.players[0].gold).toBe(1000);
  });

  it("playing the same card on its pad levels it up to the max", () => {
    const battle = createBattle();
    const player = battle.players[0];
    for (let level = 1; level <= MAX_LEVEL; level++) {
      give(battle, 0, "footman");
      expect(play(battle, 0, 0, 5)).toBeNull();
      expect(player.levels[5]).toBe(level);
    }
    give(battle, 0, "footman");
    expect(play(battle, 0, 0, 5)).toMatch(/max level/);
    expect(player.gold).toBe(1000);
  });

  it("selling a pad refunds half of what its levels cost", () => {
    const battle = createBattle();
    const player = battle.players[0];
    give(battle, 0, "archer");
    play(battle, 0, 0, 2);
    give(battle, 0, "archer");
    play(battle, 0, 0, 2);
    const gold = player.gold;
    expect(sell(battle, 0, 2)).toBeNull();
    expect(player.gold).toBe(gold + CARDS.archer.cost);
    expect(player.grid[2]).toBe("");
    expect(player.levels[2]).toBe(0);
    expect(sell(battle, 0, 2)).toMatch(/Nothing/);
    give(battle, 0, "brute");
    expect(play(battle, 0, 0, 2)).toBeNull();
  });

  it("levelled units spawn with more health", () => {
    expect(scaled(25, 1)).toBe(25);
    expect(scaled(25, 2)).toBe(37);
    expect(scaled(25, 3)).toBe(50);
    const battle = createBattle();
    for (let i = 0; i < 3; i++) {
      give(battle, 0, "brute");
      play(battle, 0, 0, 0);
    }
    run(battle, WAVE_TICKS);
    const [brute] = battle.units;
    expect(brute.level).toBe(3);
    expect(brute.maxHp).toBe(unitCard("brute").hp * 2);
  });

  it("swarm spawns three units", () => {
    const battle = createBattle();
    give(battle, 0, "swarm");
    play(battle, 0, 0, 0);
    run(battle, WAVE_TICKS);
    expect(battle.units.filter((u) => u.card === "swarm")).toHaveLength(3);
  });
});

describe("combat", () => {
  it("a unit that reaches the enemy base breaches it for its cost and is spent", () => {
    const battle = noTowers();
    spawnUnit(battle, 0, "brute", 0);
    const gold = battle.players[1].gold;
    run(battle, 60 * TICK_RATE);
    expect(battle.players[1].baseHp).toBe(BASE_HP - CARDS.brute.cost);
    expect(battle.units).toHaveLength(0);
    expect(battle.players[1].gold - gold).toBe(START_INCOME * 60); // no bounty for a breach
  });

  it("bases shoot enemies that come close", () => {
    const battle = noTowers();
    const runner = spawnUnit(battle, 1, "runner", 0);
    runner.x = TURRET.range - 1;
    runner.frozenTicks = 1000;
    step(battle);
    expect(runner.hp).toBe(runner.maxHp - TURRET.damage);
  });

  it("opposing melee units meet in the middle and fight to the death", () => {
    const battle = createBattle();
    const a = spawnUnit(battle, 0, "footman", 1);
    const b = spawnUnit(battle, 1, "footman", 1);
    for (let i = 0; i < 2000 && a.hp > 0 && b.hp > 0; i++) step(battle);
    expect(Math.abs(a.x - FIELD_WIDTH / 2)).toBeLessThan(50);
    expect(Math.min(a.hp, b.hp)).toBeLessThanOrEqual(0);
  });

  it("units leave their row to fight nearby enemies", () => {
    const battle = createBattle();
    const a = spawnUnit(battle, 0, "footman", 0);
    const b = spawnUnit(battle, 1, "footman", 1);
    a.x = 500;
    b.x = 560;
    step(battle);
    expect(a.y).toBeGreaterThan(rowCenter(0));
  });

  it("ranged units shoot from range without closing in", () => {
    const battle = createBattle();
    const archer = spawnUnit(battle, 0, "archer", 0);
    const dummy = spawnUnit(battle, 1, "brute", 0);
    archer.x = 400;
    dummy.x = 520;
    dummy.frozenTicks = 1000;
    run(battle, 10);
    expect(archer.x).toBe(400);
    expect(dummy.hp).toBeLessThan(dummy.maxHp);
  });

  it("splash damages enemies around the target", () => {
    const battle = createBattle();
    const bomber = spawnUnit(battle, 0, "bomber", 0);
    const near = spawnUnit(battle, 1, "brute", 0);
    const close = spawnUnit(battle, 1, "brute", 0);
    const far = spawnUnit(battle, 1, "brute", 2);
    bomber.x = 400;
    near.x = 480;
    close.x = 500;
    far.x = 480;
    for (const u of [near, close, far]) u.frozenTicks = 1000;
    step(battle);
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(close.hp).toBeLessThan(close.maxHp);
    expect(far.hp).toBe(far.maxHp);
  });

  it("healers heal the most hurt ally in range", () => {
    const battle = createBattle();
    const medic = spawnUnit(battle, 0, "medic", 0);
    const scratched = spawnUnit(battle, 0, "brute", 0);
    const wounded = spawnUnit(battle, 0, "brute", 0);
    scratched.hp -= 10;
    wounded.hp -= 100;
    step(battle);
    expect(medic.x).toBe(0);
    expect(wounded.hp).toBe(wounded.maxHp - 100 + 10);
    expect(scratched.hp).toBe(scratched.maxHp - 10);
  });
});

describe("towers", () => {
  it("each base has two towers in the outer lanes", () => {
    const battle = createBattle();
    expect(battle.players[0].towers.map((t) => [t.x, t.y, t.hp])).toEqual(TOWER.rows.map((row) => [TOWER.x, rowCenter(row), TOWER.hp]));
    expect(battle.players[1].towers.map((t) => t.x)).toEqual([FIELD_WIDTH - TOWER.x, FIELD_WIDTH - TOWER.x]);
  });

  it("towers shoot enemies in range", () => {
    const battle = createBattle();
    const tower = battle.players[0].towers[0];
    const runner = spawnUnit(battle, 1, "runner", 0);
    runner.x = tower.x + TOWER.range - 1;
    runner.frozenTicks = 1000;
    step(battle);
    expect(runner.hp).toBe(runner.maxHp - TOWER.damage);
  });

  it("units stop to knock a tower down, which pays a bounty, then walk on to the base", () => {
    const battle = createBattle();
    const golem = spawnUnit(battle, 0, "golem", 0, 0, 0, 1, 3);
    const tower = battle.players[1].towers[0];
    const gold = battle.players[0].gold;
    let fell = -1;
    for (let i = 0; i < 120 * TICK_RATE && battle.players[1].baseHp === BASE_HP; i++) {
      step(battle);
      if (fell === -1 && battle.events.some((e) => e.type === "tower" && e.side === 1 && e.index === 0)) fell = battle.tick;
      battle.events = [];
    }
    expect(fell).toBeGreaterThan(0);
    expect(tower.standing).toBe(false);
    expect(tower.hp).toBe(0);
    expect(battle.players[0].gold - gold).toBeGreaterThanOrEqual(TOWER.bounty);
    // With its tower gone the golem reached the base.
    expect(battle.players[1].baseHp).toBe(BASE_HP - CARDS.golem.cost);
  });

  it("splash hits towers too", () => {
    const battle = createBattle();
    const tower = battle.players[1].towers[0];
    const bomber = spawnUnit(battle, 0, "bomber", 0);
    bomber.x = tower.x - 100;
    run(battle, 1);
    expect(tower.hp).toBe(TOWER.hp - unitCard("bomber").damage);
  });
});

describe("spells", () => {
  it("lightning hits the three frontmost enemies", () => {
    const battle = createBattle();
    const enemies = [900, 300, 600, 200, 1000].map((x) => {
      const u = spawnUnit(battle, 1, "brute", 0);
      u.x = x;
      return u;
    });
    give(battle, 0, "lightning");
    expect(play(battle, 0, 0)).toBeNull();
    expect(enemies.map((u) => u.maxHp - u.hp)).toEqual([0, 60, 60, 60, 0]);
  });

  it("spells go on cooldown", () => {
    const battle = createBattle();
    give(battle, 0, "lightning");
    play(battle, 0, 0);
    give(battle, 0, "lightning");
    expect(play(battle, 0, 0)).toBe("Lightning is on cooldown");
  });

  it("rally speeds up your units", () => {
    const slow = createBattle();
    const fast = createBattle();
    const a = spawnUnit(slow, 0, "footman", 0);
    const b = spawnUnit(fast, 0, "footman", 0);
    give(fast, 0, "rally");
    play(fast, 0, 0);
    run(slow, 20);
    run(fast, 20);
    expect(b.x).toBeCloseTo(a.x * 1.5);
    expect(b.x).toBeGreaterThan(a.x);
  });

  it("a levelled unit breaches for its card cost and pays a bigger bounty", () => {
    const battle = noTowers();
    spawnUnit(battle, 0, "brute", 0, 0, 0, 1, 2).x = FIELD_WIDTH - 1;
    run(battle, 5);
    expect(battle.players[1].baseHp).toBe(BASE_HP - unitCard("brute").cost);

    const fight = createBattle();
    const victim = spawnUnit(fight, 1, "footman", 0, 0, 0, 1, 3);
    victim.hp = 0;
    const gold = fight.players[0].gold;
    step(fight);
    expect(fight.players[0].gold).toBe(gold + scaled(unitCard("footman").bounty, 3));
  });

  it("meteor hits the biggest enemy group and spares a lone unit", () => {
    const battle = createBattle();
    const lone = spawnUnit(battle, 1, "brute", 0);
    lone.x = 900;
    const group = [0, 1, 2].map(() => spawnUnit(battle, 1, "brute", 2));
    group.forEach((u, i) => (u.x = 500 + i * 20));
    give(battle, 0, "meteor");
    expect(play(battle, 0, 0)).toBeNull();
    for (const u of group) expect(u.hp).toBeLessThan(u.maxHp);
    expect(lone.hp).toBe(lone.maxHp);
  });

  it("fury doubles damage for a while", () => {
    const hitFor = (fury: boolean) => {
      const battle = createBattle();
      const attacker = spawnUnit(battle, 0, "footman", 1);
      const target = spawnUnit(battle, 1, "brute", 1);
      attacker.x = 600;
      Object.assign(target, { x: 620, frozenTicks: 1e6 });
      if (fury) {
        give(battle, 0, "fury");
        play(battle, 0, 0);
      }
      step(battle);
      return target.maxHp - target.hp;
    };
    expect(hitFor(false)).toBe(unitCard("footman").damage);
    expect(hitFor(true)).toBe(unitCard("footman").damage * 2);
  });

  it("muster spawns a unit in every lane", () => {
    const battle = createBattle();
    give(battle, 0, "muster");
    expect(play(battle, 0, 0)).toBeNull();
    expect(battle.units.map((u) => [u.side, u.card, u.y])).toEqual([0, 1, 2].map((row) => [0, "footman", rowCenter(row)]));
  });

  it("frost freezes enemies and mend heals allies", () => {
    const battle = createBattle();
    const enemy = spawnUnit(battle, 1, "footman", 0);
    const ally = spawnUnit(battle, 0, "brute", 2);
    ally.hp = 10;
    give(battle, 0, "frost");
    play(battle, 0, 0);
    give(battle, 0, "mend");
    play(battle, 0, 0);
    expect(ally.hp).toBe(110);
    const x = enemy.x;
    run(battle, 20);
    expect(enemy.x).toBe(x);
  });

  it("repair restores base health up to the maximum", () => {
    const battle = createBattle();
    battle.players[0].baseHp = BASE_HP - 200;
    give(battle, 0, "repair");
    play(battle, 0, 0);
    expect(battle.players[0].baseHp).toBe(BASE_HP - 50);
    battle.players[0].ready = {};
    give(battle, 0, "repair");
    play(battle, 0, 0);
    expect(battle.players[0].baseHp).toBe(BASE_HP);
  });

  it("smite hits the enemy with the most health and quake hits every enemy", () => {
    const battle = createBattle();
    const small = spawnUnit(battle, 1, "footman", 0);
    const big = spawnUnit(battle, 1, "golem", 1);
    const ally = spawnUnit(battle, 0, "footman", 2);
    give(battle, 0, "smite");
    play(battle, 0, 0);
    expect(big.hp).toBe(big.maxHp - 200);
    expect(small.hp).toBe(small.maxHp);
    give(battle, 0, "quake");
    play(battle, 0, 0);
    expect(small.hp).toBe(small.maxHp - 30);
    expect(big.hp).toBe(big.maxHp - 230);
    expect(ally.hp).toBe(ally.maxHp);
  });

  it("cataclysm kills every unit without bounty and runs out after three casts", () => {
    const battle = createBattle();
    for (let cast = 0; cast < 3; cast++) {
      spawnUnit(battle, 0, "golem", 0);
      spawnUnit(battle, 1, "knight", 1);
      battle.players[0].ready = {};
      give(battle, 0, "cataclysm");
      expect(play(battle, 0, 0)).toBeNull();
      const gold = battle.players.map((p) => p.gold);
      step(battle);
      expect(battle.units).toEqual([]);
      expect(battle.players.map((p) => p.gold)).toEqual(gold);
    }
    battle.players[0].ready = {};
    give(battle, 0, "cataclysm");
    expect(play(battle, 0, 0)).toMatch(/No Cataclysm casts left/);
  });

  it("a used-up spell leaves the hand and the deck", () => {
    const battle = createBattle({ decks: [["cataclysm", "cataclysm", "cataclysm", "footman", "footman", "footman", "archer", "archer", "archer", "brute"], STARTER_DECK] });
    const player = battle.players[0];
    player.gold = 10000;
    player.tier = 3;
    for (let i = 0; i < 3; i++) {
      player.ready = {};
      while (!player.hand.includes("cataclysm")) {
        sell(battle, 0, 0);
        expect(play(battle, 0, 0, 0)).toBeNull();
      }
      play(battle, 0, player.hand.indexOf("cataclysm"));
    }
    expect(player.used.cataclysm).toBe(3);
    for (let i = 0; i < 30; i++) {
      expect(player.hand).not.toContain("cataclysm");
      sell(battle, 0, 0);
      expect(play(battle, 0, 0, 0)).toBeNull();
    }
  });
});

describe("fliers", () => {
  /** A frozen enemy flier at `x` in the top lane, so it stays put as a target. */
  const flier = (battle: Battle, card: string, x: number) => {
    const unit = spawnUnit(battle, 1, card, 0);
    Object.assign(unit, { x, frozenTicks: 1e6 });
    return unit;
  };

  it("ground-only units ignore fliers and walk on", () => {
    const battle = noTowers();
    const footman = spawnUnit(battle, 0, "footman", 0);
    footman.x = 500;
    const hawk = flier(battle, "hawk", 510);
    run(battle, 40);
    expect(hawk.hp).toBe(hawk.maxHp);
    expect(footman.x).toBeGreaterThan(520);
  });

  it("archers, snipers and spearmen hit fliers", () => {
    for (const card of ["archer", "sniper", "spearman"]) {
      const battle = noTowers();
      spawnUnit(battle, 0, card, 0).x = 500;
      const drake = flier(battle, "drake", 540);
      run(battle, 80);
      expect(drake.hp, card).toBeLessThan(drake.maxHp);
    }
  });

  it("hawks only attack fliers", () => {
    const ground = noTowers();
    const hawk = spawnUnit(ground, 0, "hawk", 0);
    hawk.x = 500;
    const brute = spawnUnit(ground, 1, "brute", 0);
    Object.assign(brute, { x: 520, frozenTicks: 1e6 });
    run(ground, 40);
    expect(brute.hp).toBe(brute.maxHp);
    expect(hawk.x).toBeGreaterThan(540);

    const air = noTowers();
    spawnUnit(air, 0, "hawk", 0).x = 500;
    const balloon = flier(air, "balloon", 540);
    run(air, 40);
    expect(balloon.hp).toBeLessThan(balloon.maxHp);
  });

  it("balloons bomb the ground but not fliers, and drakes hit both", () => {
    const battle = noTowers();
    const balloon = spawnUnit(battle, 0, "balloon", 0);
    balloon.x = 500;
    const hawk = flier(battle, "hawk", 505);
    run(battle, 40);
    expect(hawk.hp).toBe(hawk.maxHp);
    const brute = spawnUnit(battle, 1, "brute", 0);
    Object.assign(brute, { x: balloon.x + 10, frozenTicks: 1e6 });
    run(battle, 80);
    expect(brute.hp).toBeLessThan(brute.maxHp);

    for (const card of ["hawk", "brute"]) {
      const fight = noTowers();
      spawnUnit(fight, 0, "drake", 0).x = 500;
      const target = flier(fight, card, 540);
      run(fight, 60);
      expect(target.hp, card).toBeLessThan(target.maxHp);
    }
  });

  it("towers and base turrets shoot fliers", () => {
    const battle = createBattle();
    const tower = battle.players[0].towers[0];
    const hawk = flier(battle, "hawk", tower.x + TOWER.range - 1);
    step(battle);
    expect(hawk.hp).toBe(hawk.maxHp - TOWER.damage);

    const base = noTowers();
    const balloon = flier(base, "balloon", TURRET.range - 1);
    step(base);
    expect(balloon.hp).toBe(balloon.maxHp - TURRET.damage);
  });

  it("hawks can't knock down towers", () => {
    const battle = createBattle();
    const hawk = spawnUnit(battle, 0, "hawk", 0);
    hawk.hp = hawk.maxHp = 1e6;
    run(battle, 400);
    expect(battle.players[1].towers[0].hp).toBe(TOWER.hp);
  });

  it("fliers pass over ground units without pushing them", () => {
    const battle = createBattle();
    const footman = spawnUnit(battle, 0, "footman", 1);
    const balloon = spawnUnit(battle, 0, "balloon", 1);
    Object.assign(footman, { x: 300, frozenTicks: 1e6 });
    Object.assign(balloon, { x: 300, frozenTicks: 1e6 });
    step(battle);
    expect([footman.x, footman.y, balloon.x, balloon.y]).toEqual([300, rowCenter(1), 300, rowCenter(1)]);
  });
});

describe("shrine", () => {
  /** Parks a frozen unit of a side on the shrine. */
  const hold = (battle: Battle, side: 0 | 1) => {
    const unit = spawnUnit(battle, side, "brute", 1);
    Object.assign(unit, { x: SHRINE.x, y: SHRINE.y, frozenTicks: 1e6 });
    return unit;
  };

  it("is captured by the only side standing in it", () => {
    const battle = createBattle();
    hold(battle, 1);
    run(battle, SHRINE.captureTicks - 1);
    expect(battle.shrine.owner).toBe(-1);
    run(battle, 1);
    expect(battle.shrine.owner).toBe(1);
    expect(battle.events).toContainEqual({ type: "shrine", owner: 1 });
  });

  it("does not move while contested", () => {
    const battle = createBattle();
    hold(battle, 0);
    run(battle, 10);
    hold(battle, 1);
    run(battle, 100);
    expect(battle.shrine).toEqual({ owner: -1, control: 10 });
  });

  it("turns neutral before it changes hands", () => {
    const battle = createBattle();
    const unit = hold(battle, 0);
    run(battle, SHRINE.captureTicks);
    expect(battle.shrine.owner).toBe(0);
    unit.hp = 0;
    hold(battle, 1);
    run(battle, SHRINE.captureTicks + 1);
    expect(battle.shrine.owner).toBe(-1);
    run(battle, SHRINE.captureTicks - 1);
    expect(battle.shrine.owner).toBe(1);
  });

  it("fliers don't hold or contest it", () => {
    const battle = createBattle();
    Object.assign(spawnUnit(battle, 1, "drake", 1), { x: SHRINE.x, y: SHRINE.y, frozenTicks: 1e6 });
    run(battle, SHRINE.captureTicks);
    expect(battle.shrine.owner).toBe(-1);
    hold(battle, 0);
    run(battle, SHRINE.captureTicks);
    expect(battle.shrine.owner).toBe(0);
  });

  it("pays its owner extra income", () => {
    const battle = createBattle();
    battle.shrine = { owner: 0, control: SHRINE.captureTicks };
    run(battle, TICK_RATE);
    expect(battle.players[0].gold).toBe(START_GOLD + START_INCOME + SHRINE.income);
    expect(battle.players[1].gold).toBe(START_GOLD + START_INCOME);
  });
});

describe("match end", () => {
  it("destroying the base wins", () => {
    const battle = noTowers();
    battle.players[1].baseHp = 1;
    spawnUnit(battle, 0, "brute", 0).x = FIELD_WIDTH - 1;
    run(battle, 5);
    expect(battle.winner).toBe(0);
  });

  it("at the time limit the base with more HP wins, equal HP draws", () => {
    const battle = createBattle();
    battle.players[0].baseHp -= 1;
    run(battle, MATCH_TICKS);
    expect(battle.winner).toBe(1);

    const even = createBattle();
    run(even, MATCH_TICKS);
    expect(even.winner).toBe(DRAW);
  });
});

describe("determinism", () => {
  it("same seed and inputs give the same battle", () => {
    const simulate = () => {
      const battle = createBattle({ seed: 42 });
      for (let i = 0; i < 6000; i++) {
        if (i % 97 === 0) for (const side of [0, 1] as const) play(battle, side, i % 4, (i * 7 + side) % 12);
        if (i % 500 === 0) invest(battle, (i / 500) % 2 === 0 ? 0 : 1);
        if (i % 1500 === 0) for (const side of [0, 1] as const) research(battle, side);
        step(battle);
      }
      return JSON.stringify(battle);
    };
    const first = simulate();
    expect(JSON.parse(first).units.length + JSON.parse(first).tick).toBeGreaterThan(0);
    expect(simulate()).toBe(first);
  });
});

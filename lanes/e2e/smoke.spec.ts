import { type Browser, type Page, expect, test } from "@playwright/test";
import { CARDS, STARTER_DECK } from "../src/shared/cards";

type Lanes = {
  phase: string | null;
  code: string | null;
  unitCount: number;
  gold: number;
  hand: string[];
  deck: string[];
  grid: string[];
  levels: number[];
  spellsCast: number;
  spectating: boolean;
  visibleGrids: number[];
  cellOnScreen: (cell: number) => { x: number; y: number };
};

const shots = (name: string) => `${process.env.SCREENSHOT_DIR ?? "artifacts/e2e"}/${name}.png`;
const lanes = <T>(page: Page, fn: (l: Lanes, arg: any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__lanes, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

/** A browser context that starts muted: CI runners have no audio device, and a live AudioContext there can stall the page. */
async function newContext(browser: Browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("lanes.muted", "1"));
  return context;
}

/** Places the first affordable unit card in the hand on a cell via keyboard + click. */
async function placeUnit(page: Page, cell: number): Promise<boolean> {
  const { hand, gold } = await lanes(page, (l) => ({ hand: l.hand, gold: l.gold }));
  const slot = hand.findIndex((id) => CARDS[id]?.kind === "unit" && CARDS[id].tier === 1 && CARDS[id].cost <= gold);
  if (slot === -1) return false;
  await page.keyboard.press(String(slot + 1));
  const point = await lanes(page, (l, c) => l.cellOnScreen(c), cell);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => lanes(page, (l, c) => l.grid[c], cell)).not.toBe("");
  return true;
}

/** Casts a spell from the hand if one is there and affordable. */
async function castSpell(page: Page): Promise<boolean> {
  const { hand, gold } = await lanes(page, (l) => ({ hand: l.hand, gold: l.gold }));
  const slot = hand.findIndex((id) => CARDS[id]?.kind === "spell" && CARDS[id].tier === 1 && CARDS[id].cost <= gold);
  if (slot === -1) return false;
  await page.locator(".hand-card").nth(slot).click();
  await expect.poll(() => lanes(page, (l) => l.spellsCast)).toBeGreaterThan(0);
  return true;
}

test("the host spectates and a latecomer watches mid-match", async ({ browser }) => {
  const pages = await Promise.all([0, 1, 2, 3].map(async () => (await newContext(browser)).newPage()));
  const [alice, bob, carol, dave] = pages;

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = await alice.locator("#lobby-code").innerText();
  for (const [page, name] of [
    [bob, "Bob"],
    [carol, "Carol"],
  ] as const) {
    await page.goto("/");
    await page.fill("#name", name);
    await page.fill("#code", code);
    await page.click("#join");
  }
  // The room is full, so Carol lands on the spectator list.
  await expect(alice.locator("#lobby-spectators li", { hasText: "Carol" })).toBeVisible();
  await expect(bob.locator("#lobby button[data-id]")).toHaveCount(0);

  await alice.locator("#lobby-players li", { hasText: "Alice" }).getByRole("button", { name: "Spectate" }).click();
  await alice.locator("#lobby-spectators li", { hasText: "Carol" }).getByRole("button", { name: "Play" }).click();
  await expect(alice.locator("#lobby-players li")).toHaveText([/Bob/, /Carol/]);
  await alice.screenshot({ path: shots("spectate-1-lobby") });

  await alice.click("#start");
  await expect.poll(() => lanes(carol, (l) => l.phase)).toBe("playing");
  await expect(carol.locator(".hand-card strong")).toHaveCount(4);
  expect(await placeUnit(carol, 5)).toBe(true);

  await dave.goto("/");
  await dave.fill("#name", "Dave");
  await dave.fill("#code", code);
  await dave.click("#join");
  for (const page of [alice, dave]) {
    await expect.poll(() => lanes(page, (l) => l.phase)).toBe("playing");
    expect(await lanes(page, (l) => l.spectating)).toBe(true);
    await expect(page.locator("#spectating")).toBeVisible();
    await expect(page.locator(".bottom")).toBeHidden();
    // Spectators see both players' grids.
    expect(await lanes(page, (l) => l.visibleGrids)).toEqual([12, 12]);
  }
  await expect.poll(() => lanes(dave, (l) => l.unitCount), { timeout: 30_000 }).toBeGreaterThan(0);
  await dave.screenshot({ path: shots("spectate-2-watching") });
});

// Tagged @prod: the deploy runs only this test against production; PR CI runs them all.
test("two players build, a wave fights and a spell is cast", { tag: "@prod" }, async ({ browser }) => {
  const alice = await (await newContext(browser)).newPage();
  const bob = await (await newContext(browser)).newPage();

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = await alice.locator("#lobby-code").innerText();

  await bob.goto("/");
  await bob.fill("#name", "Bob");
  await bob.fill("#code", code);
  await bob.click("#join");
  await expect(bob.locator("#lobby-players li")).toHaveCount(2);
  await alice.screenshot({ path: shots("1-lobby") });

  await alice.click("#start");
  await expect.poll(() => lanes(bob, (l) => l.phase)).toBe("playing");
  await expect(alice.locator(".hand-card strong")).toHaveCount(4);
  await expect(alice.locator("#research")).toHaveText("Tier II 250 · 40 s");

  for (const [page, cells] of [
    [alice, [5, 7]],
    [bob, [3, 9]],
  ] as const) {
    for (const cell of cells) expect(await placeUnit(page, cell)).toBe(true);
  }
  await alice.screenshot({ path: shots("2-placed") });

  // Bob sells a pad: click it, then S.
  const gold = await lanes(bob, (l) => l.gold);
  const pad = await lanes(bob, (l) => l.cellOnScreen(9));
  await bob.mouse.click(pad.x, pad.y);
  await expect(bob.locator("#sell")).toBeVisible();
  await bob.keyboard.press("s");
  await expect.poll(() => lanes(bob, (l) => l.grid[9])).toBe("");
  expect(await lanes(bob, (l) => l.gold)).toBeGreaterThan(gold);
  expect(await placeUnit(bob, 9)).toBe(true);
  // Each player only receives their own grid.
  for (const page of [alice, bob]) expect((await lanes(page, (l) => l.visibleGrids)).sort()).toEqual([0, 12]);

  // The first wave spawns at 20 s; keep building until a spell shows up in Alice's hand.
  await expect.poll(() => lanes(alice, (l) => l.unitCount), { timeout: 30_000 }).toBeGreaterThan(0);
  await alice.waitForTimeout(6000);
  let cast = false;
  for (let cell = 0; !cast && cell < 12; cell++) {
    cast = await castSpell(alice);
    // Occupied pads refuse other cards, so only build on empty ones to keep the hand moving.
    if (!cast && !(await lanes(alice, (l, c) => l.grid[c], cell))) {
      await placeUnit(alice, cell);
      await alice.waitForTimeout(1500);
    }
  }
  expect(cast).toBe(true);
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: shots("3-battle") });
  await bob.screenshot({ path: shots("4-battle-bob") });
});

test("a player builds a deck in the lobby and draws only from it", async ({ browser }) => {
  const alice = await (await newContext(browser)).newPage();
  const bob = await (await newContext(browser)).newPage();

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = await alice.locator("#lobby-code").innerText();
  await bob.goto("/");
  await bob.fill("#name", "Bob");
  await bob.fill("#code", code);
  await bob.click("#join");
  await expect(alice.locator("#lobby-players li")).toHaveCount(2);

  // Swap four starter cards for three Knights and a Golem; few clicks, since CI renders slowly.
  await alice.click("#lobby-deck");
  for (const name of ["Footman", "Archer", "Runner", "Swarm"]) {
    await alice.getByRole("button", { name: `Remove ${name}` }).click();
  }
  await expect(alice.locator("#deck-count")).toHaveText(/^6\/10/);
  await expect(alice.locator("#deck-done")).toBeDisabled();
  for (const name of ["Knight", "Knight", "Knight", "Golem"]) await alice.getByRole("button", { name: `Add ${name}` }).click();
  // Three copies is the cap.
  await expect(alice.getByRole("button", { name: "Add Knight" })).toBeDisabled();
  await expect(alice.locator("#deck-count")).toHaveText(/^10\/10 cards · 8 units · 2 spells/);
  await alice.screenshot({ path: shots("deck-1-builder") });
  await alice.click("#deck-done");
  await expect(alice.locator("#lobby")).toBeVisible();

  await alice.click("#start");
  await expect.poll(() => lanes(alice, (l) => l.phase)).toBe("playing");
  await expect(alice.locator("#hand .hand-card strong")).toHaveCount(4);
  const deck = ["bomber", "brute", "golem", "knight", "knight", "knight", "lightning", "medic", "rally", "spearman"];
  for (const id of await lanes(alice, (l) => l.hand)) expect(deck).toContain(id);
  // Bob never touched his deck, so he plays the starter deck.
  for (const id of await lanes(bob, (l) => l.hand)) expect(STARTER_DECK).toContain(id);
  await alice.screenshot({ path: shots("deck-2-hand") });

  // The deck is remembered in this browser.
  await alice.goto("/");
  expect((await lanes(alice, (l) => l.deck)).sort()).toEqual(deck);
});

test("playing a unit onto the same unit levels it up and the field shows its rank", async ({ browser }) => {
  const context = await newContext(browser);
  // Only cheap units, so levels come quickly.
  const deck = ["footman", "footman", "footman", "runner", "runner", "runner", "archer", "archer", "archer", "meteor"];
  await context.addInitScript((d) => localStorage.setItem("lanes.deck", d), JSON.stringify(deck));
  const alice = await context.newPage();
  const bob = await (await newContext(browser)).newPage();

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = await alice.locator("#lobby-code").innerText();
  await bob.goto("/");
  await bob.fill("#name", "Bob");
  await bob.fill("#code", code);
  await bob.click("#join");
  await expect(alice.locator("#lobby-players li")).toHaveCount(2);
  await alice.click("#start");
  await expect.poll(() => lanes(alice, (l) => l.phase)).toBe("playing");

  // Stack each unit onto its own cell until one cell is level 3 and another level 2.
  const done = (levels: number[]) => levels.includes(3) && levels.filter((l) => l >= 2).length >= 2;
  for (let i = 0; i < 60; i++) {
    const { hand, gold, grid, levels } = await lanes(alice, (l) => ({ hand: l.hand, gold: l.gold, grid: l.grid, levels: l.levels }));
    if (done(levels)) break;
    const slot = hand.findIndex((id) => CARDS[id]?.kind === "unit" && CARDS[id].tier === 1 && CARDS[id].cost <= gold);
    if (slot === -1) {
      await alice.waitForTimeout(1000);
      continue;
    }
    const id = hand[slot];
    const own = grid.findIndex((c, cell) => c === id && levels[cell] < 3);
    const cell = own !== -1 ? own : [4, 5, 6].find((c) => !grid[c]) ?? 4;
    await alice.keyboard.press(String(slot + 1));
    const point = await lanes(alice, (l, c) => l.cellOnScreen(c), cell);
    if (own !== -1) {
      await alice.mouse.move(point.x, point.y);
      await alice.screenshot({ path: shots("levels-0-hover-upgrade") });
    }
    await alice.mouse.click(point.x, point.y);
    await expect.poll(() => lanes(alice, (l, c) => [l.grid[c], l.levels[c]], cell)).toEqual([id, own !== -1 ? levels[cell] + 1 : 1]);
  }
  expect(done(await lanes(alice, (l) => l.levels))).toBe(true);
  await alice.mouse.move(5, 5);
  await alice.screenshot({ path: shots("levels-1-grid") });

  // Wait for a wave with the levelled units on the field.
  const wave = await lanes(alice, (l) => l.unitCount);
  await expect.poll(() => lanes(alice, (l) => l.unitCount), { timeout: 30_000 }).toBeGreaterThan(wave);
  await alice.waitForTimeout(2500);
  await alice.screenshot({ path: shots("levels-2-field") });
});

test("a new unit takes the field and new spells show their tier and casts left", async ({ browser }) => {
  const context = await newContext(browser);
  const deck = ["berserker", "berserker", "berserker", "smite", "smite", "wolfrider", "cataclysm", "cataclysm", "repair", "quake"];
  await context.addInitScript((d) => localStorage.setItem("lanes.deck", d), JSON.stringify(deck));
  const alice = await context.newPage();
  const bob = await (await newContext(browser)).newPage();

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = await alice.locator("#lobby-code").innerText();
  await bob.goto("/");
  await bob.fill("#name", "Bob");
  await bob.fill("#code", code);
  await bob.click("#join");
  await expect(alice.locator("#lobby-players li")).toHaveCount(2);
  await alice.click("#start");
  await expect.poll(() => lanes(alice, (l) => l.phase)).toBe("playing");

  // Berserker and Smite are tier I; play them until a Berserker is on the grid and a Smite was cast.
  for (let i = 0; i < 60; i++) {
    const { grid, spellsCast } = await lanes(alice, (l) => ({ grid: l.grid, spellsCast: l.spellsCast }));
    if (grid.includes("berserker") && spellsCast > 0) break;
    const cell = grid.indexOf("berserker") === -1 ? 5 : grid.indexOf("berserker");
    const acted = (spellsCast === 0 && (await castSpell(alice))) || (await lanes(alice, (l, c) => l.levels[c] < 3, cell)) && (await placeUnit(alice, cell));
    if (!acted) await alice.waitForTimeout(1000);
  }
  await expect.poll(() => lanes(alice, (l) => l.unitCount), { timeout: 30_000 }).toBeGreaterThan(0);
  await alice.waitForTimeout(2500);
  await alice.screenshot({ path: shots("new-1-field") });

  // Cards above tier I stay locked; a Cataclysm in hand also shows its casts left.
  const hand = await lanes(alice, (l) => l.hand);
  if (hand.includes("cataclysm")) await expect(alice.locator(".hand-card", { hasText: "Cataclysm" }).first()).toContainText("3/3 left");
  for (const id of hand) if (CARDS[id].tier > 1) await expect(alice.locator(".hand-card", { hasText: CARDS[id].name }).first()).toContainText("Tier");
  await alice.screenshot({ path: shots("new-2-hand") });

  // Discarding a locked card swaps it for the next one and sends it to the bottom of the deck. Cards with a single
  // copy in the deck can't be back in hand right after, so cycle with Shift+1 until one shows up, then discard it.
  const singles = ["wolfrider", "repair", "quake"];
  let discarded = false;
  for (let i = 0; i < 8 && !discarded; i++) {
    await expect.poll(() => lanes(alice, (l) => l.gold), { timeout: 15_000 }).toBeGreaterThanOrEqual(15);
    const now = await lanes(alice, (l) => l.hand);
    const slot = now.findIndex((id) => singles.includes(id));
    if (slot === -1) {
      await alice.keyboard.press("Shift+1");
      await alice.waitForTimeout(300);
      continue;
    }
    const card = alice.locator("#hand .hand-card").nth(slot);
    await card.hover();
    await expect(card.locator(".discard")).toBeVisible();
    await alice.screenshot({ path: shots("new-3-discard") });
    await card.locator(".discard").click();
    await expect.poll(() => lanes(alice, (l) => l.hand)).not.toContain(now[slot]);
    discarded = true;
  }
  expect(discarded).toBe(true);
});

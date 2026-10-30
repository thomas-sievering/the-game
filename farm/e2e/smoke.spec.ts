import { type Page, expect, test } from "@playwright/test";
import { mirror, tileAt } from "../src/shared/sim";

type Farm = {
  phase: string | null;
  side: number;
  coins: number;
  barn: Record<string, number>;
  contracts: { id: number; items: { crop: string; count: number }[] }[];
  tech: string[];
  tiles: { owner: number; terrain: string; crop: string; growth: number; weeds: boolean }[];
  winner: number;
  spectating: boolean;
  watching: string | null;
  tileOnScreen: (tile: number) => { x: number; y: number };
  send: (type: string, message: unknown) => void;
};

const shots = (name: string) => `${process.env.SCREENSHOT_DIR ?? "artifacts/e2e"}/${name}.png`;
const farm = <T>(page: Page, fn: (f: Farm, arg: any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__farm, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

async function clickTile(page: Page, tile: number) {
  const point = await farm(page, (f, t) => f.tileOnScreen(t), tile);
  await page.mouse.click(point.x, point.y);
}

const tileState = (page: Page, tile: number) => farm(page, (f, t) => f.tiles[t], tile);

test("two farmers buy land, grow, sell, fill an order and sabotage", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

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
  for (const page of [alice, bob]) await expect.poll(() => farm(page, (f) => f.tiles.length)).toBe(192);
  expect(await farm(alice, (f) => f.side)).toBe(0);
  expect(await farm(bob, (f) => f.side)).toBe(1);

  // Alice plants wheat (the default tool) on her whole start, then buys a watered tile next to the pond.
  const start = [tileAt(0, 0), tileAt(1, 0), tileAt(0, 1), tileAt(1, 1)];
  for (const tile of start) {
    await clickTile(alice, tile);
    await expect.poll(async () => (await tileState(alice, tile)).crop).toBe("wheat");
  }
  const bought = tileAt(2, 0);
  await clickTile(alice, bought);
  await expect.poll(async () => (await tileState(alice, bought)).owner).toBe(0);
  await clickTile(alice, bought);
  await expect.poll(async () => (await tileState(alice, bought)).crop).toBe("wheat");

  // Bob buys his mirrored tile and plants it, keeping coins for sabotage. His board is turned around.
  await clickTile(bob, mirror(bought));
  await expect.poll(async () => (await tileState(bob, mirror(bought))).owner).toBe(1);
  await bob.keyboard.press("1");
  await clickTile(bob, mirror(bought));
  await expect.poll(async () => (await tileState(bob, mirror(bought))).crop).toBe("wheat");
  await alice.screenshot({ path: shots("2-planted") });
  await bob.screenshot({ path: shots("3-planted-bob") });

  // Hovering a growing crop explains its speed; hovering the well tool explains it.
  const point = await farm(alice, (f, t) => f.tileOnScreen(t), tileAt(0, 1));
  await alice.mouse.move(point.x, point.y);
  await expect(alice.locator("#tip")).toContainText(/ripe in about \d+ s/);
  await expect(alice.locator("#tip")).toContainText("Dry");
  await alice.screenshot({ path: shots("2b-tile-tip") });
  await alice.locator('.tool[data-tool="well"]').hover();
  await expect(alice.locator("#tip")).toContainText("Waters the 8 tiles");
  await alice.screenshot({ path: shots("2c-tool-tip") });

  // Wheat next to the pond ripens in 20 s; the dry tiles take twice as long.
  const wet = [tileAt(1, 0), tileAt(1, 1), bought];
  for (const tile of wet) {
    await expect.poll(async () => (await tileState(alice, tile)).growth, { timeout: 40_000 }).toBe(100);
    await clickTile(alice, tile);
    await expect.poll(async () => (await tileState(alice, tile)).crop).toBe("");
  }
  expect((await farm(alice, (f) => f.barn)).wheat).toBe(3);

  // The first order always asks for 2 wheat.
  const order = (await farm(alice, (f) => f.contracts))[0];
  expect(order.items).toEqual([{ crop: "wheat", count: 2 }]);
  const before = await farm(alice, (f) => f.coins);
  await alice.locator(`.contract[data-id="${order.id}"] .deliver`).click();
  await expect.poll(() => farm(alice, (f, id) => f.contracts.some((c) => c.id === id), order.id)).toBe(false);
  await expect.poll(() => farm(alice, (f) => f.coins)).toBeGreaterThan(before);
  expect((await farm(alice, (f) => f.barn)).wheat).toBe(1);

  await alice.locator('.market-row[data-crop="wheat"] .sell').click();
  await expect.poll(async () => (await farm(alice, (f) => f.barn)).wheat).toBe(0);

  // Alice researches Haggling from her tech tree; Bob looks at her tree through her name badge.
  await alice.keyboard.press("t");
  await alice.locator('.tech-node[data-tech="haggling"] .research').click();
  await expect.poll(() => farm(alice, (f) => f.tech)).toEqual(["haggling"]);
  await expect(alice.locator('.tech-node[data-tech="haggling"]')).toHaveClass(/done/);
  await alice.screenshot({ path: shots("3b-tech") });
  await alice.keyboard.press("Escape");
  await expect(alice.locator("#tech")).toBeHidden();
  await bob.locator('.farmer[data-who="them"] .tech-badge').click();
  await expect(bob.locator("#tech-title")).toHaveText("Alice's tech tree");
  await expect(bob.locator('.tech-node[data-tech="haggling"]')).toHaveClass(/done/);
  await expect(bob.locator(".tech-node .research:visible")).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // Bob sows weeds on Alice's start and she pulls one.
  await bob.keyboard.press("w");
  await clickTile(bob, tileAt(0, 0));
  await expect.poll(async () => (await tileState(alice, tileAt(0, 0))).weeds).toBe(true);
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: shots("4-weeds") });
  await clickTile(alice, tileAt(0, 0));
  await expect.poll(async () => (await tileState(alice, tileAt(0, 0))).weeds).toBe(false);
  await bob.screenshot({ path: shots("5-bob") });

  // Alice gives up; both see the result.
  await alice.click("#concede");
  await expect(alice.locator("#concede")).toHaveText("Click again to give up");
  await alice.click("#concede");
  for (const page of [alice, bob]) {
    await expect(page.locator("#result")).toBeVisible();
    expect(await farm(page, (f) => f.winner)).toBe(1);
  }
  await expect(bob.locator("#result h1")).toHaveText("You win!");
  await alice.screenshot({ path: shots("6-result") });
});

test("the host moves themselves to spectators and starts a match they watch", async ({ browser }) => {
  // Three pages render the farm at once, which is slow on CI's software WebGL.
  test.setTimeout(300_000);
  const [alice, bob, carol] = await Promise.all([0, 1, 2].map(async () => (await browser.newContext()).newPage()));

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
  // The room is full, so Carol spectates; only the host gets move buttons.
  await expect(alice.locator("#lobby-spectators li", { hasText: "Carol" })).toBeVisible();
  await expect(bob.locator("#lobby button[data-id]")).toHaveCount(0);

  await alice.locator("#lobby-players li", { hasText: "Alice" }).getByRole("button", { name: "Spectate" }).click();
  await alice.locator("#lobby-spectators li", { hasText: "Carol" }).getByRole("button", { name: "Play" }).click();
  await expect(alice.locator("#lobby-players li")).toHaveText([/Bob/, /Carol/]);
  await alice.screenshot({ path: shots("spectate-1-lobby") });

  await alice.click("#start");
  for (const page of [alice, bob, carol]) await expect.poll(() => farm(page, (f) => f.phase)).toBe("playing");
  expect(await farm(alice, (f) => f.spectating)).toBe(true);
  expect(await farm(carol, (f) => f.spectating)).toBe(false);
  await expect(alice.locator("#spectating")).toBeVisible();
  // Spectators see the watched farmer's panel read-only, and click the other name to switch.
  await expect(alice.locator("#panel")).toBeVisible();
  await expect(alice.locator("#tools")).toBeHidden();
  await expect(alice.locator("#concede")).toBeHidden();
  await expect(alice.locator("#contracts .contract").first()).toBeVisible();
  // Only the tech tree button works for spectators: it opens a view, not an action.
  await expect(alice.locator("#panel button:enabled:visible:not(#tech-open)")).toHaveCount(0);
  await expect(alice.locator("#versus tr")).toHaveCount(7);
  // A farmer's move shows up in the spectator's feed.
  const land = (await farm(carol, (f) => f.side)) === 0 ? tileAt(2, 0) : mirror(tileAt(2, 0));
  await farm(carol, (f, tile) => f.send("buy", { tile }), land);
  await expect(alice.locator("#feed li", { hasText: "Carol bought land" })).toBeVisible();
  const first = await farm(alice, (f) => f.watching);
  await alice.screenshot({ path: shots("spectate-2-watching") });
  await alice.locator('.farmer[data-who="them"] .farmer-name').click();
  await expect.poll(() => farm(alice, (f) => f.watching)).not.toBe(first);
  await expect(alice.locator("#spectating")).toHaveText(`Watching ${await farm(alice, (f) => f.watching)}`);
  await alice.screenshot({ path: shots("spectate-3-switched") });

  // The spectator opens the other farmer's tech tree from their name badge (without switching farmers), then the watched one's; neither has research buttons.
  const watching = await farm(alice, (f) => f.watching);
  const other = watching === "Bob" ? "Carol" : "Bob";
  await alice.locator('.farmer[data-who="them"] .tech-badge').click();
  await expect(alice.locator("#tech-title")).toHaveText(`${other}'s tech tree`);
  expect(await farm(alice, (f) => f.watching)).toBe(watching);
  await alice.locator("#tech-tabs button", { hasText: watching! }).click();
  await expect(alice.locator("#tech-title")).toHaveText(`${watching}'s tech tree`);
  await expect(alice.locator(".tech-node .research:visible")).toHaveCount(0);
  await alice.screenshot({ path: shots("spectate-3-tech") });
});

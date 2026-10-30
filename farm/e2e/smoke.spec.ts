import { type Page, expect, test } from "@playwright/test";
import { mirror, tileAt } from "../src/shared/sim";

type Farm = {
  phase: string | null;
  side: number;
  coins: number;
  barn: Record<string, number>;
  contracts: { id: number; items: { crop: string; count: number }[] }[];
  tiles: { owner: number; terrain: string; crop: string; growth: number; weeds: boolean }[];
  winner: number;
  tileOnScreen: (tile: number) => { x: number; y: number };
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
  await alice.click("#concede");
  for (const page of [alice, bob]) {
    await expect(page.locator("#result")).toBeVisible();
    expect(await farm(page, (f) => f.winner)).toBe(1);
  }
  await expect(bob.locator("#result h1")).toHaveText("You win!");
  await alice.screenshot({ path: shots("6-result") });
});

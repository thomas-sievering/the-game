import { type Page, expect, test } from "@playwright/test";
import { CARDS } from "../src/shared/cards";

type Lanes = {
  phase: string | null;
  code: string | null;
  unitCount: number;
  gold: number;
  hand: string[];
  grid: string[];
  spellsCast: number;
  visibleGrids: number[];
  cellOnScreen: (cell: number) => { x: number; y: number };
};

const shots = (name: string) => `${process.env.SCREENSHOT_DIR ?? "artifacts/e2e"}/${name}.png`;
const lanes = <T>(page: Page, fn: (l: Lanes, arg: any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__lanes, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

/** Places the first affordable unit card in the hand on a cell via keyboard + click. */
async function placeUnit(page: Page, cell: number): Promise<boolean> {
  const { hand, gold } = await lanes(page, (l) => ({ hand: l.hand, gold: l.gold }));
  const slot = hand.findIndex((id) => CARDS[id]?.kind === "unit" && CARDS[id].cost <= gold);
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
  const slot = hand.findIndex((id) => CARDS[id]?.kind === "spell" && CARDS[id].cost <= gold);
  if (slot === -1) return false;
  await page.locator(".hand-card").nth(slot).click();
  await expect.poll(() => lanes(page, (l) => l.spellsCast)).toBeGreaterThan(0);
  return true;
}

test("two players build, a wave fights and a spell is cast", async ({ browser }) => {
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
  await expect.poll(() => lanes(bob, (l) => l.phase)).toBe("playing");
  await expect(alice.locator(".hand-card strong")).toHaveCount(4);

  for (const [page, cells] of [
    [alice, [5, 7]],
    [bob, [3, 9]],
  ] as const) {
    for (const cell of cells) expect(await placeUnit(page, cell)).toBe(true);
  }
  await alice.screenshot({ path: shots("2-placed") });
  // Each player only receives their own grid.
  for (const page of [alice, bob]) expect((await lanes(page, (l) => l.visibleGrids)).sort()).toEqual([0, 12]);

  // The first wave spawns at 20 s; keep building until a spell shows up in Alice's hand.
  await expect.poll(() => lanes(alice, (l) => l.unitCount), { timeout: 30_000 }).toBeGreaterThan(0);
  await alice.waitForTimeout(6000);
  let cast = false;
  for (let cell = 0; !cast && cell < 12; cell++) {
    cast = await castSpell(alice);
    if (!cast) {
      await placeUnit(alice, cell);
      await alice.waitForTimeout(1500);
    }
  }
  expect(cast).toBe(true);
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: shots("3-battle") });
  await bob.screenshot({ path: shots("4-battle-bob") });
});

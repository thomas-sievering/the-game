import { type Page, expect, test } from "@playwright/test";

type Racer = {
  phase: string | null;
  track: string | null;
  me: { x: number; y: number; cp: number; status: string; place: number; speed: number } | null;
  predicted: { x: number; y: number } | null;
  cars: { id: string; name: string; status: string; place: number; cp: number; bot: boolean }[];
  started: boolean;
  spectating: boolean;
  focus: string | null;
  overview: boolean;
  send: (type: string, message: unknown) => void;
};

const shots = (name: string) => `${process.env.SCREENSHOT_DIR ?? "artifacts/e2e"}/${name}.png`;
const racer = <T>(page: Page, fn: (r: Racer, arg: any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__racer, ${JSON.stringify(arg ?? null)})`) as Promise<T>;

async function open(page: Page, name: string, code?: string) {
  await page.goto("/");
  await page.fill("#name", name);
  if (code) {
    await page.fill("#code", code);
    await page.click("#join");
  } else {
    await page.click("#create");
  }
  await expect(page.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  return page.locator("#lobby-code").innerText();
}

test("two drivers race bots while a spectator watches", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const carol = await (await browser.newContext()).newPage();

  const code = await open(alice, "Alice");
  await open(bob, "Bob", code);
  await open(carol, "Carol", code);
  await expect(alice.locator("#lobby-players li")).toHaveCount(3);

  // The host moves Carol to the spectators, adds two bots, and picks Dune Canyon over one lap.
  await alice.locator('#lobby-players button[data-spectate="true"]').nth(2).click();
  await expect(alice.locator("#lobby-spectators li")).toHaveCount(1);
  await alice.click("#bots-more");
  await alice.click("#bots-more");
  await alice.click('.track-card[data-track="canyon"]');
  await alice.click('#laps button[data-laps="1"]');
  await expect(bob.locator('.track-card[data-track="canyon"]')).toHaveClass(/selected/);
  await expect(bob.locator("#lobby-players li")).toHaveCount(4);
  await alice.screenshot({ path: shots("1-lobby") });

  await alice.click("#start");
  for (const page of [alice, bob, carol]) await expect.poll(() => racer(page, (r) => r.cars.length)).toBe(4);
  expect(await racer(carol, (r) => r.spectating)).toBe(true);
  await expect(alice.locator("#lights")).toBeVisible();
  await alice.screenshot({ path: shots("2-countdown") });
  await expect.poll(() => racer(alice, (r) => r.started), { timeout: 10_000 }).toBe(true);

  // Both drivers floor it; their cars move on the server and checkpoints start counting.
  const start = (await racer(alice, (r) => r.me))!;
  await alice.keyboard.down("ArrowUp");
  await bob.keyboard.down("ArrowUp");
  await alice.waitForTimeout(2500);
  await alice.screenshot({ path: shots("3-racing") });
  await carol.screenshot({ path: shots("4-spectator") });
  const moved = (await racer(alice, (r) => r.me))!;
  expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeGreaterThan(300);
  expect(moved.speed).toBeGreaterThan(200);
  // The predicted car stays close to the server's.
  const predicted = (await racer(alice, (r) => r.predicted))!;
  expect(Math.hypot(predicted.x - moved.x, predicted.y - moved.y)).toBeLessThan(80);
  await alice.keyboard.up("ArrowUp");
  await bob.keyboard.up("ArrowUp");

  // The spectator switches cars and toggles the overview.
  const before = await racer(carol, (r) => r.focus);
  await carol.keyboard.press("ArrowRight");
  await expect.poll(() => racer(carol, (r) => r.focus)).not.toBe(before);
  await carol.keyboard.press("o");
  await expect.poll(() => racer(carol, (r) => r.overview)).toBe(true);
  await carol.waitForTimeout(400);
  await carol.screenshot({ path: shots("5-overview") });

  // Both drivers retire, which ends the race; everyone sees the results.
  await alice.click("#retire");
  await bob.click("#retire");
  for (const page of [alice, bob, carol]) await expect(page.locator("#result")).toBeVisible();
  await expect(carol.locator("#result tr")).toHaveCount(5);
  await alice.screenshot({ path: shots("6-result") });

  await alice.click("#again");
  for (const page of [alice, bob, carol]) await expect(page.locator("#lobby")).toBeVisible();
});

test("every track loads and drives", async ({ page }) => {
  await open(page, "Solo");
  await page.click("#bots-more");
  await page.click("#bots-more");
  await page.click("#bots-more");
  for (const id of ["meadow", "canyon", "neon"]) {
    await page.click(`.track-card[data-track="${id}"]`);
    await expect.poll(() => racer(page, (r) => r.track)).toBe(id);
    await page.screenshot({ path: shots(`track-${id}-lobby`) });
    await page.click("#start");
    await expect.poll(() => racer(page, (r) => r.started), { timeout: 10_000 }).toBe(true);
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(3000);
    await page.screenshot({ path: shots(`track-${id}`) });
    await page.keyboard.up("ArrowUp");
    expect((await racer(page, (r) => r.me))!.speed).toBeGreaterThan(100);
    await page.click("#retire");
    await expect(page.locator("#result")).toBeVisible();
    await page.click("#again");
    await expect(page.locator("#lobby")).toBeVisible();
  }
});

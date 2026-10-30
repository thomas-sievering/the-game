import { type Page, expect, test } from "@playwright/test";

type Point = [number, number];

type Golf = {
  phase: string | null;
  code: string | null;
  holeIndex: number | null;
  hole: { cup: Point; solution: Point[] } | null;
  busy: boolean;
  stats: { shots: number; checks: number; desyncs: number };
  spectating: boolean;
  isMyTurn(): boolean;
  myBall(): [number, number] | null;
  shoot(dx: number, dy: number): boolean;
};

const golf = <T>(page: Page, fn: (g: Golf) => T) => page.evaluate(`(${fn.toString()})(window.__golf)`) as Promise<T>;
const shots = (dir: string) => `${process.env.SCREENSHOT_DIR ?? "artifacts/e2e"}/${dir}.png`;

test("two players create, join and finish hole 1", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  for (const page of [alice, bob]) page.on("console", (m) => m.type() === "warning" && console.log(m.text()));

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = (await alice.locator("#lobby-code").textContent())!;

  await bob.goto(`/?room=${code}`);
  await bob.fill("#name", "Bob");
  await bob.click("#join");
  await expect(alice.locator("#lobby-players li")).toHaveCount(2);
  await alice.screenshot({ path: shots("1-lobby") });

  await alice.click("#start");
  await expect(alice.locator("#hud")).toBeVisible();
  await expect(bob.locator("#hud")).toBeVisible();

  const hole = (await golf(alice, (g) => g.hole))!;
  const solutionIndex = new Map<Page, number>([[alice, 0], [bob, 0]]);
  let tookPlayShot = false;
  const deadline = Date.now() + 150_000;
  while ((await golf(alice, (g) => g.phase)) === "playing") {
    expect(Date.now()).toBeLessThan(deadline);
    for (const page of [alice, bob]) {
      if (!(await golf(page, (g) => g.isMyTurn()))) continue;
      const i = solutionIndex.get(page)!;
      solutionIndex.set(page, i + 1);
      // Play the recorded solution; after that (e.g. the other ball got in the way), putt at the cup.
      let aim: Point | undefined = hole.solution[i];
      if (!aim) {
        const ball = (await golf(page, (g) => g.myBall()))!;
        aim = [hole.cup[0] - ball[0], hole.cup[1] - ball[1]];
      }
      await page.evaluate(([dx, dy]) => (window as any).__golf.shoot(dx, dy), aim);
      if (!tookPlayShot) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: shots("2-playing") });
        tookPlayShot = true;
      }
    }
    await alice.waitForTimeout(250);
  }

  await expect(alice.locator("#scoreboard")).toBeVisible();
  await expect(bob.locator("#scoreboard")).toBeVisible();
  const table = alice.locator("#scoreboard-table");
  for (const name of ["Alice", "Bob"]) {
    const row = table.locator("tr", { hasText: name });
    await expect(row).toHaveCount(1);
    // Hole 1 column holds a stroke count between 1 and 8.
    await expect(row.locator("td").nth(1)).toHaveText(/^[1-8]$/);
  }
  await alice.screenshot({ path: shots("3-scoreboard") });

  for (const page of [alice, bob]) {
    const stats = await golf(page, (g) => g.stats);
    expect(stats.shots).toBeGreaterThan(0);
    expect(stats.checks).toBeGreaterThan(0);
    expect(stats.desyncs).toBe(0);
  }
  // Idle pages keep animating and slow down later tests on CI.
  for (const page of [alice, bob]) await page.context().close();
});

test("the host spectates and a latecomer watches mid-match", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const carol = await (await browser.newContext()).newPage();

  await alice.goto("/");
  await alice.fill("#name", "Alice");
  await alice.click("#create");
  await expect(alice.locator("#lobby-code")).toHaveText(/^[A-Z]{4}$/);
  const code = (await alice.locator("#lobby-code").textContent())!;
  await bob.goto(`/?room=${code}`);
  await bob.fill("#name", "Bob");
  await bob.click("#join");
  await expect(alice.locator("#lobby-players li")).toHaveCount(2);

  // Only the host gets the move buttons; Alice moves herself to the spectators.
  await expect(bob.locator("#lobby button[data-id]")).toHaveCount(0);
  await alice.locator("#lobby-players li", { hasText: "Alice" }).getByRole("button", { name: "Spectate" }).click();
  await expect(bob.locator("#lobby-players li")).toHaveCount(1);
  await expect(bob.locator("#lobby-spectators li", { hasText: "Alice" })).toBeVisible();
  await alice.screenshot({ path: shots("spectate-1-lobby") });

  await alice.click("#start");
  await expect(alice.locator("#spectating")).toBeVisible();
  await expect(bob.locator("#spectating")).toBeHidden();
  await expect.poll(() => golf(bob, (g) => g.isMyTurn())).toBe(true);
  expect(await golf(alice, (g) => g.isMyTurn())).toBe(false);

  await carol.goto(`/?room=${code}`);
  await carol.fill("#name", "Carol");
  await carol.click("#join");
  // Joining waits for the renderer, which a busy CI runner starts slowly.
  await expect(carol.locator("#hud")).toBeVisible({ timeout: 20_000 });
  expect(await golf(carol, (g) => g.spectating)).toBe(true);

  const firstShot = (await golf(bob, (g) => g.hole!.solution[0]))!;
  await bob.evaluate(([dx, dy]) => (window as any).__golf.shoot(dx, dy), firstShot);
  for (const page of [alice, carol]) await expect.poll(() => golf(page, (g) => g.stats.shots), { timeout: 20_000 }).toBe(1);
  await carol.waitForTimeout(400);
  await carol.screenshot({ path: shots("spectate-2-watching") });
  for (const page of [alice, carol]) await expect.poll(() => golf(page, (g) => g.busy), { timeout: 20_000 }).toBe(false);
  for (const page of [alice, carol]) expect((await golf(page, (g) => g.stats)).desyncs).toBe(0);
  for (const page of [alice, bob, carol]) await page.context().close();
});

test("a solo player plays all seven holes to the podium", async ({ page }) => {
  // Balls roll in real time; six holes take about 90 s locally and longer on CI runners.
  test.setTimeout(360_000);
  await page.goto("/");
  await page.fill("#name", "Solo");
  await page.click("#create");
  await page.click("#start");
  await expect(page.locator("#hud")).toBeVisible();

  let shotIndex = 0;
  let hole = -1;
  let solution: Point[] = [];
  const deadline = Date.now() + 300_000;
  for (;;) {
    expect(Date.now()).toBeLessThan(deadline);
    const phase = await golf(page, (g) => g.phase);
    if (phase === "finished") break;
    const index = (await golf(page, (g) => g.holeIndex))!;
    if (index !== hole) {
      hole = index;
      shotIndex = 0;
      solution = (await golf(page, (g) => g.hole!.solution))!;
      await page.waitForTimeout(300);
      await page.screenshot({ path: shots(`hole-${hole + 1}`) });
    }
    if (phase === "playing" && (await golf(page, (g) => g.isMyTurn()))) {
      const aim = solution[shotIndex++];
      expect(aim, `solution for hole ${hole + 1} ran out`).toBeDefined();
      await page.evaluate(([dx, dy]) => (window as any).__golf.shoot(dx, dy), aim);
    }
    await page.waitForTimeout(200);
  }

  await expect(page.locator("#podium")).toBeVisible();
  await expect(page.locator("#podium-blocks .step")).toHaveCount(1);
  await expect(page.locator("#play-again")).toBeVisible();
  await page.screenshot({ path: shots("4-podium") });
  const stats = await golf(page, (g) => g.stats);
  expect(stats.desyncs).toBe(0);
});

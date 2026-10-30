import { describe, expect, it } from "vitest";
import type { Hole, Mover, Zone } from "../src/shared/hole";
import { HOLES } from "../src/shared/holes";
import { BALL_RADIUS, MAX_AIM_DISTANCE, moverPose, simulateShot, turnCosSin } from "../src/shared/physics";
import { MAX_STROKES } from "../src/shared/rules";
import { aimForDistance } from "./helpers";

function box(zones: Zone[] = []): Hole {
  return {
    id: "test",
    name: "Test",
    par: 3,
    bounds: [[0, 0], [1000, 0], [1000, 400], [0, 400]],
    obstacles: [],
    zones,
    tee: [100, 200],
    cup: [5000, 5000],
    solution: [],
  };
}

const solo = (hole: Hole, x: number, y: number, aim: [number, number]) =>
  simulateShot(hole, [{ id: "a", x, y }], "a", aim);

describe("physics", () => {
  it("rolls in the aimed direction and comes to rest", () => {
    const r = solo(box(), 100, 200, [60, 0]);
    expect(r.balls[0].x).toBeGreaterThan(200);
    expect(r.balls[0].y).toBe(200);
    expect(r.ticks).toBeLessThan(120 * 25);
  });

  it("bounces off a wall instead of passing through it", () => {
    const r = solo(box(), 900, 200, [MAX_AIM_DISTANCE, 0]);
    expect(r.events.some((e) => e.type === "wall")).toBe(true);
    expect(r.balls[0].x).toBeLessThan(1000 - BALL_RADIUS + 1e-9);
    expect(r.balls[0].x).toBeLessThan(900);
  });

  it("reflects an angled shot off a wall", () => {
    const r = solo(box(), 500, 300, [120, 120]);
    // Bounced off the bottom wall: ends above where it would have crossed y=400 and keeps moving right.
    expect(r.balls[0].y).toBeLessThan(400 - BALL_RADIUS + 1e-9);
    expect(r.balls[0].x).toBeGreaterThan(600);
  });

  it("slows down much faster in sand", () => {
    const grass = solo(box(), 100, 200, [120, 0]);
    const sand = solo(box([{ type: "sand", points: [[0, 0], [1000, 0], [1000, 400], [0, 400]] }]), 100, 200, [120, 0]);
    expect(sand.balls[0].x - 100).toBeLessThan((grass.balls[0].x - 100) / 2);
  });

  it("is pushed by a slope", () => {
    const r = solo(box([{ type: "slope", points: [[0, 0], [1000, 0], [1000, 400], [0, 400]], force: [0, 200] }]), 100, 100, [80, 0]);
    expect(r.balls[0].y).toBeGreaterThan(300);
  });

  it("returns a ball that lands in water to its starting point", () => {
    const r = solo(box([{ type: "water", points: [[400, 0], [500, 0], [500, 400], [400, 400]] }]), 100, 200, [MAX_AIM_DISTANCE, 0]);
    expect(r.balls[0]).toMatchObject({ x: 100, y: 200, splashed: true, holed: false });
    expect(r.events.some((e) => e.type === "splash")).toBe(true);
  });

  it("holes out a slow ball over the cup", () => {
    const hole = { ...box(), cup: [300, 200] as [number, number] };
    const r = solo(hole, 100, 200, [aimForDistance(200), 0]);
    expect(r.balls[0]).toMatchObject({ x: 300, y: 200, holed: true });
  });

  it("lets a fast ball roll over the cup", () => {
    const hole = { ...box(), cup: [200, 200] as [number, number] };
    const r = solo(hole, 100, 200, [MAX_AIM_DISTANCE, 0]);
    expect(r.balls[0].holed).toBe(false);
  });
});

describe("ball collisions", () => {
  it("transfers momentum to a resting ball on a head-on hit", () => {
    const hole = box();
    const r = simulateShot(hole, [{ id: "a", x: 100, y: 200 }, { id: "b", x: 300, y: 200 }], "a", [100, 0]);
    const [a, b] = r.balls;
    expect(r.events.some((e) => e.type === "ball")).toBe(true);
    // The shooter nearly stops just before the struck ball's old spot; the struck ball carries on.
    expect(a.x).toBeGreaterThan(250);
    expect(a.x).toBeLessThan(300);
    expect(b.x).toBeGreaterThan(400);
    expect(a.y).toBe(200);
    expect(b.y).toBe(200);
  });

  it("deflects a resting ball sideways on a glancing hit", () => {
    const r = simulateShot(box(), [{ id: "a", x: 100, y: 200 }, { id: "b", x: 300, y: 207 }], "a", [100, 0]);
    expect(r.balls[1].y).toBeGreaterThan(207);
    expect(r.balls[0].y).toBeLessThan(200);
  });

  it("puts a knocked ball back where it rested when it ends up in water", () => {
    const hole = box([{ type: "water", points: [[400, 0], [500, 0], [500, 400], [400, 400]] }]);
    const r = simulateShot(hole, [{ id: "a", x: 100, y: 200 }, { id: "b", x: 300, y: 200 }], "a", [MAX_AIM_DISTANCE, 0]);
    expect(r.balls[1]).toMatchObject({ x: 300, y: 200, splashed: true });
  });

  it("holes a ball that gets knocked into the cup", () => {
    const hole = { ...box(), cup: [420, 200] as [number, number] };
    // Enough to carry the struck ball a little past the cup if it were not there.
    const r = simulateShot(hole, [{ id: "a", x: 100, y: 200 }, { id: "b", x: 300, y: 200 }], "a", [aimForDistance(340), 0]);
    expect(r.balls[1].holed).toBe(true);
    expect(r.balls[0].holed).toBe(false);
  });
});

describe("bumpers", () => {
  it("kicks a slow ball back faster than it arrived", () => {
    const hole: Hole = { ...box(), bumpers: [{ center: [300, 200], radius: 20 }] };
    const r = simulateShot(hole, [{ id: "a", x: 200, y: 200 }], "a", [aimForDistance(120), 0], { record: true });
    expect(r.events.some((e) => e.type === "bumper")).toBe(true);
    // Without the bumper it would have stopped near x=320; instead it flies back past the start.
    expect(r.balls[0].x).toBeLessThan(150);
  });
});

describe("moving obstacles", () => {
  const slider: Mover = { type: "slider", points: [[480, 100], [520, 100], [520, 300], [480, 300]], path: [0, 60], period: 2 };
  const spinner: Mover = { type: "spinner", center: [500, 200], length: 80, width: 12, arms: 2, period: 2 };

  it("computes cos and sin of whole turns accurately", () => {
    for (let t = -1; t <= 2; t += 0.0137) {
      const [c, s] = turnCosSin(t);
      expect(c).toBeCloseTo(Math.cos(t * 2 * Math.PI), 8);
      expect(s).toBeCloseTo(Math.sin(t * 2 * Math.PI), 8);
    }
  });

  it("moves a slider out along its path and back over one period", () => {
    const at = (n: number) => moverPose(slider, n) as { dx: number; dy: number; vy: number };
    expect(at(0).dy).toBe(0);
    expect(at(240).dy).toBeCloseTo(60);
    expect(at(120).vy).toBeGreaterThan(0);
    expect(at(360).vy).toBeLessThan(0);
    expect(at(480).dy).toBe(0);
  });

  it("blocks a ball like a wall and hits resting balls when it moves into them", () => {
    const hole: Hole = { ...box(), movers: [slider] };
    const blocked = solo(hole, 100, 200, [MAX_AIM_DISTANCE, 0]);
    expect(blocked.events.some((e) => e.type === "mover")).toBe(true);
    expect(blocked.balls[0].x).toBeLessThan(480);

    // A ball resting just below the block gets shoved down when the block slides onto it.
    const r = simulateShot(hole, [{ id: "a", x: 100, y: 50 }, { id: "b", x: 500, y: 310 }], "a", [aimForDistance(300), 0]);
    expect(r.balls[1].y).toBeGreaterThan(330);
  });

  it("swats a ball with a spinning arm", () => {
    const hole: Hole = { ...box(), movers: [spinner] };
    // A ball resting inside the sweep gets hit by an arm while another ball rolls, and is flung out.
    const r = simulateShot(hole, [{ id: "a", x: 100, y: 50 }, { id: "b", x: 500, y: 250 }], "a", [MAX_AIM_DISTANCE, 0]);
    expect(r.events.some((e) => e.type === "mover" && e.id === "b")).toBe(true);
    const [dx, dy] = [r.balls[1].x - 500, r.balls[1].y - 200];
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(80 + 6 + BALL_RADIUS);
  });

  it("depends on the course clock the shot starts at", () => {
    const hole: Hole = { ...box(), movers: [slider] };
    const a = solo(hole, 100, 330, [MAX_AIM_DISTANCE, 0]);
    const b = simulateShot(hole, [{ id: "a", x: 100, y: 330 }], "a", [MAX_AIM_DISTANCE, 0], { startTick: 120 });
    expect(a.balls[0].x).not.toBe(b.balls[0].x);
  });
});

describe("determinism", () => {
  it("produces identical results and frames for the same shot", () => {
    const hole = HOLES[5];
    const balls = [{ id: "a", x: 120, y: 130 }, { id: "b", x: 300, y: 140 }, { id: "c", x: 700, y: 100 }];
    const one = simulateShot(hole, balls, "a", [181.3, 12.77], { record: true });
    const two = simulateShot(hole, balls, "a", [181.3, 12.77], { record: true });
    expect(two.balls).toEqual(one.balls);
    expect(two.events).toEqual(one.events);
    expect(two.frames!.length).toBe(one.frames!.length);
    two.frames!.forEach((f, i) => expect(Array.from(f)).toEqual(Array.from(one.frames![i])));
  });

  it("replays moving obstacles identically from any course clock", () => {
    const hole = HOLES[9];
    const balls = [{ id: "a", x: 1000, y: 120 }, { id: "b", x: 1100, y: 420 }];
    const one = simulateShot(hole, balls, "a", [40, 200], { record: true, startTick: 777 });
    const two = simulateShot(hole, balls, "a", [40, 200], { record: true, startTick: 777 });
    expect(one.events.some((e) => e.type === "mover")).toBe(true);
    expect(two.balls).toEqual(one.balls);
    expect(two.events).toEqual(one.events);
  });

  it("ends the recorded animation exactly on the authoritative result", () => {
    const hole = HOLES[2];
    const r = simulateShot(hole, [{ id: "a", x: 120, y: 300 }, { id: "b", x: 250, y: 310 }], "a", [200, 30], { record: true });
    const last = r.frames![r.frames!.length - 1];
    r.balls.forEach((b, i) => {
      if (b.holed || b.splashed) return;
      expect(last[i * 2]).toBe(b.x);
      expect(last[i * 2 + 1]).toBe(b.y);
    });
  });
});

describe("holes", () => {
  it.each(HOLES.map((h) => [h.name, h] as const))("%s is solvable from its recorded solution", (_name, hole) => {
    expect(hole.solution.length).toBeGreaterThan(0);
    expect(hole.solution.length).toBeLessThanOrEqual(MAX_STROKES);
    let pos = { x: hole.tee[0], y: hole.tee[1] };
    let holed = false;
    let tick = 0;
    for (const aim of hole.solution) {
      const result = simulateShot(hole, [{ id: "p", ...pos }], "p", aim, { startTick: tick });
      const ball = result.balls[0];
      tick += result.ticks;
      expect(ball.splashed).toBe(false);
      pos = { x: ball.x, y: ball.y };
      holed = ball.holed;
    }
    expect(holed).toBe(true);
  });

  it("have tees and cups inside the fairway", async () => {
    const { pointInPolygon } = await import("../src/shared/hole");
    for (const hole of HOLES) {
      expect(pointInPolygon(...hole.tee, hole.bounds)).toBe(true);
      expect(pointInPolygon(...hole.cup, hole.bounds)).toBe(true);
    }
  });
});

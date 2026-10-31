import { describe, expect, it } from "vitest";
import {
  CAR,
  type Car,
  FINISH_GRACE_TICKS,
  KEY,
  type Race,
  TICK_RATE,
  collideCars,
  createRace,
  lapTime,
  nearestSeg,
  progress,
  retire,
  standings,
  stepCar,
  stepRace,
} from "../src/shared/sim";
import { TRACKS, TRACK_IDS, roadDistance } from "../src/shared/tracks";

const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}`, color: i, bot: true }));
const human = (id = "me") => ({ id, name: id, color: 0, bot: false });

/** A race already past the countdown. */
function racing(entrants = [human()], trackId: (typeof TRACK_IDS)[number] = "meadow", laps = 3): Race {
  const race = createRace(trackId, laps, entrants);
  while (race.tick < race.startTick) stepRace(race, new Map());
  race.events.length = 0;
  return race;
}

function drive(race: Race, input: number, ticks: number, id = "me") {
  for (let i = 0; i < ticks; i++) stepRace(race, new Map([[id, input]]));
}

const speed = (car: Car) => Math.sqrt(car.vx * car.vx + car.vy * car.vy);

describe("tracks", () => {
  for (const id of TRACK_IDS) {
    const track = TRACKS[id];
    it(`${track.name} is a closed loop with obstacles off the road`, () => {
      expect(track.path.length).toBeGreaterThan(300);
      for (let i = 0; i < track.path.length; i++) {
        const a = track.path[i];
        const b = track.path[(i + 1) % track.path.length];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(track.spacing, 0);
      }
      for (const c of track.circles) expect(roadDistance(track, c)).toBeGreaterThan(track.half + c.r);
      for (const slot of track.grid) expect(roadDistance(track, slot)).toBeLessThan(track.half);
      expect(track.boosts).toHaveLength(3);
      expect(track.rects.filter((r) => r.kind === "stand")).toHaveLength(1);
    });

    it(`${track.name} never comes close to crossing itself`, () => {
      // Points far apart along the road must be at least a road width apart in space.
      const n = track.path.length;
      for (let i = 0; i < n; i += 3) {
        for (let j = i + 40; j < n; j += 3) {
          if (n - (j - i) < 40) continue;
          expect(Math.hypot(track.path[i].x - track.path[j].x, track.path[i].y - track.path[j].y)).toBeGreaterThan(track.half * 2 + 20);
        }
      }
    });
  }
});

describe("driving", () => {
  it("holds still during the countdown", () => {
    const race = createRace("meadow", 3, [human()]);
    const car = race.cars[0];
    const start = { x: car.x, y: car.y };
    drive(race, KEY.up, race.startTick - 1);
    expect({ x: car.x, y: car.y }).toEqual(start);
  });

  it("accelerates toward top speed and brakes hard", () => {
    const race = racing();
    const car = race.cars[0];
    drive(race, KEY.up, TICK_RATE);
    const after1s = speed(car);
    expect(after1s).toBeGreaterThan(200);
    expect(after1s).toBeLessThan(CAR.maxSpeed);
    // Braking takes off 1000 px/s per second, then holding on turns into reversing.
    drive(race, KEY.down, 8);
    expect(speed(car)).toBeLessThan(after1s - 230);
    drive(race, 0, TICK_RATE * 3);
    expect(speed(car)).toBe(0);
  });

  it("reverses slowly", () => {
    const race = racing();
    const car = race.cars[0];
    drive(race, KEY.down, TICK_RATE * 2);
    expect(car.vx * car.hx + car.vy * car.hy).toBeLessThan(-100);
    expect(speed(car)).toBeLessThanOrEqual(CAR.reverseMax);
  });

  it("steers only while moving", () => {
    const race = racing();
    const car = race.cars[0];
    const heading = { x: car.hx, y: car.hy };
    drive(race, KEY.left, 10);
    expect({ x: car.hx, y: car.hy }).toEqual(heading);
    drive(race, KEY.up, 20);
    drive(race, KEY.up | KEY.right, 10);
    expect(car.hx * heading.x + car.hy * heading.y).toBeLessThan(0.95);
  });

  it("is slower off the road", () => {
    const track = TRACKS.meadow;
    const onRoad = racing().cars[0];
    const off = racing().cars[0];
    // Park the second car in open grass, pointing the same way.
    const spot = { x: 1700, y: 1150 };
    expect(roadDistance(track, spot)).toBeGreaterThan(track.half + 200);
    Object.assign(off, { x: spot.x, y: spot.y, hx: 1, hy: 0, seg: nearestSeg(track, spot.x, spot.y, -1) });
    Object.assign(onRoad, { hx: 1, hy: 0 });
    for (let i = 0; i < TICK_RATE * 2; i++) {
      stepCar(track, off, KEY.up, false);
      off.x = spot.x; // keep it in the grass
      off.y = spot.y;
    }
    expect(off.offroad).toBe(true);
    expect(speed(off)).toBeLessThanOrEqual(CAR.offroadMaxSpeed + 1);
  });

  it("bounces off obstacles instead of passing through", () => {
    const track = TRACKS.meadow;
    const tree = track.circles.find((c) => c.kind === "tree")!;
    const car = racing().cars[0];
    Object.assign(car, { x: tree.x - tree.r - 60, y: tree.y, hx: 1, hy: 0, vx: 400, vy: 0 });
    car.seg = nearestSeg(track, car.x, car.y, -1);
    let hit = 0;
    for (let i = 0; i < 20; i++) hit = Math.max(hit, stepCar(track, car, KEY.up, false).hit);
    expect(hit).toBeGreaterThan(100);
    expect(Math.hypot(car.x - tree.x, car.y - tree.y)).toBeGreaterThanOrEqual(tree.r + CAR.radius - 0.001);
  });

  it("stays inside the world", () => {
    const track = TRACKS.neon;
    const car = racing([human()], "neon").cars[0];
    Object.assign(car, { x: 30, y: 30, hx: -1, hy: 0, vx: -500, vy: 0 });
    for (let i = 0; i < 10; i++) stepCar(track, car, KEY.up, false);
    expect(car.x).toBeGreaterThanOrEqual(CAR.radius);
  });

  it("boost pads give a kick and a few seconds of extra top speed", () => {
    const track = TRACKS.meadow;
    const car = racing().cars[0];
    const pad = track.boosts[0];
    Object.assign(car, { x: pad.x - pad.dx * 40, y: pad.y - pad.dy * 40, hx: pad.dx, hy: pad.dy, vx: pad.dx * 300, vy: pad.dy * 300 });
    car.seg = nearestSeg(track, car.x, car.y, -1);
    let boosted = false;
    for (let i = 0; i < 10; i++) boosted = stepCar(track, car, KEY.up, false).boosted || boosted;
    expect(boosted).toBe(true);
    expect(car.boost).toBeGreaterThan(0);
    expect(speed(car)).toBeGreaterThan(400);
  });

  it("cars push each other apart", () => {
    const race = racing([human("a"), human("b")]);
    const [a, b] = race.cars;
    Object.assign(b, { x: a.x + 10, y: a.y, vx: -200, vy: 0 });
    collideCars(race);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(CAR.radius * 2, 5);
    expect(a.vx).toBeLessThan(0);
  });
});

describe("laps and results", () => {
  for (const id of TRACK_IDS) {
    it(`bots finish a lap of ${TRACKS[id].name}`, () => {
      const race = racing(bots(4), id, 1);
      const events: string[] = [];
      while (!race.over) {
        stepRace(race, new Map());
        for (const e of race.events.splice(0)) events.push(e.type);
      }
      expect(race.cars.every((c) => c.status === "finished")).toBe(true);
      expect(events.filter((e) => e === "finish")).toHaveLength(4);
      for (const car of race.cars) expect(car.bestLap / TICK_RATE).toBeLessThan(40);
    });
  }

  it("a lap only counts after passing every checkpoint in order", () => {
    const race = racing([human()], "meadow", 3);
    const car = race.cars[0];
    const track = race.track;
    // Teleport just past the start line without driving the lap: nothing counts.
    Object.assign(car, { x: track.path[2].x, y: track.path[2].y, seg: 2 });
    drive(race, 0, 2);
    expect(car.cp).toBe(0);
    // Visit each checkpoint in turn, then the line.
    for (const cp of [...track.checkpoints.slice(1), 0]) {
      Object.assign(car, { x: track.path[cp + 1].x, y: track.path[cp + 1].y, seg: cp + 1, vx: 0, vy: 0 });
      drive(race, 0, 1);
    }
    expect(car.cp).toBe(track.checkpoints.length);
    expect(race.events.some((e) => e.type === "lap" && e.lap === 1)).toBe(true);
  });

  it("driving backwards over the line doesn't count", () => {
    const race = racing();
    const car = race.cars[0];
    const track = race.track;
    const n = track.path.length;
    // Back from just after the line to just before it.
    for (const seg of [3, 1, n - 1, n - 3, n - 6]) {
      Object.assign(car, { x: track.path[seg].x, y: track.path[seg].y, seg, vx: 0, vy: 0 });
      drive(race, 0, 1);
    }
    expect(car.cp).toBe(0);
  });

  it("orders standings by finish, then distance, with retired cars last", () => {
    const race = racing([human("a"), human("b"), human("c")]);
    const [a, b, c] = race.cars;
    a.cp = 5;
    b.cp = 9;
    c.cp = 7;
    expect(standings(race).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(progress(race, b)).toBeGreaterThan(progress(race, c));
    retire(race, "b");
    expect(standings(race).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("ends when every human is done, even with bots still racing", () => {
    const race = racing([human("a"), ...bots(2)]);
    expect(retire(race, "a")).toBeNull();
    expect(retire(race, "a")).toBe("You're already done");
    stepRace(race, new Map());
    expect(race.over).toBe(true);
  });

  it("gives the rest a grace period after the winner finishes", () => {
    const race = racing([human("a"), human("b")], "meadow", 1);
    const [a] = race.cars;
    a.cp = race.track.checkpoints.length - 1;
    Object.assign(a, { x: race.track.path[1].x, y: race.track.path[1].y, seg: 1 });
    drive(race, 0, 1, "a");
    expect(a.status).toBe("finished");
    expect(race.endTick).toBe(race.tick + FINISH_GRACE_TICKS);
    while (!race.over) stepRace(race, new Map());
    expect(race.tick).toBe(race.endTick);
    expect(standings(race)[0].id).toBe("a");
  });

  it("formats times", () => {
    expect(lapTime(0)).toBe("0:00.00");
    expect(lapTime(TICK_RATE * 75 + 15)).toBe("1:15.50");
  });
});

describe("determinism", () => {
  it("the same inputs give an identical race", () => {
    const run = () => {
      const race = createRace("neon", 2, [human("a"), human("b"), ...bots(4)]);
      for (let t = 0; t < TICK_RATE * 40; t++) {
        const a = t % 50 < 30 ? KEY.up | (t % 17 < 5 ? KEY.left : 0) : KEY.down;
        const b = KEY.up | (t % 23 < 8 ? KEY.right : 0);
        stepRace(
          race,
          new Map([
            ["a", a],
            ["b", b],
          ]),
        );
      }
      return JSON.stringify({ cars: race.cars, tick: race.tick });
    };
    expect(run()).toBe(run());
  });

  it("replaying a car's inputs on a copy lands on exactly the same spot (client prediction)", () => {
    const race = racing([human("a")], "canyon");
    const car = race.cars[0];
    const copy = structuredClone(car);
    const inputs = Array.from({ length: 200 }, (_, t) => KEY.up | (t % 40 < 12 ? KEY.left : t % 40 > 30 ? KEY.right : 0));
    for (const input of inputs) stepRace(race, new Map([["a", input]]));
    for (const input of inputs) stepCar(race.track, copy, input, false);
    expect(copy.x).toBe(car.x);
    expect(copy.y).toBe(car.y);
    expect(copy.hx).toBe(car.hx);
  });
});

import { describe, expect, it } from "vitest";
import { Match } from "../src/server/match";
import type { Hole } from "../src/shared/hole";
import { MAX_AIM_DISTANCE } from "../src/shared/physics";
import { aimForDistance } from "./helpers";

const hole = (overrides: Partial<Hole> = {}): Hole => ({
  id: "t",
  name: "T",
  par: 3,
  bounds: [[0, 0], [1000, 0], [1000, 400], [0, 400]],
  obstacles: [],
  zones: [],
  tee: [100, 200],
  cup: [300, 200],
  solution: [],
  ...overrides,
});

const HOLE_IN_ONE: [number, number] = [aimForDistance(200), 0];
const TINY: [number, number] = [1, 0];

function started(n: number, holes = [hole(), hole()]) {
  const m = new Match(holes);
  for (let i = 0; i < n; i++) m.addPlayer(`p${i}`, `P${i}`);
  m.start();
  return m;
}

describe("match", () => {
  it("assigns unique colours and the first player as host", () => {
    const m = new Match([hole()]);
    const a = m.addPlayer("a", "A");
    const b = m.addPlayer("b", "B");
    expect(a.color).not.toBe(b.color);
    expect(m.hostId).toBe("a");
  });

  it("refuses new players after the start and beyond eight", () => {
    const m = new Match([hole()]);
    for (let i = 0; i < 8; i++) m.addPlayer(`p${i}`, "x");
    expect(() => m.addPlayer("p9", "x")).toThrow();
    m.start();
    expect(() => new Match([hole()]).addPlayer("a", "a")).not.toThrow();
    expect(() => m.addPlayer("late", "x")).toThrow();
  });

  it("rotates turns round-robin and skips players who holed out", () => {
    const m = started(3);
    expect(m.turnId).toBe("p0");
    m.shoot("p0", HOLE_IN_ONE);
    expect(m.player("p0")!.holed).toBe(true);
    expect(m.turnId).toBe("p1");
    m.shoot("p1", TINY);
    expect(m.turnId).toBe("p2");
    m.shoot("p2", TINY);
    expect(m.turnId).toBe("p1");
  });

  it("runs the course clock only while balls roll and resets it each hole", () => {
    const m = started(2);
    const first = m.shoot("p0", TINY);
    expect(first.startTick).toBe(0);
    expect(m.courseTick).toBe(first.result.ticks);
    const holeInOne = m.shoot("p1", HOLE_IN_ONE);
    m.timeout("p0");
    expect(m.courseTick).toBe(first.result.ticks + holeInOne.result.ticks);
    while (m.phase === "playing") m.timeout("p0");
    m.nextHole();
    expect(m.holeIndex).toBe(1);
    expect(m.courseTick).toBe(0);
  });

  it("rejects shots out of turn", () => {
    const m = started(2);
    expect(() => m.shoot("p1", TINY)).toThrow();
  });

  it("adds a penalty stroke and resets the ball after water", () => {
    const m = started(1, [hole({ zones: [{ type: "water", points: [[400, 0], [500, 0], [500, 400], [400, 400]] }], cup: [900, 200] })]);
    m.shoot("p0", [MAX_AIM_DISTANCE, 0]);
    const p = m.player("p0")!;
    expect(p.strokes[0]).toBe(2);
    expect([p.x, p.y]).toEqual([100, 200]);
  });

  it("does not penalise a ball knocked into water", () => {
    const water = { type: "water" as const, points: [[600, 0], [700, 0], [700, 400], [600, 400]] as [number, number][] };
    const m = started(2, [hole({ zones: [water], cup: [900, 50] })]);
    m.shoot("p0", [40, 0]); // p0 rests somewhere along the line
    const victim = m.player("p0")!;
    const rest = [victim.x, victim.y];
    m.shoot("p1", [MAX_AIM_DISTANCE, 0]); // blasts through p0 towards the water
    expect(victim.strokes[0]).toBe(1);
    expect([victim.x, victim.y]).toEqual(rest);
  });

  it("counts a ball knocked into the cup as holed without an extra stroke", () => {
    const m = started(2, [hole({ cup: [420, 200] })]);
    m.shoot("p0", [aimForDistance(200), 0]); // rests short of the cup at x=300
    const victim = m.player("p0")!;
    expect(victim.holed).toBe(false);
    m.shoot("p1", [aimForDistance(340), 0]);
    expect(victim.holed).toBe(true);
    expect(victim.strokes[0]).toBe(1);
  });

  it("picks the ball up at eight strokes", () => {
    const m = started(1, [hole({ cup: [900, 50] })]);
    for (let i = 0; i < 8; i++) m.shoot("p0", TINY);
    const p = m.player("p0")!;
    expect(p.strokes[0]).toBe(8);
    expect(p.pickedUp).toBe(true);
    expect(m.phase).toBe("holeEnd");
  });

  it("counts a shot-clock timeout as a stroke", () => {
    const m = started(2);
    m.timeout("p0");
    expect(m.player("p0")!.strokes[0]).toBe(1);
    expect(m.turnId).toBe("p1");
  });

  it("skips disconnected players and finishes them as DNF", () => {
    const m = started(3);
    m.setConnected("p1", false);
    m.shoot("p0", TINY);
    expect(m.turnId).toBe("p2");
    m.markDnf("p1");
    m.shoot("p2", HOLE_IN_ONE);
    m.shoot("p0", TINY);
    expect(m.turnId).toBe("p0");
    expect(m.standings().at(-1)!.player.id).toBe("p1");
  });

  it("moves host to the next connected player", () => {
    const m = started(2);
    m.setConnected("p0", false);
    expect(m.hostId).toBe("p1");
  });

  it("seats joiners as spectators once the lobby is full or the match has started", () => {
    const m = new Match([hole()]);
    for (let i = 0; i < 9; i++) m.join(`p${i}`, `P${i}`);
    expect(m.players).toHaveLength(8);
    expect(m.spectators.map((s) => s.id)).toEqual(["p8"]);
    m.start();
    m.join("late", "Late");
    expect(m.spectators.map((s) => s.id)).toEqual(["p8", "late"]);
  });

  it("moves people between players and spectators in the lobby only", () => {
    const m = new Match([hole()]);
    m.addPlayer("host", "Host");
    m.addPlayer("b", "B");
    m.setSpectator("host", true);
    expect(m.players.map((p) => p.id)).toEqual(["b"]);
    expect(m.hostId).toBe("host");
    m.setSpectator("host", false);
    expect(m.players.map((p) => p.id)).toEqual(["b", "host"]);
    expect(new Set(m.players.map((p) => p.color)).size).toBe(2);
    m.setSpectator("b", true);
    m.start();
    expect(m.turnId).toBe("host");
    expect(() => m.setSpectator("b", false)).toThrow();
  });

  it("does not seat a spectator in a full lobby", () => {
    const m = new Match([hole()]);
    for (let i = 0; i < 9; i++) m.join(`p${i}`, `P${i}`);
    expect(() => m.setSpectator("p8", false)).toThrow();
    expect(m.spectator("p8")).toBeDefined();
  });

  it("passes host to a spectator when no player is left", () => {
    const m = new Match([hole()]);
    m.addPlayer("a", "A");
    m.addSpectator("s", "S");
    m.removePlayer("a");
    expect(m.hostId).toBe("s");
  });

  it("plays through all holes to a finished podium", () => {
    const m = started(2);
    for (let h = 0; h < 2; h++) {
      m.shoot("p0", HOLE_IN_ONE);
      while (m.phase === "playing") m.shoot("p1", m.player("p1")!.onCourse ? TINY : HOLE_IN_ONE);
      expect(m.phase).toBe("holeEnd");
      m.nextHole();
    }
    expect(m.phase).toBe("finished");
    const [first] = m.standings();
    expect(first.player.id).toBe("p0");
    expect(first.total).toBe(2);
  });
});

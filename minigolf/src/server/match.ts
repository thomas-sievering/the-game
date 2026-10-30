// Pure match rules, independent of Colyseus so they can be unit tested.
import type { Hole, Point } from "../shared/hole";
import { type ShotResult, type SimBall, simulateShot } from "../shared/physics";
import { BALL_COLORS, MAX_PLAYERS, MAX_STROKES } from "../shared/rules";

export type Phase = "lobby" | "playing" | "holeEnd" | "finished";

export interface Player {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  dnf: boolean;
  /** Strokes per hole; index = hole number. */
  strokes: number[];
  /** Ball has been teed off on the current hole. */
  onCourse: boolean;
  holed: boolean;
  pickedUp: boolean;
  x: number;
  y: number;
}

/** Someone in the room who watches instead of playing. */
export interface Spectator {
  id: string;
  name: string;
}

export interface ShotOutcome {
  shooterId: string;
  aim: Point;
  /** Ball positions the shot started from, in simulation order. */
  start: SimBall[];
  /** Course clock when the shot started. */
  startTick: number;
  result: ShotResult;
}

export class Match {
  phase: Phase = "lobby";
  players: Player[] = [];
  spectators: Spectator[] = [];
  holeIndex = 0;
  turnId: string | null = null;
  /** Increments every time a turn is handed out, even to the same player again. */
  turnSeq = 0;
  hostId: string | null = null;
  /** Ticks balls have rolled on this hole; moving obstacles are posed from it. */
  courseTick = 0;

  constructor(readonly holes: Hole[]) {}

  get hole(): Hole {
    return this.holes[this.holeIndex];
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  spectator(id: string): Spectator | undefined {
    return this.spectators.find((s) => s.id === id);
  }

  /** Joins as a player while the lobby has a free seat, otherwise as a spectator. */
  join(id: string, name: string): void {
    if (this.phase === "lobby" && this.players.length < MAX_PLAYERS) this.addPlayer(id, name);
    else this.addSpectator(id, name);
  }

  addSpectator(id: string, name: string): Spectator {
    const spectator = { id, name };
    this.spectators.push(spectator);
    this.hostId ??= id;
    return spectator;
  }

  /** Host action in the lobby: moves someone between the players and the spectators. */
  setSpectator(id: string, spectate: boolean): void {
    if (this.phase !== "lobby") throw new Error("Match already started");
    const player = this.player(id);
    const spectator = this.spectator(id);
    if (spectate && player) {
      this.players = this.players.filter((p) => p !== player);
      this.spectators.push({ id, name: player.name });
    } else if (!spectate && spectator) {
      this.addPlayer(id, spectator.name);
      this.spectators = this.spectators.filter((s) => s !== spectator);
    }
  }

  addPlayer(id: string, name: string): Player {
    if (this.phase !== "lobby") throw new Error("Match already started");
    if (this.players.length >= MAX_PLAYERS) throw new Error("Room is full");
    const used = new Set(this.players.map((p) => p.color));
    const color = BALL_COLORS.find((c) => !used.has(c)) ?? BALL_COLORS[0];
    const player: Player = {
      id,
      name,
      color,
      connected: true,
      dnf: false,
      strokes: [],
      onCourse: false,
      holed: false,
      pickedUp: false,
      x: 0,
      y: 0,
    };
    this.players.push(player);
    this.hostId ??= id;
    return player;
  }

  /** Removes a lobby player or a spectator. */
  removePlayer(id: string): void {
    this.players = this.players.filter((p) => p.id !== id);
    this.spectators = this.spectators.filter((s) => s.id !== id);
    this.reassignHost();
  }

  setConnected(id: string, connected: boolean): void {
    const player = this.player(id);
    if (!player) return;
    player.connected = connected;
    this.reassignHost();
    if (!connected && this.turnId === id && this.phase === "playing") this.advanceTurn();
  }

  markDnf(id: string): void {
    const player = this.player(id);
    if (!player) return;
    player.dnf = true;
    player.connected = false;
    player.onCourse = false;
    this.reassignHost();
    if (this.phase === "playing" && (this.turnId === id || this.turnId === null)) this.advanceTurn();
  }

  /** Host passes to the next connected player, or to a spectator if no player is left. */
  private reassignHost(): void {
    if (this.hostId && (this.player(this.hostId)?.connected || this.spectator(this.hostId))) return;
    this.hostId = this.players.find((p) => p.connected)?.id ?? this.spectators[0]?.id ?? null;
  }

  start(): void {
    if (this.phase !== "lobby" || this.players.length === 0) throw new Error("Cannot start");
    for (const p of this.players) {
      p.strokes = [];
      p.dnf = false;
    }
    this.phase = "playing";
    this.beginHole(0);
  }

  backToLobby(): void {
    this.players = this.players.filter((p) => p.connected);
    for (const p of this.players) {
      p.strokes = [];
      p.dnf = false;
      p.onCourse = false;
      p.holed = false;
      p.pickedUp = false;
    }
    this.phase = "lobby";
    this.holeIndex = 0;
    this.turnId = null;
    this.reassignHost();
  }

  private beginHole(index: number): void {
    this.holeIndex = index;
    this.courseTick = 0;
    for (const p of this.players) {
      p.strokes[index] = 0;
      p.onCourse = false;
      p.holed = false;
      p.pickedUp = false;
      p.x = this.hole.tee[0];
      p.y = this.hole.tee[1];
    }
    this.phase = "playing";
    this.turnId = null;
    this.advanceTurn();
  }

  nextHole(): void {
    if (this.phase !== "holeEnd") return;
    if (this.holeIndex + 1 >= this.holes.length) {
      this.phase = "finished";
      this.turnId = null;
      return;
    }
    this.beginHole(this.holeIndex + 1);
  }

  private isDone(p: Player): boolean {
    return p.dnf || p.holed || p.pickedUp;
  }

  private canPlay(p: Player): boolean {
    return !this.isDone(p) && p.connected;
  }

  /** Round-robin: next player after the current one who can still play this hole. */
  advanceTurn(): void {
    if (this.phase !== "playing") return;
    if (this.players.every((p) => this.isDone(p))) {
      this.phase = "holeEnd";
      this.turnId = null;
      return;
    }
    const n = this.players.length;
    const current = this.players.findIndex((p) => p.id === this.turnId);
    for (let i = 1; i <= n; i++) {
      const candidate = this.players[(current + i + n) % n];
      if (this.canPlay(candidate)) {
        this.turnId = candidate.id;
        this.turnSeq++;
        return;
      }
    }
    // Only disconnected players remain; wait for them to reconnect or become DNF.
    this.turnId = null;
  }

  /** Called when a waiting player reconnects and nobody has the turn. */
  resumeIfIdle(): void {
    if (this.phase === "playing" && this.turnId === null) this.advanceTurn();
  }

  /** Balls physically on the course, in a stable order. */
  courseBalls(): SimBall[] {
    return this.players
      .filter((p) => p.onCourse && !this.isDone(p))
      .map((p) => ({ id: p.id, x: p.x, y: p.y }));
  }

  shoot(id: string, aim: Point): ShotOutcome {
    if (this.phase !== "playing" || this.turnId !== id) throw new Error("Not your turn");
    if (!Number.isFinite(aim[0]) || !Number.isFinite(aim[1])) throw new Error("Bad aim");
    const shooter = this.player(id)!;
    if (!shooter.onCourse) {
      shooter.onCourse = true;
      shooter.x = this.hole.tee[0];
      shooter.y = this.hole.tee[1];
    }
    const start = this.courseBalls();
    const startTick = this.courseTick;
    const result = simulateShot(this.hole, start, id, aim, { startTick });
    this.courseTick += result.ticks;

    for (const ball of result.balls) {
      const p = this.player(ball.id)!;
      p.x = ball.x;
      p.y = ball.y;
      if (ball.holed) {
        p.holed = true;
        p.onCourse = false;
      }
    }
    shooter.strokes[this.holeIndex] += 1;
    if (result.balls.find((b) => b.id === id)?.splashed) shooter.strokes[this.holeIndex] += 1;
    this.applyCap(shooter);
    this.advanceTurn();
    return { shooterId: id, aim, start, startTick, result };
  }

  /** Shot clock ran out: counts as a stroke, ball stays where it is. */
  timeout(id: string): void {
    if (this.phase !== "playing" || this.turnId !== id) return;
    const player = this.player(id)!;
    player.strokes[this.holeIndex] += 1;
    this.applyCap(player);
    this.advanceTurn();
  }

  private applyCap(p: Player): void {
    const strokes = p.strokes[this.holeIndex];
    if (strokes >= MAX_STROKES) {
      p.strokes[this.holeIndex] = MAX_STROKES;
      if (!p.holed) {
        p.pickedUp = true;
        p.onCourse = false;
      }
    }
  }

  total(p: Player): number {
    return p.strokes.reduce((sum, s) => sum + (s ?? 0), 0);
  }

  /** Final ranking: fewest strokes first, DNF last; ties share a place. */
  standings(): { player: Player; total: number; place: number }[] {
    const rows = this.players
      .map((player) => ({ player, total: this.total(player), place: 0 }))
      .sort((a, b) => Number(a.player.dnf) - Number(b.player.dnf) || a.total - b.total);
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      row.place = prev && prev.total === row.total && prev.player.dnf === row.player.dnf ? prev.place : i + 1;
    });
    return rows;
  }
}

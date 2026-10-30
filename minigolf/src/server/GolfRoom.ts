import { type Client, Room } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import type { Point } from "../shared/hole";
import { HOLES } from "../shared/holes";
import { TICK_RATE } from "../shared/physics";
import {
  HOLE_END_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  RECONNECT_SECONDS,
  ROOM_CODE_LENGTH,
  SHOT_TIME_MS,
} from "../shared/rules";
import { GolfState, PlayerState, type ShotMessage, SpectatorState } from "../shared/state";
import { Match } from "./match";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0
const CODES_CHANNEL = "$golf-codes";
/** Pause after a shot animation before the next turn starts. */
const SETTLE_MS = 500;

export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

export class GolfRoom extends Room<{ state: GolfState }> {
  maxClients = MAX_PLAYERS + MAX_SPECTATORS;
  state = new GolfState();
  match = new Match(HOLES);

  /** sessionId → player id. A player keeps their id when rejoining with a new session. */
  private sessions = new Map<string, string>();
  private dnfTimers = new Map<string, Delayed>();
  private turnTimer?: Delayed;
  private holeEndTimer?: Delayed;
  private clockedTurnSeq = -1;
  private animating = false;

  messages = {
    start: (client: Client) => {
      if (this.playerId(client) !== this.match.hostId || this.match.phase !== "lobby") return;
      this.match.start();
      this.changed();
    },

    spectate: (client: Client, message: { id?: unknown; spectate?: unknown }) => {
      if (this.playerId(client) !== this.match.hostId || typeof message?.id !== "string") return;
      try {
        this.match.setSpectator(message.id, message.spectate === true);
      } catch {
        return;
      }
      this.changed();
    },

    shoot: (client: Client, message: { aim?: unknown }) => {
      const id = this.playerId(client);
      const aim = message?.aim;
      if (!id || this.animating || !Array.isArray(aim) || aim.length !== 2) return;
      const point: Point = [Number(aim[0]), Number(aim[1])];
      const holeIndex = this.match.holeIndex;
      let outcome;
      try {
        outcome = this.match.shoot(id, point);
      } catch {
        return;
      }
      this.turnTimer?.clear();
      const shot: ShotMessage = { shooterId: id, holeIndex, aim: point, start: outcome.start };
      this.broadcast("shot", shot);
      // Hold the new state back until clients have watched the ball roll.
      this.animating = true;
      this.clock.setTimeout(() => {
        this.animating = false;
        this.changed();
      }, (outcome.result.ticks / TICK_RATE) * 1000 + SETTLE_MS);
    },

    playAgain: (client: Client) => {
      if (this.playerId(client) !== this.match.hostId || this.match.phase !== "finished") return;
      for (const [sessionId, playerId] of this.sessions) {
        if (!this.match.player(playerId)?.connected && !this.match.spectator(playerId)) this.sessions.delete(sessionId);
      }
      for (const timer of this.dnfTimers.values()) timer.clear();
      this.dnfTimers.clear();
      this.match.backToLobby();
      this.changed();
    },
  };

  async onCreate() {
    this.roomId = await this.generateCode();
    this.state.code = this.roomId;
    this.state.holeCount = HOLES.length;
    this.state.turnMs = SHOT_TIME_MS;
  }

  async onDispose() {
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  onJoin(client: Client, options: { name?: unknown }) {
    const name = normalizeName(options?.name);
    const sameName = (p: { name: string }) => p.name.toLowerCase() === name.toLowerCase();
    const player = this.match.players.find(sameName);

    if (this.match.phase !== "lobby" && player && !player.connected && !player.dnf) {
      // A disconnected player comes back mid-match, identified by nickname.
      for (const [sessionId, playerId] of this.sessions) if (playerId === player.id) this.sessions.delete(sessionId);
      this.sessions.set(client.sessionId, player.id);
      this.reconnected(player.id);
    } else {
      if (player || this.match.spectators.some(sameName)) throw new Error("That name is already taken in this room");
      // Joins as a player while the lobby has a seat; otherwise (full or mid-match) as a spectator.
      this.match.join(client.sessionId, name);
      this.sessions.set(client.sessionId, client.sessionId);
    }
    this.changed();
  }

  onDrop(client: Client) {
    const id = this.playerId(client);
    if (!id || this.match.phase === "lobby" || this.match.spectator(id)) return;
    this.allowReconnection(client, RECONNECT_SECONDS);
    this.disconnected(id);
  }

  onReconnect(client: Client) {
    const id = this.playerId(client);
    if (id) this.reconnected(id);
  }

  onLeave(client: Client) {
    const id = this.playerId(client);
    this.sessions.delete(client.sessionId);
    // Ignore stale sessions of a player who already rejoined under a new one.
    if (!id || [...this.sessions.values()].includes(id)) return;
    if (this.match.phase === "lobby" || this.match.spectator(id)) {
      this.match.removePlayer(id);
      this.changed();
    } else if (this.match.player(id)?.connected || !this.dnfTimers.has(id)) {
      this.disconnected(id);
    }
  }

  private playerId(client: Client): string | undefined {
    return this.sessions.get(client.sessionId);
  }

  private disconnected(id: string) {
    this.match.setConnected(id, false);
    if (!this.dnfTimers.has(id)) {
      this.dnfTimers.set(
        id,
        this.clock.setTimeout(() => {
          this.dnfTimers.delete(id);
          this.match.markDnf(id);
          this.changed();
        }, RECONNECT_SECONDS * 1000),
      );
    }
    this.changed();
  }

  private reconnected(id: string) {
    this.dnfTimers.get(id)?.clear();
    this.dnfTimers.delete(id);
    this.match.setConnected(id, true);
    this.match.resumeIfIdle();
    this.changed();
  }

  /** Mirrors the match into the synced state and drives the turn and hole timers. */
  private changed() {
    if (this.animating) return;
    this.sync();

    const { phase } = this.match;
    if (phase === "playing" && this.match.turnId && this.match.turnSeq !== this.clockedTurnSeq) {
      this.clockedTurnSeq = this.match.turnSeq;
      const { turnId, turnSeq } = this.match;
      this.turnTimer?.clear();
      this.turnTimer = this.clock.setTimeout(() => {
        if (this.animating || this.match.turnSeq !== turnSeq) return;
        this.match.timeout(turnId);
        this.changed();
      }, SHOT_TIME_MS);
    }
    if (phase !== "playing") this.turnTimer?.clear();

    if (phase === "holeEnd" && !this.holeEndTimer) {
      this.holeEndTimer = this.clock.setTimeout(() => {
        this.holeEndTimer = undefined;
        this.match.nextHole();
        this.changed();
      }, HOLE_END_MS);
    }
  }

  private sync() {
    const s = this.state;
    const m = this.match;
    s.phase = m.phase;
    s.hostId = m.hostId ?? "";
    s.holeIndex = m.holeIndex;
    s.turnId = m.turnId ?? "";
    s.turnSeq = m.turnSeq;

    const sameOrder = s.players.length === m.players.length && m.players.every((p, i) => s.players[i].id === p.id);
    if (!sameOrder) {
      s.players.clear();
      for (const p of m.players) s.players.push(new PlayerState({ id: p.id, name: p.name, color: p.color }));
    }
    m.players.forEach((p, i) => {
      const ps = s.players[i];
      ps.name = p.name;
      ps.color = p.color;
      ps.connected = p.connected;
      ps.dnf = p.dnf;
      ps.onCourse = p.onCourse;
      ps.holed = p.holed;
      ps.pickedUp = p.pickedUp;
      ps.x = p.x;
      ps.y = p.y;
      while (ps.strokes.length > p.strokes.length) ps.strokes.pop();
      p.strokes.forEach((value, h) => {
        if (ps.strokes[h] !== value) ps.strokes[h] = value ?? 0;
      });
    });

    const sameSpectators = s.spectators.length === m.spectators.length && m.spectators.every((sp, i) => s.spectators[i].id === sp.id);
    if (!sameSpectators) {
      s.spectators.clear();
      for (const sp of m.spectators) s.spectators.push(new SpectatorState({ id: sp.id, name: sp.name }));
    }
  }

  private async generateCode(): Promise<string> {
    const used = await this.presence.smembers(CODES_CHANNEL);
    let code: string;
    do {
      code = Array.from({ length: ROOM_CODE_LENGTH }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
    } while (used.includes(code));
    await this.presence.sadd(CODES_CHANNEL, code);
    return code;
  }
}

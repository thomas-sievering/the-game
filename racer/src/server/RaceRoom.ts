import { type Client, type Delayed, Room } from "colyseus";
import { BOT_NAMES, type Car, LAP_OPTIONS, MAX_CARS, type Race, TICK_RATE, createRace, retire, standings, stepRace } from "../shared/sim";
import { CarState, type InputMessage, PlayerState, RaceState, SpectatorState } from "../shared/state";
import { type TrackId, isTrackId } from "../shared/tracks";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0
const CODES_CHANNEL = "$racer-codes";
const MAX_NAME_LENGTH = 16;
const MAX_SPECTATORS = 8;
export const RECONNECT_SECONDS = 60;
/** Inputs queued beyond this are dropped so a client that runs fast can't build up lag. */
const MAX_QUEUE = 4;
/** A driver whose inputs stop arriving for this long lets go of the keys. */
const STARVED_TICKS = 8;

export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

interface Driver {
  queue: InputMessage[];
  keys: number;
  ack: number;
  starved: number;
}

export class RaceRoom extends Room<{ state: RaceState }> {
  maxClients = MAX_CARS + MAX_SPECTATORS;
  state = new RaceState();
  race: Race | null = null;
  /** Input queues by car id (the player's session id). */
  private drivers = new Map<string, Driver>();
  /** Retires a driver who stays away too long, keyed by car id. */
  private retireTimers = new Map<string, Delayed>();

  messages = {
    input: (client: Client, m: InputMessage) => {
      const driver = this.drivers.get(client.sessionId);
      const seq = Number(m?.seq);
      const keys = Number(m?.keys);
      if (!driver || !Number.isInteger(seq) || !Number.isInteger(keys) || keys < 0 || keys > 15) return;
      const last = driver.queue.length ? driver.queue[driver.queue.length - 1].seq : driver.ack;
      if (seq <= last) return;
      driver.queue.push({ seq, keys });
      if (driver.queue.length > MAX_QUEUE) driver.queue.splice(0, driver.queue.length - 2);
    },

    track: (client: Client, m: { id?: unknown }) => {
      if (this.isHostInLobby(client) && isTrackId(m?.id)) this.state.track = m.id;
    },
    laps: (client: Client, m: { laps?: unknown }) => {
      const laps = Number(m?.laps);
      if (this.isHostInLobby(client) && LAP_OPTIONS.includes(laps)) this.state.laps = laps;
    },
    bots: (client: Client, m: { count?: unknown }) => {
      const count = Number(m?.count);
      if (!this.isHostInLobby(client) || !Number.isInteger(count) || count < 0) return;
      this.state.bots = Math.min(count, MAX_CARS - this.state.players.length);
    },

    start: (client: Client) => {
      if (!this.isHostInLobby(client) || this.state.players.length + this.state.bots === 0) return;
      const taken = new Set([...this.state.players].map((p) => p.color));
      const free = Array.from({ length: MAX_CARS }, (_, i) => i).filter((c) => !taken.has(c));
      const entrants = [
        ...[...this.state.players].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: false })),
        ...Array.from({ length: this.state.bots }, (_, i) => ({ id: `bot-${i}`, name: BOT_NAMES[free[i]], color: free[i], bot: true })),
      ];
      // Shuffle the grid so the host doesn't always start on pole.
      for (let i = entrants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entrants[i], entrants[j]] = [entrants[j], entrants[i]];
      }
      this.race = createRace(this.state.track as TrackId, this.state.laps, entrants);
      this.drivers.clear();
      for (const p of this.state.players) this.drivers.set(p.id, { queue: [], keys: 0, ack: 0, starved: 0 });
      this.state.cars.clear();
      for (const car of this.race.cars) this.state.cars.push(new CarState({ id: car.id, name: car.name, color: car.color, bot: car.bot }));
      this.state.phase = "racing";
      this.state.startTick = this.race.startTick;
      this.sync(this.race);
      this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE);
    },

    retire: (client: Client) => {
      if (!this.race || this.state.phase !== "racing") return;
      const error = retire(this.race, client.sessionId);
      if (error) client.send("error", error);
    },

    /** Host action after a race: everyone goes back to the lobby for the next one. */
    lobby: (client: Client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "finished") return;
      this.state.phase = "lobby";
      this.state.cars.clear();
      this.race = null;
      this.state.bots = Math.min(this.state.bots, MAX_CARS - this.state.players.length);
    },

    /** Host action in the lobby: moves someone between the drivers and the spectators. */
    spectate: (client: Client, message: { id?: unknown; spectate?: unknown }) => {
      if (!this.isHostInLobby(client)) return;
      const id = String(message?.id);
      const player = this.state.players.find((p) => p.id === id);
      const spectator = this.state.spectators.find((sp) => sp.id === id);
      if (message?.spectate === true && player) {
        this.state.players.splice(this.state.players.indexOf(player), 1);
        this.state.spectators.push(new SpectatorState({ id, name: player.name }));
      } else if (message?.spectate === false && spectator && this.seatFree()) {
        this.state.spectators.splice(this.state.spectators.indexOf(spectator), 1);
        this.addPlayer(id, spectator.name);
      }
    },
  };

  private isHostInLobby(client: Client) {
    return client.sessionId === this.state.hostId && this.state.phase === "lobby";
  }

  private seatFree() {
    return this.state.players.length + this.state.bots < MAX_CARS;
  }

  async onCreate() {
    this.roomId = await this.generateCode();
    this.state.code = this.roomId;
    this.patchRate = 1000 / TICK_RATE;
  }

  async onDispose() {
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  onJoin(client: Client, options: { name?: unknown }) {
    const name = normalizeName(options?.name);
    const sameName = (p: { name: string }) => p.name.toLowerCase() === name.toLowerCase();
    const player = this.state.players.find(sameName);
    if (this.state.phase === "racing" && player && !player.connected) {
      // A disconnected driver comes back mid-race, identified by nickname, and takes over their car.
      const old = player.id;
      player.id = client.sessionId;
      const car = this.race?.cars.find((c) => c.id === old);
      if (car) car.id = client.sessionId;
      const view = this.state.cars.find((c) => c.id === old);
      if (view) view.id = client.sessionId;
      // A fresh page numbers its inputs from 1 again.
      this.drivers.delete(old);
      this.drivers.set(client.sessionId, { queue: [], keys: 0, ack: 0, starved: 0 });
      this.retireTimers.get(old)?.clear();
      this.retireTimers.delete(old);
      this.reconnected(player);
      return;
    }
    if (player || this.state.spectators.some(sameName)) throw new Error("That name is already taken in this room");
    // Joins as a driver while the lobby has a seat; otherwise (full or mid-race) as a spectator.
    if (this.state.phase === "lobby" && this.seatFree()) this.addPlayer(client.sessionId, name);
    else this.state.spectators.push(new SpectatorState({ id: client.sessionId, name }));
    if (!this.state.hostId) this.state.hostId = client.sessionId;
  }

  private addPlayer(id: string, name: string) {
    const taken = new Set([...this.state.players].map((p) => p.color));
    const color = Array.from({ length: MAX_CARS }, (_, i) => i).find((c) => !taken.has(c)) ?? 0;
    this.state.players.push(new PlayerState({ id, name, color }));
  }

  onDrop(client: Client) {
    const player = this.state.players.find((p) => p.id === client.sessionId);
    if (!player || this.state.phase !== "racing") return;
    this.allowReconnection(client, RECONNECT_SECONDS);
    this.disconnected(player);
  }

  onReconnect(client: Client) {
    const player = this.state.players.find((p) => p.id === client.sessionId);
    if (player) this.reconnected(player);
  }

  onLeave(client: Client) {
    const index = this.state.players.findIndex((p) => p.id === client.sessionId);
    const spectator = this.state.spectators.findIndex((sp) => sp.id === client.sessionId);
    if (spectator !== -1) this.state.spectators.splice(spectator, 1);
    else if (index === -1) return;
    else if (this.state.phase !== "racing") this.state.players.splice(index, 1);
    else this.disconnected(this.state.players[index]);
    if (this.state.hostId === client.sessionId) {
      this.state.hostId = this.state.players.find((p) => p.connected && p.id !== client.sessionId)?.id ?? this.state.spectators[0]?.id ?? "";
    }
  }

  private disconnected(player: PlayerState) {
    player.connected = false;
    const id = player.id;
    const car = this.race?.cars.find((c) => c.id === id);
    if (car) car.ghost = true;
    if (this.state.phase !== "racing" || this.retireTimers.has(id)) return;
    this.retireTimers.set(
      id,
      this.clock.setTimeout(() => {
        this.retireTimers.delete(id);
        if (player.connected || !this.race) return;
        retire(this.race, player.id);
      }, RECONNECT_SECONDS * 1000),
    );
  }

  private reconnected(player: PlayerState) {
    player.connected = true;
    const car = this.race?.cars.find((c) => c.id === player.id);
    if (car) car.ghost = false;
    this.retireTimers.get(player.id)?.clear();
    this.retireTimers.delete(player.id);
  }

  private tick() {
    const race = this.race;
    if (!race || this.state.phase !== "racing") return;
    const inputs = new Map<string, number>();
    for (const [id, driver] of this.drivers) {
      const next = driver.queue.shift();
      if (next) {
        driver.keys = next.keys;
        driver.ack = next.seq;
        driver.starved = 0;
      } else if (++driver.starved > STARVED_TICKS) {
        driver.keys = 0;
      }
      inputs.set(id, driver.keys);
    }
    stepRace(race, inputs);
    this.sync(race);
    if (race.over) this.finish(race);
  }

  private finish(race: Race) {
    this.state.phase = "finished";
    this.setSimulationInterval(undefined);
    for (const timer of this.retireTimers.values()) timer.clear();
    this.retireTimers.clear();
    // Players who left during the race are gone now that it's over.
    for (let i = this.state.players.length - 1; i >= 0; i--) if (!this.state.players[i].connected) this.state.players.splice(i, 1);
  }

  private sync(race: Race) {
    this.state.tick = race.tick;
    this.state.endTick = race.endTick;
    const places = new Map(standings(race).map((c, i) => [c.id, i + 1]));
    race.cars.forEach((car: Car, i) => {
      const view = this.state.cars[i];
      if (!view) return;
      const fields = {
        id: car.id,
        x: car.x,
        y: car.y,
        vx: car.vx,
        vy: car.vy,
        hx: car.hx,
        hy: car.hy,
        seg: car.seg,
        boost: car.boost,
        offroad: car.offroad,
        input: car.input,
        ack: this.drivers.get(car.id)?.ack ?? 0,
        cp: car.cp,
        lastLap: car.lastLap,
        bestLap: car.bestLap,
        lapStart: car.lapStart,
        status: car.status,
        finishTick: car.finishTick,
        place: places.get(car.id) ?? 0,
        ghost: car.ghost,
      };
      for (const [key, value] of Object.entries(fields)) if ((view as any)[key] !== value) (view as any)[key] = value;
    });
    if (race.events.length) this.broadcast("fx", race.events.splice(0));
  }

  private async generateCode(): Promise<string> {
    const used = await this.presence.smembers(CODES_CHANNEL);
    let code: string;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
    } while (used.includes(code));
    await this.presence.sadd(CODES_CHANNEL, code);
    return code;
  }
}

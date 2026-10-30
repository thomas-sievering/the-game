import type { ArraySchema } from "@colyseus/schema";
import { type Client, type Delayed, Room } from "colyseus";
import {
  type BuildingId,
  CROP_IDS,
  type CropId,
  type Farm,
  type SabotageId,
  type Side,
  TICK_RATE,
  buy,
  capacity,
  clearRock,
  createFarm,
  fill,
  forfeit,
  growthPercent,
  harvest,
  isRipe,
  isWet,
  netWorth,
  plant,
  build,
  price,
  sabotage,
  sell,
  step,
  weed,
} from "../shared/sim";
import { ContractItemState, ContractState, FarmState, PlayerState, SpectatorState, type TileMessage, TileState } from "../shared/state";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0
const CODES_CHANNEL = "$farm-codes";
const MAX_NAME_LENGTH = 16;
const MAX_SPECTATORS = 8;
export const RECONNECT_SECONDS = 60;

export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

export class FarmRoom extends Room<{ state: FarmState }> {
  maxClients = 2 + MAX_SPECTATORS;
  state = new FarmState();
  farm: Farm | null = null;
  /** Forfeits a player who stays away too long, keyed by side. */
  private forfeitTimers = new Map<number, Delayed>();

  messages = {
    start: (client: Client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby" || this.state.players.length !== 2) return;
      this.farm = createFarm({ seed: Math.floor(Math.random() * 2147483646) + 1 });
      this.state.phase = "playing";
      this.sync(this.farm);
      this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE);
    },

    buy: (client: Client, m: TileMessage) => this.act(client, (farm, side) => buy(farm, side, Number(m?.tile))),
    clear: (client: Client, m: TileMessage) => this.act(client, (farm, side) => clearRock(farm, side, Number(m?.tile))),
    plant: (client: Client, m: TileMessage) => this.act(client, (farm, side) => plant(farm, side, Number(m?.tile), m?.crop as CropId)),
    harvest: (client: Client, m: TileMessage) => this.act(client, (farm, side) => harvest(farm, side, Number(m?.tile))),
    build: (client: Client, m: TileMessage) =>
      this.act(client, (farm, side) => build(farm, side, Number(m?.tile), m?.building as BuildingId)),
    weed: (client: Client, m: TileMessage) => this.act(client, (farm, side) => weed(farm, side, Number(m?.tile))),
    sell: (client: Client, m: { crop?: unknown; count?: unknown }) =>
      this.act(client, (farm, side) => sell(farm, side, m?.crop as CropId, Number(m?.count))),
    fill: (client: Client, m: { id?: unknown }) => this.act(client, (farm, side) => fill(farm, side, Number(m?.id))),
    sabotage: (client: Client, m: { id?: unknown; target?: unknown }) =>
      this.act(client, (farm, side) => {
        const target = typeof m?.target === "number" || typeof m?.target === "string" ? m.target : undefined;
        return sabotage(farm, side, m?.id as SabotageId, target as number | CropId | undefined);
      }),
    concede: (client: Client) =>
      this.act(client, (farm, side) => {
        this.state.endNote = `${this.state.players.find((p) => p.side === side)?.name ?? "A farmer"} gave up`;
        forfeit(farm, side);
        this.finishIfOver(farm);
        return null;
      }),
  };

  /** Applies a player's action to the farm, reporting a refusal back to them. */
  private act(client: Client, action: (farm: Farm, side: Side) => string | null) {
    const player = this.state.players.find((p) => p.id === client.sessionId);
    if (!this.farm || !player || this.state.phase !== "playing") return;
    // Unknown ids from a misbehaving client fail inside the sim; never let them crash the room.
    let error: string | null;
    try {
      error = action(this.farm, player.side as Side);
    } catch {
      error = "That didn't work";
    }
    if (error) client.send("error", error);
    this.sync(this.farm);
  }

  async onCreate() {
    this.roomId = await this.generateCode();
    this.state.code = this.roomId;
  }

  async onDispose() {
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  onJoin(client: Client, options: { name?: unknown }) {
    const name = normalizeName(options?.name);
    const sameName = (p: { name: string }) => p.name.toLowerCase() === name.toLowerCase();
    const player = this.state.players.find(sameName);
    if (this.state.phase === "playing" && player && !player.connected) {
      // A disconnected player comes back mid-match, identified by nickname.
      player.id = client.sessionId;
      this.reconnected(player);
      return;
    }
    if (player || this.state.spectators.some(sameName)) throw new Error("That name is already taken in this room");
    // Joins as a player while the lobby has a seat; otherwise (full or mid-match) as a spectator.
    if (this.state.phase === "lobby" && this.state.players.length < 2) {
      const side = this.state.players.some((p) => p.side === 0) ? 1 : 0;
      this.state.players.push(new PlayerState({ id: client.sessionId, name, side }));
    } else {
      this.state.spectators.push(new SpectatorState({ id: client.sessionId, name }));
    }
    if (!this.state.hostId) this.state.hostId = client.sessionId;
  }

  onDrop(client: Client) {
    const player = this.state.players.find((p) => p.id === client.sessionId);
    if (!player || this.state.phase !== "playing") return;
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
    else if (this.state.phase === "lobby") this.state.players.splice(index, 1);
    else this.disconnected(this.state.players[index]);
    if (this.state.hostId === client.sessionId) {
      this.state.hostId = this.state.players.find((p) => p.connected && p.id !== client.sessionId)?.id ?? this.state.spectators[0]?.id ?? "";
    }
  }

  private disconnected(player: PlayerState) {
    player.connected = false;
    if (this.state.phase !== "playing" || this.forfeitTimers.has(player.side)) return;
    this.forfeitTimers.set(
      player.side,
      this.clock.setTimeout(() => {
        this.forfeitTimers.delete(player.side);
        if (player.connected || !this.farm) return;
        this.state.endNote = `${player.name} left`;
        forfeit(this.farm, player.side as Side);
        this.finishIfOver(this.farm);
      }, RECONNECT_SECONDS * 1000),
    );
  }

  private reconnected(player: PlayerState) {
    player.connected = true;
    this.forfeitTimers.get(player.side)?.clear();
    this.forfeitTimers.delete(player.side);
  }

  private tick() {
    const farm = this.farm;
    if (!farm || this.state.phase !== "playing") return;
    step(farm);
    this.sync(farm);
    this.finishIfOver(farm);
  }

  private finishIfOver(farm: Farm) {
    if (farm.winner === -1 || this.state.phase !== "playing") return;
    this.sync(farm);
    this.state.phase = "finished";
    this.state.winner = farm.winner;
    this.setSimulationInterval(undefined);
    for (const timer of this.forfeitTimers.values()) timer.clear();
    this.forfeitTimers.clear();
  }

  private sync(farm: Farm) {
    this.state.tick = farm.tick;
    for (const view of this.state.players) {
      const side = view.side as Side;
      const player = farm.players[side];
      view.coins = player.coins;
      view.netWorth = netWorth(farm, side);
      view.bought = player.bought;
      view.capacity = capacity(farm, side);
      syncMap(view.barn, player.barn);
      syncMap(view.ready, player.ready);
    }
    farm.tiles.forEach((tile, i) => {
      const fields = {
        terrain: tile.terrain,
        owner: tile.owner,
        value: tile.value,
        crop: tile.crop,
        growth: isRipe(tile) ? 100 : growthPercent(tile),
        building: tile.building,
        wet: isWet(farm, i),
        weeds: tile.weedsUntil > farm.tick,
        guarded: tile.protectedUntil > farm.tick,
        home: tile.home,
      };
      const view = this.state.tiles[i];
      if (!view) this.state.tiles.push(new TileState(fields));
      else for (const [key, value] of Object.entries(fields)) if ((view as any)[key] !== value) (view as any)[key] = value;
    });
    for (const id of CROP_IDS) {
      if (this.state.prices.get(id) !== price(farm, id)) this.state.prices.set(id, price(farm, id));
      const frozen = farm.frozenUntil[id] > farm.tick;
      if (this.state.frozen.get(id) !== frozen) this.state.frozen.set(id, frozen);
    }
    syncContracts(this.state.contracts, farm);
    if (farm.events.length) this.broadcast("fx", farm.events.splice(0));
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

function syncMap(view: { get(key: string): number | undefined; set(key: string, value: number): unknown }, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) if (view.get(key) !== value) view.set(key, value);
}

/** Contracts never change after they appear, so only additions and removals need syncing. */
function syncContracts(view: ArraySchema<ContractState>, farm: Farm) {
  const ids = new Set(farm.contracts.map((c) => c.id));
  for (let i = view.length - 1; i >= 0; i--) if (!ids.has(view[i].id)) view.splice(i, 1);
  for (const contract of farm.contracts) {
    if (view.some((c) => c.id === contract.id)) continue;
    const state = new ContractState({ id: contract.id, reward: contract.reward, expiresAt: contract.expiresAt });
    for (const item of contract.items) state.items.push(new ContractItemState(item));
    view.push(state);
  }
}

import { type ArraySchema, StateView } from "@colyseus/schema";
import { type Client, Room } from "colyseus";
import { STARTER_DECK, deckError } from "../shared/cards";
import { type Battle, type Side, TICK_RATE, createBattle, invest, play, sell, step } from "../shared/sim";
import { LanesState, type PlayMessage, PlayerState, SpectatorState, UnitState } from "../shared/state";

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0
const CODES_CHANNEL = "$lanes-codes";
const MAX_NAME_LENGTH = 16;
const MAX_SPECTATORS = 8;

export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

export class LanesRoom extends Room<{ state: LanesState }> {
  maxClients = 2 + MAX_SPECTATORS;
  state = new LanesState();
  battle: Battle | null = null;
  /** Deck per session id, kept off the synced state so nobody sees another player's deck. */
  decks = new Map<string, string[]>();

  messages = {
    start: (client: Client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby" || this.state.players.length !== 2) return;
      const deckOf = (side: Side) => this.decks.get(this.state.players.find((p) => p.side === side)!.id) ?? STARTER_DECK;
      this.battle = createBattle({ seed: Math.floor(Math.random() * 2147483646) + 1, decks: [deckOf(0), deckOf(1)] });
      this.state.phase = "playing";
      this.sync(this.battle);
      this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE);
    },

    play: (client: Client, message: PlayMessage) => {
      this.act(client, (battle, side) => play(battle, side, Number(message?.hand), message?.cell === undefined ? undefined : Number(message.cell)));
    },

    /** Picks the deck to play with; only before the match starts. */
    deck: (client: Client, deck: unknown) => {
      if (this.state.phase !== "lobby") return;
      const error = deckError(deck);
      if (error) client.send("error", error);
      else this.decks.set(client.sessionId, [...(deck as string[])]);
    },

    sell: (client: Client, message: { cell?: unknown }) => {
      this.act(client, (battle, side) => sell(battle, side, Number(message?.cell)));
    },

    invest: (client: Client) => {
      this.act(client, (battle, side) => invest(battle, side));
    },

    /** Host action in the lobby: moves someone between the players and the spectators. */
    spectate: (client: Client, message: { id?: unknown; spectate?: unknown }) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      const target = this.clients.getById(String(message?.id));
      const player = this.state.players.find((p) => p.id === target?.sessionId);
      const spectator = this.state.spectators.find((sp) => sp.id === target?.sessionId);
      if (!target) return;
      if (message.spectate === true && player) {
        this.state.players.splice(this.state.players.indexOf(player), 1);
        this.state.spectators.push(new SpectatorState({ id: player.id, name: player.name }));
      } else if (message.spectate === false && spectator && this.state.players.length < 2) {
        this.state.spectators.splice(this.state.spectators.indexOf(spectator), 1);
        this.addPlayer(spectator.id, spectator.name);
      }
      this.updateViews();
    },
  };

  /** Applies a player's action to the battle, reporting a refusal back to them. */
  private act(client: Client, action: (battle: Battle, side: Side) => string | null) {
    const player = this.state.players.find((p) => p.id === client.sessionId);
    if (!this.battle || !player || this.state.phase !== "playing") return;
    const error = action(this.battle, player.side as Side);
    if (error) client.send("error", error);
    this.sync(this.battle);
  }

  async onCreate() {
    this.roomId = await this.generateCode();
    this.state.code = this.roomId;
  }

  async onDispose() {
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  onJoin(client: Client, options: { name?: unknown; deck?: unknown }) {
    const name = normalizeName(options?.name);
    const sameName = (p: { name: string }) => p.name.toLowerCase() === name.toLowerCase();
    if (this.state.players.some(sameName) || this.state.spectators.some(sameName)) {
      throw new Error("That name is already taken in this room");
    }
    // A bad deck falls back to the starter deck rather than refusing the join.
    if (!deckError(options?.deck)) this.decks.set(client.sessionId, [...(options.deck as string[])]);
    client.view = new StateView();
    // Joins as a player while the lobby has a seat; otherwise (full or mid-match) as a spectator.
    if (this.state.phase === "lobby" && this.state.players.length < 2) this.addPlayer(client.sessionId, name);
    else this.state.spectators.push(new SpectatorState({ id: client.sessionId, name }));
    if (!this.state.hostId) this.state.hostId = client.sessionId;
    this.updateViews();
  }

  private addPlayer(id: string, name: string) {
    const side = this.state.players.some((p) => p.side === 0) ? 1 : 0;
    this.state.players.push(new PlayerState({ id, name, side }));
  }

  /** Players see their own private fields; spectators see both players'. */
  private updateViews() {
    for (const client of this.clients) {
      const spectating = !this.state.players.some((p) => p.id === client.sessionId);
      for (const player of this.state.players) {
        const visible = spectating || player.id === client.sessionId;
        if (visible && !client.view!.has(player)) client.view!.add(player);
        else if (!visible && client.view!.has(player)) client.view!.remove(player);
      }
    }
  }

  onLeave(client: Client) {
    const index = this.state.players.findIndex((p) => p.id === client.sessionId);
    const spectator = this.state.spectators.findIndex((sp) => sp.id === client.sessionId);
    if (this.state.phase === "lobby") this.decks.delete(client.sessionId);
    if (spectator !== -1) this.state.spectators.splice(spectator, 1);
    else if (index === -1) return;
    else if (this.state.phase === "lobby") this.state.players.splice(index, 1);
    else this.state.players[index].connected = false;
    if (this.state.hostId === client.sessionId) {
      // Host passes to the next player, or to a spectator if no player is left.
      this.state.hostId = this.state.players.find((p) => p.connected)?.id ?? this.state.spectators[0]?.id ?? "";
    }
  }

  private tick() {
    const battle = this.battle;
    if (!battle || this.state.phase !== "playing") return;
    step(battle);
    this.sync(battle);
    if (battle.winner !== -1) {
      this.state.phase = "finished";
      this.state.winner = battle.winner;
      this.setSimulationInterval(undefined);
    }
  }

  private sync(battle: Battle) {
    this.state.tick = battle.tick;
    this.state.shrineOwner = battle.shrine.owner;
    this.state.shrineControl = battle.shrine.control;
    for (const view of this.state.players) {
      const player = battle.players[view.side as Side];
      view.baseHp = player.baseHp;
      view.gold = player.gold;
      view.income = player.income;
      view.investCost = player.investCost;
      syncArray(view.hand, player.hand);
      syncArray(view.grid, player.grid);
      syncArray(view.levels, player.levels);
      for (const [card, tick] of Object.entries(player.ready)) if (view.ready.get(card) !== tick) view.ready.set(card, tick);
    }
    if (battle.events.length) this.broadcast("fx", battle.events.splice(0));
    const alive = new Set<string>();
    for (const unit of battle.units) {
      const key = String(unit.id);
      alive.add(key);
      const view = this.state.units.get(key);
      const fields = { x: unit.x, y: unit.y, hp: unit.hp, hasted: unit.hasteTicks > 0, frozen: unit.frozenTicks > 0, fury: unit.furyTicks > 0 };
      if (view) Object.assign(view, fields);
      else this.state.units.set(key, new UnitState({ id: unit.id, side: unit.side, card: unit.card, maxHp: unit.maxHp, level: unit.level, ...fields }));
    }
    for (const key of [...this.state.units.keys()]) if (!alive.has(key)) this.state.units.delete(key);
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

function syncArray<T>(view: ArraySchema<T>, values: T[]) {
  for (let i = 0; i < values.length; i++) {
    if (i >= view.length) view.push(values[i]);
    else if (view[i] !== values[i]) view[i] = values[i];
  }
  while (view.length > values.length) view.pop();
}

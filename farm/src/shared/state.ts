import { type SchemaType, schema, t } from "@colyseus/schema";

// The whole board is public: both farmers see each other's land, coins and barn.
export const PlayerState = schema(
  {
    id: t.string(),
    name: t.string(),
    side: t.uint8(),
    connected: t.boolean().default(true),
    coins: t.number().default(0),
    netWorth: t.number().default(0),
    bought: t.number().default(0),
    capacity: t.number().default(0),
    barn: t.map("number"),
    /** Tick at which each sabotage, the buyout and the land claim can be used again. */
    ready: t.map("number"),
    /** Far enough behind on net worth that sabotage is cheaper and comeback moves unlock. */
    behind: t.boolean().default(false),
    /** Has set up their one outpost. */
    outpost: t.boolean().default(false),
    /** Researched techs, by id. */
    tech: t.map("boolean"),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const SpectatorState = schema(
  {
    id: t.string(),
    name: t.string(),
  },
  "SpectatorState",
);
export type SpectatorState = SchemaType<typeof SpectatorState>;

export const TileState = schema(
  {
    terrain: t.string(),
    owner: t.int8().default(-1),
    value: t.number().default(0),
    crop: t.string().default(""),
    /** Growth from 0 to 100. */
    growth: t.uint8().default(0),
    building: t.string().default(""),
    wet: t.boolean().default(false),
    weeds: t.boolean().default(false),
    /** Bought out recently, so it can't be bought out again yet. */
    guarded: t.boolean().default(false),
    home: t.boolean().default(false),
  },
  "TileState",
);
export type TileState = SchemaType<typeof TileState>;

export const ContractItemState = schema(
  {
    crop: t.string(),
    count: t.uint8(),
  },
  "ContractItemState",
);
export type ContractItemState = SchemaType<typeof ContractItemState>;

export const ContractState = schema(
  {
    id: t.number(),
    items: t.array(ContractItemState),
    reward: t.number(),
    expiresAt: t.number(),
  },
  "ContractState",
);
export type ContractState = SchemaType<typeof ContractState>;

export const FarmState = schema(
  {
    code: t.string(),
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    tick: t.number().default(0),
    /** -1 while playing, then the winning side or DRAW. */
    winner: t.int8().default(-1),
    /** Why the match ended early, e.g. "Alice gave up"; empty when time ran out. */
    endNote: t.string().default(""),
    players: t.array(PlayerState),
    spectators: t.array(SpectatorState),
    tiles: t.array(TileState),
    /** Current selling price per crop. */
    prices: t.map("number"),
    /** Crops whose price is frozen by a market dump. */
    frozen: t.map("boolean"),
    contracts: t.array(ContractState),
  },
  "FarmState",
);
export type FarmState = SchemaType<typeof FarmState>;

export type Phase = "lobby" | "playing" | "finished";

export interface TileMessage {
  tile: number;
  crop?: string;
  building?: string;
}

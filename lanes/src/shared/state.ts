import { type SchemaType, schema, t } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string(),
    name: t.string(),
    side: t.uint8(),
    connected: t.boolean().default(true),
    baseHp: t.number().default(0),
    // Fields tagged .view() only reach their own player; the opponent can't see your hand, grid or gold.
    gold: t.number().default(0).view(),
    income: t.number().default(0).view(),
    investCost: t.number().default(0).view(),
    hand: t.array("string").view(),
    /** Card id per build cell, "" when empty. */
    grid: t.array("string").view(),
    /** Tick at which each spell can be cast again. */
    ready: t.map("number").view(),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const UnitState = schema(
  {
    id: t.number(),
    side: t.uint8(),
    card: t.string(),
    x: t.float64(),
    y: t.float64(),
    hp: t.number(),
    maxHp: t.number(),
    hasted: t.boolean().default(false),
    frozen: t.boolean().default(false),
  },
  "UnitState",
);
export type UnitState = SchemaType<typeof UnitState>;

export const LanesState = schema(
  {
    code: t.string(),
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    tick: t.number().default(0),
    /** -1 while playing, then the winning side or DRAW. */
    winner: t.int8().default(-1),
    players: t.array(PlayerState),
    units: t.map(UnitState),
  },
  "LanesState",
);
export type LanesState = SchemaType<typeof LanesState>;

export type Phase = "lobby" | "playing" | "finished";

export interface PlayMessage {
  hand: number;
  cell?: number;
}

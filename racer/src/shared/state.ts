import { type SchemaType, schema, t } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string(),
    name: t.string(),
    color: t.uint8().default(0),
    connected: t.boolean().default(true),
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

// Positions and velocities are float64 so the client can replay its own inputs on top of them
// and land exactly where the server will (float32 would round and drift).
export const CarState = schema(
  {
    id: t.string(),
    name: t.string(),
    color: t.uint8().default(0),
    bot: t.boolean().default(false),
    x: t.float64().default(0),
    y: t.float64().default(0),
    vx: t.float64().default(0),
    vy: t.float64().default(0),
    hx: t.float64().default(0),
    hy: t.float64().default(0),
    seg: t.uint16().default(0),
    boost: t.uint8().default(0),
    offroad: t.boolean().default(false),
    input: t.uint8().default(0),
    /** Seq of the owner's last input the server applied. */
    ack: t.uint32().default(0),
    cp: t.uint16().default(0),
    lastLap: t.uint32().default(0),
    bestLap: t.uint32().default(0),
    lapStart: t.uint32().default(0),
    status: t.string().default("racing"),
    finishTick: t.uint32().default(0),
    place: t.uint8().default(0),
    ghost: t.boolean().default(false),
  },
  "CarState",
);
export type CarState = SchemaType<typeof CarState>;

export const RaceState = schema(
  {
    code: t.string(),
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    track: t.string().default("meadow"),
    laps: t.uint8().default(3),
    bots: t.uint8().default(0),
    tick: t.uint32().default(0),
    startTick: t.uint32().default(0),
    endTick: t.uint32().default(0),
    players: t.array(PlayerState),
    spectators: t.array(SpectatorState),
    cars: t.array(CarState),
  },
  "RaceState",
);
export type RaceState = SchemaType<typeof RaceState>;

export type Phase = "lobby" | "racing" | "finished";

/** Sent by a driver every tick: input bits and a running sequence number. */
export interface InputMessage {
  seq: number;
  keys: number;
}

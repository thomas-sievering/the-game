import { type SchemaType, schema, t } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string(),
    name: t.string(),
    color: t.string(),
    connected: t.boolean().default(true),
    dnf: t.boolean().default(false),
    strokes: t.array("number"),
    onCourse: t.boolean().default(false),
    holed: t.boolean().default(false),
    pickedUp: t.boolean().default(false),
    x: t.float64().default(0),
    y: t.float64().default(0),
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

export const GolfState = schema(
  {
    code: t.string(),
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    holeIndex: t.uint8().default(0),
    holeCount: t.uint8().default(0),
    turnId: t.string().default(""),
    /** Changes whenever a new turn starts; clients restart their shot clock on change. */
    turnSeq: t.number().default(0),
    turnMs: t.number().default(0),
    /** Course clock in ticks; moving obstacles are drawn at this pose between shots. */
    courseTick: t.uint32().default(0),
    players: t.array(PlayerState),
    spectators: t.array(SpectatorState),
  },
  "GolfState",
);
export type GolfState = SchemaType<typeof GolfState>;

export type Phase = "lobby" | "playing" | "holeEnd" | "finished";

/** Broadcast when a shot is taken; clients replay it with the shared physics. */
export interface ShotMessage {
  shooterId: string;
  holeIndex: number;
  aim: [number, number];
  start: { id: string; x: number; y: number }[];
  startTick: number;
}

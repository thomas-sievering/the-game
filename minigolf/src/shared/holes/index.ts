import type { Hole } from "../hole";
import warmUp from "./1-warm-up.json";
import dogleg from "./2-dogleg.json";
import bunkers from "./3-bunkers.json";
import waterCrossing from "./4-water-crossing.json";
import theHill from "./5-the-hill.json";
import gauntlet from "./6-gauntlet.json";
import zigZag from "./7-zig-zag.json";
import island from "./8-island.json";
import crosswind from "./9-crosswind.json";
import grandFinale from "./10-grand-finale.json";

export const HOLES = [warmUp, dogleg, bunkers, waterCrossing, theHill, gauntlet, zigZag, island, crosswind, grandFinale] as Hole[];

import type { Hole } from "../hole";
import warmUp from "./1-warm-up.json";
import dogleg from "./2-dogleg.json";
import bunkers from "./3-bunkers.json";
import waterCrossing from "./4-water-crossing.json";
import theHill from "./5-the-hill.json";
import gauntlet from "./6-gauntlet.json";

export const HOLES = [warmUp, dogleg, bunkers, waterCrossing, theHill, gauntlet] as Hole[];

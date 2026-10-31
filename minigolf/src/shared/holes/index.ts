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
import pinball from "./11-pinball.json";
import diamond from "./12-diamond.json";
import ridge from "./13-ridge.json";
import staircase from "./14-staircase.json";
import windmill from "./15-windmill.json";
import lilyPads from "./16-lily-pads.json";
import traffic from "./17-traffic.json";
import bankShot from "./18-bank-shot.json";
import skiJump from "./19-ski-jump.json";
import uphill from "./20-uphill.json";
import crossroads from "./21-crossroads.json";
import riverbank from "./22-riverbank.json";
import twinSpinners from "./23-twin-spinners.json";
import maze from "./24-maze.json";
import wave from "./25-wave.json";
import hourglass from "./26-hourglass.json";
import whirlpool from "./27-whirlpool.json";
import crescent from "./28-crescent.json";
import cascade from "./29-cascade.json";
import clockwork from "./30-clockwork.json";
import frozenPond from "./31-frozen-pond.json";
import wormhole from "./32-wormhole.json";
import speedway from "./33-speedway.json";
import diagonalAlley from "./34-diagonal-alley.json";
import arrowhead from "./35-arrowhead.json";
import ricochet from "./36-ricochet.json";
import portalHop from "./37-portal-hop.json";
import glacier from "./38-glacier.json";
import slingshot from "./39-slingshot.json";
import prism from "./40-prism.json";

/** Every hole; each match draws HOLES_PER_ROUND of them. */
export const HOLES = [
  warmUp,
  dogleg,
  bunkers,
  waterCrossing,
  theHill,
  gauntlet,
  zigZag,
  island,
  crosswind,
  grandFinale,
  pinball,
  diamond,
  ridge,
  staircase,
  windmill,
  lilyPads,
  traffic,
  bankShot,
  skiJump,
  uphill,
  crossroads,
  riverbank,
  twinSpinners,
  maze,
  wave,
  hourglass,
  whirlpool,
  crescent,
  cascade,
  clockwork,
  frozenPond,
  wormhole,
  speedway,
  diagonalAlley,
  arrowhead,
  ricochet,
  portalHop,
  glacier,
  slingshot,
  prism,
] as Hole[];

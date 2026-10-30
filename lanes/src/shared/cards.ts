// Card catalog. Stats are tuning values; times are in sim ticks (20 per second).

export type Role = "melee" | "ranged" | "tank" | "fast" | "splash" | "healer";

/** Body radius per role, in field units; also used to keep allies from stacking. */
export const SIZE: Record<Role, number> = { melee: 15, ranged: 14, tank: 21, fast: 11, splash: 16, healer: 14 };

export interface UnitCard {
  kind: "unit";
  id: string;
  name: string;
  role: Role;
  cost: number;
  /** Gold the opponent earns for each kill. */
  bounty: number;
  hp: number;
  /** Damage per hit, or healing per hit for healers. */
  damage: number;
  range: number;
  /** Field units per second. */
  speed: number;
  attackTicks: number;
  /** Radius around the target that also takes the hit. */
  splash?: number;
  /** Copies spawned each wave. */
  count?: number;
  text: string;
}

export type SpellEffect =
  | { type: "haste"; multiplier: number; ticks: number }
  | { type: "lightning"; targets: number; damage: number }
  | { type: "heal"; amount: number }
  | { type: "freeze"; ticks: number }
  /** Strikes the enemy with the most other enemies around it, hurting everyone in the radius. */
  | { type: "meteor"; damage: number; radius: number }
  /** Multiplies the damage and healing of your units. */
  | { type: "fury"; multiplier: number; ticks: number }
  /** Spawns a unit in every lane right away. */
  | { type: "summon"; card: string };

export interface SpellCard {
  kind: "spell";
  id: string;
  name: string;
  cost: number;
  cooldownTicks: number;
  effect: SpellEffect;
  text: string;
}

export type Card = UnitCard | SpellCard;

const unit = (card: Omit<UnitCard, "kind">): UnitCard => ({ kind: "unit", ...card });
const spell = (card: Omit<SpellCard, "kind">): SpellCard => ({ kind: "spell", ...card });

export const CARDS: Record<string, Card> = Object.fromEntries(
  [
    unit({ id: "footman", name: "Footman", role: "melee", cost: 25, bounty: 5, hp: 120, damage: 12, range: 24, speed: 40, attackTicks: 20, text: "Sturdy melee soldier." }),
    unit({ id: "archer", name: "Archer", role: "ranged", cost: 30, bounty: 6, hp: 60, damage: 10, range: 140, speed: 36, attackTicks: 24, text: "Shoots from range." }),
    unit({ id: "brute", name: "Brute", role: "tank", cost: 50, bounty: 10, hp: 400, damage: 15, range: 24, speed: 26, attackTicks: 30, text: "Slow, soaks up damage." }),
    unit({ id: "runner", name: "Runner", role: "fast", cost: 20, bounty: 4, hp: 50, damage: 8, range: 20, speed: 90, attackTicks: 12, text: "Very fast, fragile." }),
    unit({ id: "bomber", name: "Bomber", role: "splash", cost: 45, bounty: 9, hp: 70, damage: 18, range: 110, speed: 32, attackTicks: 40, splash: 50, text: "Ranged blasts hit groups." }),
    unit({ id: "medic", name: "Medic", role: "healer", cost: 40, bounty: 8, hp: 70, damage: 10, range: 100, speed: 36, attackTicks: 20, text: "Heals the most hurt ally nearby." }),
    unit({ id: "spearman", name: "Spearman", role: "melee", cost: 35, bounty: 7, hp: 140, damage: 16, range: 50, speed: 38, attackTicks: 22, text: "Melee with extra reach." }),
    unit({ id: "swarm", name: "Swarm", role: "fast", cost: 30, bounty: 2, hp: 30, damage: 5, range: 18, speed: 70, attackTicks: 10, count: 3, text: "Three quick critters per wave." }),
    unit({ id: "knight", name: "Knight", role: "melee", cost: 60, bounty: 12, hp: 220, damage: 25, range: 26, speed: 50, attackTicks: 20, text: "Strong and quick melee." }),
    unit({ id: "sniper", name: "Sniper", role: "ranged", cost: 55, bounty: 11, hp: 50, damage: 40, range: 260, speed: 30, attackTicks: 60, text: "Huge range, slow shots." }),
    unit({ id: "golem", name: "Golem", role: "tank", cost: 90, bounty: 18, hp: 900, damage: 30, range: 28, speed: 18, attackTicks: 40, text: "A walking wall." }),
    unit({ id: "catapult", name: "Catapult", role: "splash", cost: 80, bounty: 16, hp: 150, damage: 40, range: 220, speed: 20, attackTicks: 70, splash: 70, text: "Long-range area damage." }),
    spell({ id: "rally", name: "Rally", cost: 40, cooldownTicks: 400, effect: { type: "haste", multiplier: 1.5, ticks: 100 }, text: "All your units +50% speed for 5 s." }),
    spell({ id: "lightning", name: "Lightning", cost: 50, cooldownTicks: 300, effect: { type: "lightning", targets: 3, damage: 60 }, text: "Hits the 3 frontmost enemies for 60." }),
    spell({ id: "mend", name: "Mend", cost: 40, cooldownTicks: 400, effect: { type: "heal", amount: 100 }, text: "Heals all your units by 100." }),
    spell({ id: "meteor", name: "Meteor", cost: 60, cooldownTicks: 400, effect: { type: "meteor", damage: 60, radius: 80 }, text: "Smashes the biggest enemy group for 60." }),
    spell({ id: "fury", name: "Fury", cost: 55, cooldownTicks: 500, effect: { type: "fury", multiplier: 2, ticks: 80 }, text: "Your units deal double damage for 4 s." }),
    spell({ id: "muster", name: "Muster", cost: 50, cooldownTicks: 500, effect: { type: "summon", card: "footman" }, text: "A Footman joins every lane right now." }),
    spell({ id: "frost", name: "Frost", cost: 60, cooldownTicks: 600, effect: { type: "freeze", ticks: 60 }, text: "Freezes all enemy units for 3 s." }),
  ].map((card) => [card.id, card]),
);

/** Cards every new player owns; also the default deck until collections exist. */
export const STARTER_DECK = ["footman", "archer", "brute", "runner", "bomber", "medic", "spearman", "swarm", "rally", "lightning"];

export const DECK_SIZE = 10;
export const MAX_COPIES = 3;

/** Returns why a deck can't be played, or null if it's legal. Every card is open to everyone until unlocks exist. */
export function deckError(deck: unknown): string | null {
  if (!Array.isArray(deck) || deck.length !== DECK_SIZE) return `A deck needs exactly ${DECK_SIZE} cards`;
  const counts = new Map<string, number>();
  for (const id of deck) {
    if (typeof id !== "string" || !Object.hasOwn(CARDS, id)) return "Unknown card in deck";
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (counts.get(id)! > MAX_COPIES) return `At most ${MAX_COPIES} copies of ${CARDS[id].name}`;
  }
  if (!deck.some((id) => CARDS[id].kind === "unit")) return "A deck needs at least one unit";
  return null;
}

export function unitCard(id: string): UnitCard {
  const card = CARDS[id];
  if (card?.kind !== "unit") throw new Error(`Not a unit card: ${id}`);
  return card;
}

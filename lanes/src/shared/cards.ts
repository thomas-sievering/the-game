// Card catalog. Stats are tuning values; times are in sim ticks (20 per second).

export type Role = "melee" | "ranged" | "tank" | "fast" | "splash" | "healer";

/** Body radius per role, in field units; also used to keep allies from stacking. */
export const SIZE: Record<Role, number> = { melee: 15, ranged: 14, tank: 21, fast: 11, splash: 16, healer: 14 };

/** Tech tier a player must have researched before playing the card. */
export type Tier = 1 | 2 | 3;

/** Which layer a unit can attack: units on the ground (and towers), fliers, or both. */
export type Hits = "ground" | "air" | "both";

export interface UnitCard {
  kind: "unit";
  id: string;
  name: string;
  tier: Tier;
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
  /** Flies over the board: ignores ground-only attackers and doesn't hold the shrine. */
  flying?: boolean;
  /** What it can attack; "ground" when unset. Healers heal both. */
  hits?: Hits;
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
  | { type: "summon"; card: string }
  /** Restores your base's health, up to its maximum. */
  | { type: "repair"; amount: number }
  /** Hits the enemy with the most health left. */
  | { type: "smite"; damage: number }
  /** Hurts every enemy unit. */
  | { type: "quake"; damage: number }
  /** Kills every unit on the field, yours included, paying no bounty. */
  | { type: "wipe" };

export interface SpellCard {
  kind: "spell";
  id: string;
  name: string;
  tier: Tier;
  cost: number;
  cooldownTicks: number;
  /** Casts allowed per player per match; unlimited when unset. */
  uses?: number;
  effect: SpellEffect;
  text: string;
}

export type Card = UnitCard | SpellCard;

const unit = (card: Omit<UnitCard, "kind">): UnitCard => ({ kind: "unit", ...card });
const spell = (card: Omit<SpellCard, "kind">): SpellCard => ({ kind: "spell", ...card });

export const CARDS: Record<string, Card> = Object.fromEntries(
  [
    unit({ id: "footman", name: "Footman", tier: 1, role: "melee", cost: 25, bounty: 5, hp: 120, damage: 12, range: 24, speed: 40, attackTicks: 20, text: "Sturdy melee soldier." }),
    unit({ id: "archer", name: "Archer", tier: 1, role: "ranged", cost: 30, bounty: 6, hp: 60, damage: 10, range: 140, speed: 36, attackTicks: 24, hits: "both", text: "Shoots from range. Hits fliers." }),
    unit({ id: "brute", name: "Brute", tier: 2, role: "tank", cost: 50, bounty: 10, hp: 400, damage: 15, range: 24, speed: 26, attackTicks: 30, text: "Slow, soaks up damage." }),
    unit({ id: "runner", name: "Runner", tier: 1, role: "fast", cost: 20, bounty: 4, hp: 50, damage: 8, range: 20, speed: 90, attackTicks: 12, text: "Very fast, fragile." }),
    unit({ id: "bomber", name: "Bomber", tier: 2, role: "splash", cost: 45, bounty: 9, hp: 70, damage: 18, range: 110, speed: 32, attackTicks: 40, splash: 50, text: "Ranged blasts hit groups." }),
    unit({ id: "medic", name: "Medic", tier: 1, role: "healer", cost: 40, bounty: 8, hp: 70, damage: 10, range: 100, speed: 36, attackTicks: 20, text: "Heals the most hurt ally nearby." }),
    unit({ id: "spearman", name: "Spearman", tier: 1, role: "melee", cost: 35, bounty: 7, hp: 140, damage: 16, range: 50, speed: 38, attackTicks: 22, hits: "both", text: "Long reach that hits fliers too." }),
    unit({ id: "swarm", name: "Swarm", tier: 1, role: "fast", cost: 30, bounty: 2, hp: 30, damage: 5, range: 18, speed: 70, attackTicks: 10, count: 3, text: "Three quick critters per wave." }),
    unit({ id: "knight", name: "Knight", tier: 2, role: "melee", cost: 60, bounty: 12, hp: 220, damage: 25, range: 26, speed: 50, attackTicks: 20, text: "Strong and quick melee." }),
    unit({ id: "sniper", name: "Sniper", tier: 2, role: "ranged", cost: 55, bounty: 11, hp: 50, damage: 40, range: 260, speed: 30, attackTicks: 60, hits: "both", text: "Huge range, slow shots. Hits fliers." }),
    unit({ id: "golem", name: "Golem", tier: 3, role: "tank", cost: 90, bounty: 18, hp: 900, damage: 30, range: 28, speed: 18, attackTicks: 40, text: "A walking wall." }),
    unit({ id: "catapult", name: "Catapult", tier: 3, role: "splash", cost: 80, bounty: 16, hp: 150, damage: 40, range: 220, speed: 20, attackTicks: 70, splash: 70, text: "Long-range area damage." }),
    unit({ id: "berserker", name: "Berserker", tier: 1, role: "melee", cost: 45, bounty: 9, hp: 160, damage: 9, range: 22, speed: 46, attackTicks: 9, text: "Frenzied axe, very fast swings." }),
    unit({ id: "wolfrider", name: "Wolf Rider", tier: 2, role: "fast", cost: 45, bounty: 9, hp: 130, damage: 14, range: 24, speed: 80, attackTicks: 16, text: "Fast cavalry that bites back." }),
    unit({ id: "hawk", name: "Hawk", tier: 1, role: "fast", cost: 30, bounty: 6, hp: 70, damage: 14, range: 30, speed: 75, attackTicks: 14, flying: true, hits: "air", text: "Flying hunter that only attacks fliers." }),
    unit({ id: "balloon", name: "Balloon", tier: 2, role: "splash", cost: 55, bounty: 11, hp: 200, damage: 22, range: 20, speed: 24, attackTicks: 40, splash: 45, flying: true, text: "Flies, drops bombs on the ground below." }),
    unit({ id: "drake", name: "Drake", tier: 3, role: "tank", cost: 85, bounty: 17, hp: 420, damage: 26, range: 60, speed: 40, attackTicks: 30, splash: 30, flying: true, hits: "both", text: "Flying fire-breather that hits everything." }),
    spell({ id: "rally", name: "Rally", tier: 1, cost: 40, cooldownTicks: 400, effect: { type: "haste", multiplier: 1.5, ticks: 100 }, text: "All your units +50% speed for 5 s." }),
    spell({ id: "lightning", name: "Lightning", tier: 1, cost: 50, cooldownTicks: 300, effect: { type: "lightning", targets: 3, damage: 60 }, text: "Hits the 3 frontmost enemies for 60." }),
    spell({ id: "mend", name: "Mend", tier: 1, cost: 40, cooldownTicks: 400, effect: { type: "heal", amount: 100 }, text: "Heals all your units by 100." }),
    spell({ id: "meteor", name: "Meteor", tier: 2, cost: 60, cooldownTicks: 400, effect: { type: "meteor", damage: 60, radius: 80 }, text: "Smashes the biggest enemy group for 60." }),
    spell({ id: "fury", name: "Fury", tier: 2, cost: 55, cooldownTicks: 500, effect: { type: "fury", multiplier: 2, ticks: 80 }, text: "Your units deal double damage for 4 s." }),
    spell({ id: "muster", name: "Muster", tier: 2, cost: 50, cooldownTicks: 500, effect: { type: "summon", card: "footman" }, text: "A Footman joins every lane right now." }),
    spell({ id: "frost", name: "Frost", tier: 3, cost: 60, cooldownTicks: 600, effect: { type: "freeze", ticks: 60 }, text: "Freezes all enemy units for 3 s." }),
    spell({ id: "repair", name: "Repair", tier: 2, cost: 70, cooldownTicks: 600, effect: { type: "repair", amount: 150 }, text: "Repairs your fort by 150." }),
    spell({ id: "smite", name: "Smite", tier: 1, cost: 50, cooldownTicks: 400, effect: { type: "smite", damage: 200 }, text: "Strikes the toughest enemy for 200." }),
    spell({ id: "quake", name: "Quake", tier: 2, cost: 60, cooldownTicks: 500, effect: { type: "quake", damage: 30 }, text: "Every enemy unit takes 30." }),
    spell({ id: "cataclysm", name: "Cataclysm", tier: 3, cost: 100, cooldownTicks: 1200, uses: 3, effect: { type: "wipe" }, text: "Destroys every unit on the field, yours too. No bounty." }),
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

/** Whether a unit of this card can attack something flying (or not). */
export function canHit(card: UnitCard, flying: boolean): boolean {
  const hits = card.hits ?? "ground";
  return hits === "both" || (hits === "air") === flying;
}

export function unitCard(id: string): UnitCard {
  const card = CARDS[id];
  if (card?.kind !== "unit") throw new Error(`Not a unit card: ${id}`);
  return card;
}

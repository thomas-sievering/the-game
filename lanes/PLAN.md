# Lanes — plan (draft, awaiting confirmation)

## Goal

A browser-based 1v1 deckbuilding auto battler in the spirit of StarCraft II's "Desert Strike" with a Plants-vs-Zombies-style board, for Thomas and friends, hosted on `nexus` at `lanes.nexus.siever.ing`, built entirely by agents. Something must visibly happen on screen: the battle plays out live while players build. Basic game first; twists later.

## Decisions

- **Platform:** web, desktop only (current Chrome/Firefox/Edge; Safari best effort), mouse + keyboard.
- **Mode:** 1v1 PvP via room code, about 10-minute matches.
- **Core loop:** each player places unit cards on their own build grid. Every wave, each placed unit spawns a copy that walks toward the enemy base and fights automatically. Players never control units directly.
- **Spells/abilities:** cards that are activated, not aimed, and resolve automatically (e.g. "all my units +50% speed for 5 s", "lightning hits the 3 frontmost enemies").
- **Deckbuilding:** persistent collection. Everyone starts with a starter collection, earns cards by playing, and builds a deck from their collection before a match.
- **Accounts:** pick a nickname on first visit; a secret token in localStorage identifies the player. A recovery code moves the account to another browser. No passwords or email.
- **Unlocks:** earned by playing (finishing/winning matches → currency → new cards). No permanent card levels or stat upgrades in the collection (in-match unit levels are separate, see below).
- **Storage:** SQLite file on nexus next to the service.
- **Spectators:** up to 8 per room, on top of the 2 players. Joining a full lobby or a running match makes you a spectator. In the lobby the host can move anyone, themselves included, between players and spectators. The host may be a spectator. Spectators see the battlefield, both bases, both build grids and both players' gold (they receive the hands too, but the UI doesn't show them).
- **Building:** a pad holds one unit card. Playing the same card on it again levels it up, to level 3 at most. Each level adds +50% health, damage/healing and bounty; breach damage stays the card's cost. A pad holding another card refuses new ones; sell it first. Selling a pad gives back half of what its levels cost.
- **Tiers:** every card has a tier (I, II or III). A player starts each match at tier I and may only play cards up to their tier; higher-tier cards in hand show a lock. Researching the next tier costs gold and takes time: tier II 250 gold and 40 s, tier III 500 gold and 60 s, one research at a time (button in the economy panel, shortcut T). Tier I: Footman, Archer, Runner, Medic, Spearman, Swarm, Rally, Lightning, Mend. Tier II: Brute, Bomber, Knight, Sniper, Meteor, Fury, Muster. Tier III: Golem, Catapult, Frost.
- **Unit levels on the field:** level 2 has a silver base rim and two chevrons, level 3 a gold rim, glow and three chevrons, and higher levels are slightly bigger. Pads show the same chevrons and border.
- **Look:** a tabletop war game. A framed game board on a wooden table, with felt lanes, stone forts with banners and a standing-stone shrine. Units are painted miniatures drawn in code, one figure per card, that hop as they walk and topple when they die. Pads are card slots in a wooden tray. The HUD uses wooden plaques, dialogs are paper sheets, and cards are playing cards whose art is the miniature rendered by Pixi.
- **Sound:** small synthesized effects for combat, spells, the shrine, waves, building and the result; a mute button (M) remembered per browser.
- **Tech:** same stack as minigolf: TypeScript everywhere, authoritative Colyseus server, PixiJS client, Vite, shared deterministic simulation module, Vitest + Playwright.
- **Repo & deploy:** `lanes/` folder in this repo next to `minigolf/`; GitHub Actions (`lanes-ci.yml`, `lanes-deploy.yml`) → `/etc/nexus/nexus-deploy lanes` → systemd service + Caddy vhost in `D:\projects\nexus\server-config`, like golf.

## Done when

1. `npm test` passes in CI:
   - simulation unit tests (movement, targeting, melee/ranged combat, death, base damage, spells);
   - determinism test (same inputs → identical battle state after N ticks);
   - economy/wave tests (income, card costs, wave spawning);
   - persistence tests (account creation by token, recovery code, rewards granted once per match, deck validation against the collection).
2. A Playwright test against `https://lanes.nexus.siever.ing`: two browsers create accounts, build decks, A creates a room, B joins by code, both place units and activate a spell, a wave visibly fights, the match ends and both see rewards. Screenshots saved.
3. Thomas and at least one friend finish a full match live and see their new cards afterwards.

## Out of scope (for now)

- 2v2/teams, co-op, bots/AI opponent, matchmaking/ranked.
- Permanent card levels, trading, real money, cosmetics.
- Mobile, gamepads, downloadable builds.
- Aimed/targeted abilities, direct unit control.

## Assumptions (please confirm or correct)

- **Board:** horizontal battlefield, your base on the left, the enemy's mirrored on the right. Each player has a 3-row × 4-column build grid behind their base. A unit's row is the row it spawns and walks in, and front columns spawn slightly ahead. Units can cross rows to reach targets.
- **Win:** destroy the enemy base (1500 HP). A unit that reaches the enemy base breaches it once for damage equal to its card cost and is spent, so each wave is its own push instead of a growing death ball. Bases have a short-range turret. If neither base falls by 10:00, the base with more HP left wins; equal HP is a draw.
- **Shrine:** a neutral capture point sits in the middle of the centre lane. Units standing in it with no enemy units there capture it in 3 s (a held shrine first turns neutral). The owner earns +2 gold per second.
- **Waves:** every 20 s. Each placed unit spawns once per wave, and placements are permanent for the match (Desert Strike rules).
- **Economy:** gold trickles in each second, plus a bounty per kill. Placing a unit costs gold, and so does a spell. Spells also have a cooldown. A player can invest gold for +1 income per second, and each investment costs more.
- **Deck rules:** exactly 10 cards, at most 3 copies of a card, at least one unit. Until unlocks exist every card is open to everyone; the deck is built on its own screen (from the start screen or the lobby), saved in the browser and sent to the server, which falls back to the starter deck if it's invalid.
- **Hand:** your deck is 10 cards; you hold a hand of 4 drawn from it. Playing a card draws the next one, and the deck reshuffles when empty.
- **Content for v1:** 19 cards (12 units: melee, ranged, tank, fast, splash, healer; 7 spells: Rally, Lightning, Mend, Frost, Meteor, Fury, Muster). The starter collection covers 10 of them, so 6 are earned.
- **Rewards:** a fixed amount of coins per finished match (more for a win, nothing for leaving early). Coins buy a choice of 1 of 3 unowned cards.
- **Networking:** the server runs the sim at a fixed 20 ticks/s and syncs unit state. The client interpolates and does not predict. The sim is deterministic so tests and replays are exact.
- **Rooms:** create → 4-letter code → both pick a deck → host starts. A disconnected player has 60 s to rejoin, otherwise they forfeit.

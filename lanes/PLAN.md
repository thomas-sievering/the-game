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
- **Unlocks:** earned by playing (finishing/winning matches → currency → new cards). No card levels or stat upgrades.
- **Storage:** SQLite file on nexus next to the service.
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
- Card levels, trading, real money, cosmetics.
- Mobile, gamepads, downloadable builds.
- Aimed/targeted abilities, direct unit control.

## Assumptions (please confirm or correct)

- **Board:** horizontal battlefield, your base on the left, the enemy's mirrored on the right. Each player has a 3-row × 4-column build grid behind their base. A unit's row is the row it spawns and walks in, and front columns spawn slightly ahead. Units can cross rows to reach targets.
- **Win:** destroy the enemy base (1500 HP). A unit that reaches the enemy base breaches it once for damage equal to its card cost and is spent, so each wave is its own push instead of a growing death ball. Bases have a short-range turret. If neither base falls by 10:00, the base with more HP left wins; equal HP is a draw.
- **Waves:** every 20 s. Each placed unit spawns once per wave, and placements are permanent for the match (Desert Strike rules).
- **Economy:** gold trickles in each second, plus a bounty per kill. Placing a unit costs gold, and so does a spell. Spells also have a cooldown. A player can invest gold for +1 income per second, and each investment costs more. Placing a unit on an occupied cell replaces it.
- **Hand:** your deck is 10 cards; you hold a hand of 4 drawn from it. Playing a card draws the next one, and the deck reshuffles when empty.
- **Content for v1:** about 16 cards (about 12 units: melee, ranged, tank, fast, splash, healer; about 4 spells). The starter collection covers 10 of them, so 6 are earned.
- **Rewards:** a fixed amount of coins per finished match (more for a win, nothing for leaving early). Coins buy a choice of 1 of 3 unowned cards.
- **Networking:** the server runs the sim at a fixed 20 ticks/s and syncs unit state. The client interpolates and does not predict. The sim is deterministic so tests and replays are exact.
- **Rooms:** create → 4-letter code → both pick a deck → host starts. A disconnected player has 60 s to rejoin, otherwise they forfeit.
- **Look & sound:** flat shapes drawn in code and readable unit silhouettes, with a palette distinct from minigolf. Small hit/death/spell effects and a few synthesized sounds.

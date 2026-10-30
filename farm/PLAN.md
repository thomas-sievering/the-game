# Farm — confirmed plan

## Goal

A browser-based 1v1 real-time farming resource game on one shared grid, for Thomas and friends, hosted on `nexus` at `farm.nexus.siever.ing`, built entirely by agents. Two farmers start in opposite corners, buy neutral plots, grow and sell crops, and compete through land, a shared market, contracts and sabotage. Basic game first; twists later.

## Decisions

- **Platform:** web, desktop only (current Chrome/Firefox/Edge; Safari best effort), mouse + keyboard.
- **Mode:** 1v1 PvP via room code, about 10-minute matches.
- **Board:** one shared grid. Each player starts with a few plots in opposite corners and buys neutral plots to expand.
- **Pacing:** real-time. Crops grow on timers and both players act at the same time.
- **Interaction:** the race for land, plus:
  - **Shared market:** selling a crop lowers its price for both players; prices recover over time.
  - **Contracts:** a shared order board (e.g. "deliver 20 wheat"). The first player to fill an order gets its reward.
  - **Sabotage:** paid actions that hurt the opponent's farm.
- **Land stealing:** an enemy tile next to your land can be bought out (see Rules).
- **Win:** the highest net worth (coins + land + buildings) when time runs out.
- **Tech:** same stack as minigolf and lanes: TypeScript everywhere, authoritative Colyseus server, PixiJS client, Vite, shared deterministic simulation module, Vitest + Playwright.
- **Repo & deploy:** `farm/` folder in this repo; GitHub Actions (`farm-ci.yml`, `farm-deploy.yml`) → `/etc/nexus/nexus-deploy farm` → systemd service (port 8812) + Caddy vhost in `D:\projects\nexus\server-config\games.nix`, like golf and lanes.

## Done when

1. `npm test` passes in CI:
   - sim unit tests (plot buying and adjacency, planting, growth, watering, harvest, selling);
   - market tests (price drops on sale, recovers over time, shared between players);
   - contract tests (fill, first one wins, expiry);
   - sabotage tests (each effect and its counter);
   - net-worth and end-of-match tests;
   - determinism test (same inputs → identical state after N ticks).
2. A Playwright test against `https://farm.nexus.siever.ing`: A creates a room, B joins by code, both buy a plot, plant, harvest and sell, one fills a contract, one sabotages the other, one gives up and both see the result screen. Screenshots saved.
3. Thomas and at least one friend finish a full match live.

## Out of scope (for now)

- More than 2 players, teams, bots/AI opponent, matchmaking.
- Accounts, persistence, unlocks between matches.
- Animals, seasons, weather, crafting chains beyond one tier.
- Mobile, gamepads, downloadable builds.

## Rules (v1)

Thomas confirmed these on 2026-10-30 ("fine for now"); numbers are tuning, not promises.

- **Grid:** 16 × 12 tiles, mirrored so both corners are equal. Tiles: grass (normal), rich soil (crops grow faster), rock (needs paying to clear before planting), pond (can't be planted; waters adjacent tiles automatically).
- **Buying land:** you can only buy a neutral tile next to land you own (not diagonally). Each tile costs more than the last one you bought (20 + 5 per tile bought so far), so a fast land-grab gets expensive. Rich soil costs 20 extra.
- **Buyouts:** you can buy an enemy tile next to your land for twice what they paid; they get what they paid back, any crop on it changes hands, and the tile is then worth what you paid (so buying it back costs twice that). Starting tiles and tiles with a building can't be bought out. A bought-out tile is safe for 30 s, and each player can buy out once every 20 s.
- **Crops (v1):** wheat (seed 5, 20 s, sells 14), carrot (12, 35 s, 34), pumpkin (30, 60 s, 85), berries (40, 30 s, 20; grow back in 25 s after harvest). Rich soil grows 50% faster. Click an empty owned tile to plant the selected seed, and click a ripe crop to harvest it into your barn.
- **Watering:** a crop on a dry tile grows at half speed. Tiles next to a pond or a well are always wet. A well is a building you can place.
- **Buildings (v1):** well (waters neighbours), scarecrow (blocks crows in a radius), silo (more barn capacity). Buildings occupy a tile, can't be removed, and count toward net worth. You can't build on your last plot that can grow crops.
- **Barn & selling:** harvested crops go into a limited barn. You can sell any amount at the current market price at any time.
- **Market:** each crop has a base price. Every unit sold lowers its price a few percent for both players, and the price drifts back to base over about 30 s. The current prices and a short price history are always visible.
- **Contracts:** 3 open at a time, a new one every ~45 s. Each asks for N of one or two crops and pays 160% of base price. Each expires after ~90 s. Filling one takes the crops from your barn. The first order is always 2 wheat so the match opens with a race; later orders ask for pricier crops.
- **Sabotage (v1):** each costs coins and has a cooldown.
  - **Crows:** eat the crops on 3 random enemy tiles, ripe ones first. A scarecrow protects tiles within 2.
  - **Weeds:** a 2×2 area of enemy tiles grows at half speed for 30 s. Cleared early by clicking each tile.
  - **Market dump:** throw away 3 of a crop to crash its price to the floor and freeze it there for 20 s.
- **Net worth:** coins + each owned tile at its purchase price + each building at half its cost. Barn stock counts at the current market price, and a planted crop at that price in proportion to how far it has grown. Ties are a draw.
- **Start:** 2×2 owned tiles in each corner, a pond that waters half of them, and 60 coins. Wheat seed is free for a player who can't afford it and has nothing growing or stored, so nobody gets stuck.
- **Networking:** the server runs the sim at a fixed 10 ticks/s and syncs tile and market state. The client sends actions (buy, plant, harvest, sell, build, sabotage, fill contract) and renders the synced state.
- **Rooms:** create → 4-letter code → B joins → host starts. Extra visitors spectate. In the lobby the host can move anyone, themselves included, between farmers and spectators; the host may be a spectator. A disconnected player has 60 s to rejoin (same code and name), otherwise they forfeit. Either player can give up.
- **Look & sound:** flat top-down tiles drawn in code, warm farm palette distinct from minigolf and lanes, each player's land outlined in their colour. Small pop effects on harvest, sale and sabotage, and a few synthesized sounds.

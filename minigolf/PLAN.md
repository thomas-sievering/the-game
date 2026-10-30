# Golf — confirmed plan

## Goal

A browser-based, competitive free-for-all 2D top-down minigolf game for Thomas and friends in Germany, hosted on the Hetzner/NixOS server `nexus` at `golf.nexus.siever.ing`, built entirely by agents. Basic game first; twists later.

## Decisions

- **Platform:** web, desktop only (current Chrome/Firefox/Edge; Safari best effort), mouse + keyboard.
- **Mode:** free-for-all, 1–8 players per room, unique colourblind-friendly ball colour per player.
- **Turns:** classic round-robin; players who have holed out are skipped.
- **Ball collisions:** the moving ball bounces off resting balls; knocked balls move with full physics.
  - Knocked into water/OOB by someone else → returns to its resting spot, no penalty.
  - Knocked into the cup → counts as holed, no extra stroke.
- **Match:** 6 holes, fewest total strokes wins, max 8 strokes per hole (then picked up at 8), 30 s shot timer (timeout counts as a stroke), scoreboard after each hole, final podium, "Play again".
- **Controls:** click toward the target; distance from the ball sets power (capped). On your turn, hover shows a direction line and a power bar that turns red at max. No bounce/trajectory prediction.
- **Holes:** 6 handmade JSON files (easy → tricky) with walls, sand (heavy friction), water/OOB (+1 stroke, ball returns to where it was shot from), and slopes. Each file includes a recorded solution.
- **Rooms:** create → 4-letter code → lobby with nicknames → host starts. No joining after the match starts, except as a spectator. Disconnect: 60 s to rejoin with same code and nickname, otherwise DNF and turns skipped. Host leaves → host passes to the next player. No accounts, no persistence.
- **Spectators:** up to 8 per room, on top of the 8 players. Joining a full lobby or a running match makes you a spectator. In the lobby the host can move anyone, themselves included, between players and spectators. The host may be a spectator. Spectators see the course and scores but cannot shoot.
- **Tech:** TypeScript everywhere. Colyseus server (authoritative, simulates every shot). PixiJS client. Custom shared deterministic physics module used by server and client.
- **Look & sound:** flat shapes drawn in code, soft pastel palette (sage greens, cream, warm wood walls, candy-coloured balls), small effects (e.g. holing out), a few sound effects (hit, wall bounce, cup).
- **Repo & deploy:** own repo in `S:\the-game` → private GitHub repo `thomas-sievering/golf`. GitHub Actions → `/etc/nexus/nexus-deploy` → systemd service + Caddy vhost, added in `D:\projects\nexus\server-config` the same way as floonetwork.

## Done when

1. `npm test` passes in CI:
   - physics unit tests (wall bounces, friction, sand, slopes, water penalty);
   - ball-collision test (a ball hit into a resting ball transfers momentum; both end in the expected positions);
   - determinism test (the same shot gives an identical result in server and client code);
   - solvability test (every hole holes out from its recorded solution in ≤ 8 strokes).
2. A Playwright test against `https://golf.nexus.siever.ing`: browser A creates a room, browser B joins by code, A starts, both play hole 1, and the scoreboard shows both players' strokes. Screenshots saved.
3. Thomas and at least one friend finish a full 6-hole match live and see the podium.

## Out of scope (for now)

- Co-op of any kind, teams.
- Godot and the existing `multiplayer-lobby` app in nexus.
- Downloadable builds, mobile, gamepads.
- Accounts, persistence, level editor, procedural holes.
- Moving obstacles, sabotage items, other twists.
- Simultaneous play (possible later experiment).

## Assumptions

None.

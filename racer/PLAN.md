# Racer — plan

## Goal

A browser-based 2D top-down racing game for Thomas and friends, hosted on `nexus` at `racer.nexus.siever.ing`, built entirely by agents. Drive with the arrow keys and race friends and bots over a few laps.

## Decisions

Thomas asked for these on 2026-10-31:

- **View and controls:** 2D top-down, driven with the arrow keys.
- **Spectators:** a spectator mode like minigolf, lanes and farm.
- **Look:** nice graphics.
- **Tracks:** 3 different maps.
- **Sound:** sound effects and music.
- **Tech and repo:** the same stack and layout as the other games: `racer/` folder, TypeScript everywhere, authoritative Colyseus server, PixiJS client, Vite, shared deterministic simulation, Vitest + Playwright, `racer-ci.yml` and `racer-deploy.yml`.

## Assumptions

Chosen by the agent and not confirmed yet:

- **Players:** 1–8 cars per room. The host can fill empty seats with AI bots (0–7) and can race alone.
- **Rooms:** create → 4-letter code → lobby → host starts, like the other games. Up to 8 spectators on top of the drivers. Joining a full lobby or a running race makes you a spectator. In the lobby the host can move anyone, themselves included, between drivers and spectators. Disconnected drivers have 60 s to rejoin with the same code and name; their car is a see-through ghost meanwhile and retires after that.
- **Lobby options:** the host picks the track (Meadow Ring, Dune Canyon, Neon City) and 1, 2, 3 or 5 laps (default 3). After a race the host takes everyone back to the lobby.
- **Race:** a 3-second start-light countdown, then laps through 8 checkpoints in order (shortcuts and driving backwards don't count). When the first car finishes, the rest have 30 s. The race also ends once every human driver has finished or retired (the Retire button), and after 150 s per lap at most. Results show finish time and best lap.
- **Driving:** arcade physics: ↑ throttle, ↓ brake then reverse, ←/→ steer (WASD works too). Cars drift a little, are much slower off the road, bounce off trees, rocks, buildings, tyre stacks and each other, and stay inside a fence around the map. Each track has 3 boost pads on its straightest stretches.
- **Tracks:** Meadow Ring (sunny countryside, fast sweepers), Dune Canyon (sunset desert, tight hairpins), Neon City (night streets, square corners between buildings, street lamps and headlights).
- **Networking:** the server runs at 30 ticks/s and syncs every car. Each client predicts its own car from its inputs and replays unconfirmed inputs on every server state, so steering feels instant; other cars are interpolated 3 ticks behind.
- **Spectating:** the camera follows the leader; ←/→ or clicking the standings switches car, O toggles a whole-track overview. Drivers who finish or retire can watch the same way.
- **Look & sound:** everything drawn in code (no image files): textured ground per theme, kerbs on bends, skid marks, dust and sparks, a chase camera that zooms out with speed, a minimap, F1-style start lights. Synthesized engine (with fake gear changes), skids, bumps, boosts, lap and finish jingles, and one music loop per track, with a music volume slider and mute (M). Bots race behind the home screen and the lobby.

## Done when

1. `npm test` passes in CI: track geometry, driving physics, collisions, boost pads, lap counting and checkpoints, standings and race end, determinism, and client-prediction replay.
2. A Playwright test against `https://racer.nexus.siever.ing`: A creates a room, B joins, C spectates, A adds bots and picks a track, both drive, the spectator switches cars and the overview, both retire, and everyone sees the results. Screenshots saved.
3. Thomas and at least one friend finish a race live.

## Out of scope (for now)

- Power-ups and weapons, car upgrades, car choice beyond colour.
- Track editor, more than 3 tracks, time trial ghosts, persistence and leaderboards.
- Mobile, gamepads, downloadable builds.

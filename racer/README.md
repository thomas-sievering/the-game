# Racer

Top-down arcade racing for up to 8 drivers, with AI bots and spectators. Arrow keys to drive, three tracks (Meadow Ring, Dune Canyon, Neon City), each with its own look and music. See [PLAN.md](PLAN.md).

## Develop

```sh
npm install
npm run dev        # game server on :2570 + Vite client on :5176
npm test           # simulation tests
npm run typecheck
npm run build      # dist/client (static) + dist/server.js
npm start          # serves the built client and the game server on $PORT (default 2570)
npm run e2e        # Playwright against BASE_URL (default http://localhost:2570, start the server first)
npx tsx scripts/bots.ts 3  # 8 bots race 3 laps on every track; prints lap times and time off the road
```

## Layout

- `src/shared/tracks.ts` – the three tracks: centre-line spline, obstacles, boost pads and starting grid.
- `src/shared/sim.ts` – deterministic car physics, collisions, laps, standings and bots.
- `src/shared/state.ts` – Colyseus schema synced to clients.
- `src/server/RaceRoom.ts` – room codes, lobby, input queues, rejoin, runs the race at 30 ticks/s.
- `src/client/main.ts` – screens, input, own-car prediction, interpolation and HUD.
- `src/client/render.ts` – PixiJS scenery, cars, effects, camera and minimap.
- `src/client/audio.ts` – synthesized engine, effects and music.

## Deploy

Pushing to `master` runs Racer CI; on success Racer Deploy builds a release, activates it on nexus with
`/etc/nexus/nexus-deploy racer`, and runs the end-to-end test against https://racer.nexus.siever.ing.
The systemd service (port 8813), Caddy host and deploy script live in the `nexus` repository (`server-config/games.nix`).

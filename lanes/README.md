# Lanes

1v1 deckbuilding auto battler (Desert Strike meets Plants vs Zombies). See [PLAN.md](PLAN.md).
Playable in-match loop: room codes, a lobby, a hand of 4 cards from a 10-card starter deck, a 3×4 build grid, gold and income, waves every 20 s, 12 units and 4 spells. Accounts, collections and rewards are not built yet.

## Develop

```sh
npm install
npm run dev        # game server on :2568 + Vite client on :5174
npm test           # simulation tests
npm run typecheck
npm run build      # dist/client (static) + dist/server.js
npm start          # serves the built client and the game server on $PORT (default 2568)
npm run e2e        # Playwright against BASE_URL (default http://localhost:2568, start the server first)
```

## Layout

- `src/shared/sim.ts` – deterministic battle simulation.
- `src/shared/state.ts` – Colyseus schema synced to clients.
- `src/server/LanesRoom.ts` – room codes, lobby, runs the sim at 20 ticks/s.
- `src/client/` – PixiJS renderer and UI.

## Deploy

Pushing to `master` runs Lanes CI; on success Lanes Deploy builds a release, activates it on nexus with
`/etc/nexus/nexus-deploy lanes`, and runs the end-to-end test against https://lanes.nexus.siever.ing.
The systemd service (port 8811), Caddy host and deploy script live in the `nexus` repository (`server-config/games.nix`).

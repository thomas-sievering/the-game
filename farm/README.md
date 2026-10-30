# Farm

1v1 real-time farming race on one shared grid. Buy land, grow and sell crops, fill orders, and sabotage your neighbour; the higher net worth after 10 minutes wins. See [PLAN.md](PLAN.md). Live at https://farm.nexus.siever.ing.

## Develop

```sh
npm install
npm run dev        # game server on :2569 + Vite client on :5175
npm test           # simulation tests
npm run typecheck
npm run build      # dist/client (static) + dist/server.js
npm start          # serves the built client and the game server on $PORT (default 2569)
npm run e2e        # Playwright against BASE_URL (default http://localhost:2569, start the server first)
npx tsx scripts/balance.ts 20  # greedy bots play full matches; prints net worth, land and how much the early leader snowballs
```

## Layout

- `src/shared/sim.ts` – deterministic farm simulation: map, land, crops, market, orders, sabotage, tech tree, net worth.
- `src/shared/state.ts` – Colyseus schema synced to clients.
- `src/server/FarmRoom.ts` – room codes, lobby, rejoin, runs the sim at 10 ticks/s.
- `src/client/` – PixiJS board, DOM panel and synthesized sounds.

## Deploy

Pushing to `master` runs Farm CI; on success Farm Deploy builds a release, activates it on nexus with
`/etc/nexus/nexus-deploy farm`, and runs the end-to-end test against https://farm.nexus.siever.ing.
The systemd service (port 8812), Caddy host and deploy script live in the `nexus` repository (`server-config/games.nix`).

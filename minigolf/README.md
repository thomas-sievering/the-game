# Golf

Browser-based, turn-based competitive minigolf for 1–8 friends. Live at https://golf.nexus.siever.ing.

See [PLAN.md](PLAN.md) for the confirmed design.

## Develop

```sh
npm install
npm run dev        # game server on :2567 + Vite client on :5173
npm test           # physics, determinism, solvability and match-rule tests
npm run typecheck
npm run build      # dist/client (static) + dist/server.js
npm start          # serves the built client and the game server on $PORT (default 2567)
npm run e2e        # Playwright against BASE_URL (default http://localhost:2567, start the server first)
```

## Layout

- `src/shared/physics.ts` – deterministic shot simulation used by both server and client.
- `src/shared/holes/*.json` – hole definitions; each has a recorded `solution`.
- `src/server/match.ts` – pure match rules (turns, strokes, penalties, standings).
- `src/server/GolfRoom.ts` – Colyseus room: room codes, reconnects, timers, state sync.
- `src/client/` – PixiJS renderer, UI and synthesized sound.

## Holes

Holes are JSON: `bounds` (fairway polygon, edges are walls), `obstacles` (solid polygons), `zones` (`sand`, `water`, `slope` with `force`), `tee`, `cup`, `par`.
After adding or editing a hole, run `npm run solve -- <file-substring>` to record a solution, then `npm test`.

## Deploy

Pushing to `master` runs CI; on success GitHub Actions builds a release and activates it on nexus with
`/etc/nexus/nexus-deploy golf`, then runs the two-player end-to-end test against production.
The systemd service, Caddy host and deploy script live in the `nexus` repository (`server-config/games.nix`).

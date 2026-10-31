# Agent instructions

- Read PLAN.md before changing gameplay; it records decisions the user confirmed. Its "Assumptions" section is not confirmed yet.
- The client predicts its own car by running `stepCar` from `src/shared/sim.ts`, so the sim must give bit-identical results on server and client: use only `+ - * /`, `Math.sqrt`, `Math.min`/`Math.max`/`Math.floor`, and stable iteration order (no trig, `Math.hypot`, `Math.pow` or `Math.random`). Track generation in `src/shared/tracks.ts` follows the same rule and uses its seeded RNG.
- Synced positions and velocities use `float64`; never switch them to `number`, which sends float32 and breaks prediction.
- Car constants live in `CAR` and race rules at the top of `src/shared/sim.ts`; tracks are control points in `src/shared/tracks.ts`. After changing either, run `npx tsx scripts/bots.ts 3` and check that bots still finish every track with lap times of roughly 15–30 s and almost no time off the road.
- Verify UI changes with `npm run build`, `npm start`, and `npm run e2e`; look at the screenshots in `artifacts/e2e/`.
- The server defaults to port 2570 and Vite to 5176 so racer can run next to the other games.
- Deploy only by pushing to `master`; do not deploy manually over SSH.

# Agent instructions

- Read PLAN.md before changing gameplay; it records decisions the user confirmed.
- The sim must stay deterministic: in `src/shared/sim.ts` use integer maths (`+ - *`, exact `/ 2`, `Math.floor`, `%` on integers), the seeded `random()`, and stable iteration order. No `Math.random` or floats that can round differently.
- Crop, building, sabotage and rules constants live at the top of `src/shared/sim.ts`. After changing balance, run `npx tsx scripts/balance.ts 5` and check that net worth still grows steadily over the 10 minutes.
- Every player action is a sim function that returns an error string or `null`; the room only forwards messages to it. Keep validation in the sim so tests cover it.
- Verify UI changes with `npm run build`, `npm start`, and `npm run e2e`; look at the screenshots in `artifacts/e2e/`.
- The server defaults to port 2569 and Vite to 5175 so farm can run next to minigolf and lanes.
- Deploy only by pushing to `master`; do not deploy manually over SSH.

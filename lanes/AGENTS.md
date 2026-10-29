# Agent instructions

- Read PLAN.md before changing gameplay; it records decisions the user confirmed. Its "Assumptions" section is not confirmed yet.
- The battle sim must stay deterministic: in `src/shared/sim.ts` use only `+ - * /`, `Math.sqrt`, `Math.min`/`Math.max`, and `%` on integers (no trig, `Math.hypot`, or `Math.pow`), and keep iteration order stable.
- Synced positions use `float64`; never switch them to `number`, which sends float32.
- Verify UI changes with `npm run build`, `npm start`, and `npm run e2e`; look at the screenshots in `artifacts/e2e/`.
- Card stats live in `src/shared/cards.ts` and rules constants at the top of `src/shared/sim.ts`. After changing balance, check that random-play matches still mostly last 5–10 minutes.
- The server defaults to port 2568 and Vite to 5174 so lanes can run next to minigolf.

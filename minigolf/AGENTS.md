# Agent instructions

- Read PLAN.md before changing gameplay; it records decisions the user confirmed.
- Physics must stay deterministic: in `src/shared/physics.ts` use only `+ - * /` and `Math.sqrt`, plus `%`/`Math.round` on whole substep counts (no trig, `Math.hypot`, or `Math.pow`; use `turnCosSin` for angles), and keep iteration order stable.
- Synced positions use `float64`; never switch them to `number`, which sends float32 and breaks the client/server desync check.
- After changing physics or a hole, run `npm run solve` for affected holes and `npm test`.
- `npm run rate` plays each hole with a slightly inaccurate bot; use its average to judge difficulty and set par.
- Verify UI changes with `npm run build`, `npm start`, and `npm run e2e`; look at the screenshots in `artifacts/e2e/`.
- Deploy only by pushing to `master`; do not deploy manually over SSH.

# Agent instructions

- Each game lives in its own folder with its own `package.json`, `AGENTS.md` and `PLAN.md`; read the game's `AGENTS.md` before changing it and run npm commands from that folder.
- CI and deploy workflows must live in the root `.github/workflows/`; name them `<game>-*.yml`, filter them to `<game>/**`, and set `working-directory: <game>`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineRoom, defineServer } from "colyseus";
import express from "express";
import { RaceRoom } from "./RaceRoom";

const port = Number(process.env.PORT ?? 2570);
const host = process.env.HOST ?? "0.0.0.0";
const clientDir = process.env.CLIENT_DIR ?? join(import.meta.dirname, "client");

const server = defineServer({
  rooms: {
    racer: defineRoom(RaceRoom),
  },
  express: (app) => {
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    if (existsSync(clientDir)) {
      app.use(express.static(clientDir, { index: "index.html", maxAge: "1h" }));
    }
  },
});

await server.listen(port, host);
console.log(`racer listening on http://${host}:${port}`);

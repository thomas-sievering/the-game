import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineRoom, defineServer } from "colyseus";
import express from "express";
import { GolfRoom } from "./GolfRoom";

const port = Number(process.env.PORT ?? 2567);
const host = process.env.HOST ?? "0.0.0.0";
const clientDir = process.env.CLIENT_DIR ?? join(import.meta.dirname, "client");

const server = defineServer({
  rooms: {
    golf: defineRoom(GolfRoom),
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
console.log(`golf listening on http://${host}:${port}`);

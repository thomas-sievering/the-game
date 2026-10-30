import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineRoom, defineServer } from "colyseus";
import express from "express";
import { FarmRoom } from "./FarmRoom";

const port = Number(process.env.PORT ?? 2569);
const host = process.env.HOST ?? "0.0.0.0";
const clientDir = process.env.CLIENT_DIR ?? join(import.meta.dirname, "client");

const server = defineServer({
  rooms: {
    farm: defineRoom(FarmRoom),
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
console.log(`farm listening on http://${host}:${port}`);

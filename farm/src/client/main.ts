import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import {
  BUILDINGS,
  BUILDING_IDS,
  type BuildingId,
  BUYOUT,
  COLS,
  CROPS,
  CROP_IDS,
  type CropId,
  DRAW,
  BARN_CAPACITY,
  CONTRACTS,
  CROWS,
  DUMP,
  type Fx,
  GROWTH_FULL,
  LAND,
  MARKET,
  MATCH_TICKS,
  ROWS,
  SABOTAGE,
  type SabotageId,
  TICK_RATE,
  WEEDS_TICKS,
  rateFor,
  tileAt,
  tileX,
  tileY,
} from "../shared/sim";
import { FarmState, type PlayerState, type TileState } from "../shared/state";
import { isMuted, sfx, toggleMute } from "./audio";
import { CROP_ICONS, PALETTE, Renderer } from "./render";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2569` : location.origin;
const client = new Client(serverUrl);
const renderer = new Renderer();
/** Resolves once the canvas is ready. Buttons work before that; joining waits for it. */
let rendererReady: Promise<void> = Promise.resolve();

type Tool = CropId | BuildingId;
const TOOLS: Tool[] = [...CROP_IDS, ...BUILDING_IDS];
const BUILDING_ICONS: Record<BuildingId, string> = { well: "🪣", scarecrow: "🧑‍🌾", silo: "🛢️" };
const SABOTAGE_ICONS: Record<SabotageId, string> = { crows: "🐦‍⬛", weeds: "🌿", dump: "📉" };
const HISTORY_LENGTH = 60;
/** Longer help shown in a building's tooltip. */
const BUILDING_HELP: Record<BuildingId, string> = {
  well: "Waters the 8 tiles around it, diagonals included. Crops on dry (cracked) soil grow at half speed, so a well doubles their speed.",
  scarecrow: `Crows can't eat crops within ${CROWS.scarecrowRange} tiles of it (a 5×5 square).`,
  silo: `Your barn holds ${BARN_CAPACITY} more crops. Harvesting stops when the barn is full.`,
};

let room: Room<any, FarmState> | null = null;
let tool: Tool = "wheat";
/** Weeds wait for a target tile after their button is clicked. */
let aimingWeeds = false;
let hovered = -1;
let toastTimer = 0;
/** One price sample per second for each crop's sparkline. */
let history: Record<string, number[]> = {};
let lastSample = -1;
let contractKey = "";
/** The panel element under the mouse whose data-tip is showing, if any. */
let tipTarget: HTMLElement | null = null;
let mouse = { x: 0, y: 0 };

function show(screen: "home" | "lobby" | "game") {
  $("home").classList.toggle("hidden", screen !== "home");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("hud").classList.toggle("hidden", screen !== "game");
}

function me(): PlayerState | undefined {
  return room ? [...room.state.players].find((p) => p.id === room!.sessionId) : undefined;
}

function renderLobby(s: FarmState) {
  show("lobby");
  $("lobby-code").textContent = s.code;
  const isHost = s.hostId === room!.sessionId;
  const seatFree = s.players.length < 2;
  /** Host tag plus, for the host, a button that moves the person to the other list. */
  const rowEnd = (id: string, spectate: boolean) => {
    const tag = id === s.hostId ? '<span class="tag">host</span>' : "";
    const move =
      isHost && (spectate || seatFree)
        ? `<button data-id="${escapeHtml(id)}" data-spectate="${spectate}">${spectate ? "Spectate" : "Play"}</button>`
        : "";
    return `<span class="row-end">${tag}${move}</span>`;
  };
  $("lobby-players-title").textContent = `Farmers ${s.players.length}/2`;
  $("lobby-players").innerHTML = [...s.players].map((p) => `<li>${escapeHtml(p.name)}${rowEnd(p.id, true)}</li>`).join("");
  $("lobby-spectators").innerHTML = [...s.spectators].map((sp) => `<li>👁 ${escapeHtml(sp.name)}${rowEnd(sp.id, false)}</li>`).join("");
  $("lobby-spectators-box").classList.toggle("hidden", s.spectators.length === 0);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#lobby button[data-id]")) {
    button.onclick = () => room?.send("spectate", { id: button.dataset.id, spectate: button.dataset.spectate === "true" });
  }
  $("start").classList.toggle("hidden", !isHost || s.players.length !== 2);
  const spectating = !me() ? "You're spectating. " : "";
  $("lobby-wait").textContent =
    s.players.length < 2 ? `${spectating}Waiting for another farmer…` : isHost ? "" : `${spectating}Waiting for the host to start…`;
}

function render() {
  const s = room?.state;
  if (!s) return show("home");
  if (s.phase === "lobby") return renderLobby(s);
  show("game");
  const self = me();
  const mySide = self?.side ?? 0;
  renderer.mySide = mySide;
  $("spectating").classList.toggle("hidden", !!self);
  for (const id of ["panel", "tools"]) $(id).classList.toggle("hidden", !self);
  $("concede").classList.toggle("hidden", s.phase !== "playing");
  const bySide = (side: number) => [...s.players].find((p) => p.side === side);
  for (const el of document.querySelectorAll<HTMLElement>(".farmer")) {
    const player = bySide(el.dataset.who === "me" ? mySide : 1 - mySide);
    el.querySelector(".farmer-name")!.textContent = `${player?.name ?? "?"}${player && !player.connected ? " · away" : ""}`;
    el.querySelector(".farmer-worth")!.textContent = `${player?.netWorth ?? 0} worth`;
  }
  $("match-time").textContent = clock(Math.max(0, MATCH_TICKS - s.tick));

  sampleHistory(s);
  if (self) {
    $("coins").textContent = `${self.coins} coins`;
    const stored = barnCount(self);
    const silos = [...s.tiles].filter((t) => t.owner === self.side && t.building === "silo").length;
    $("barn-size").textContent = `Barn ${stored}/${self.capacity}`;
    $("barn-size").classList.toggle("full", stored >= self.capacity);
    $("barn-size").dataset.tip =
      `<b>Barn ${stored}/${self.capacity}</b><div class="tip-row">Harvested crops wait here until you sell them or deliver an order.</div>` +
      `<div class="tip-row">Holds ${BARN_CAPACITY}, plus ${BARN_CAPACITY} per silo. You have ${silos} silo${silos === 1 ? "" : "s"}.</div>` +
      (stored >= self.capacity ? `<div class="tip-warn">Full: you can't harvest until you sell.</div>` : "");
    renderTools(self);
    renderMarket(s, self);
    renderContracts(s, self);
    renderSabotage(s, self);
  }
  renderer.setTiles([...s.tiles]);
  updateHint();
  refreshTip();

  $("result").classList.toggle("hidden", s.phase !== "finished");
  if (s.phase === "finished" && !$("result").dataset.shown) {
    $("result").dataset.shown = "1";
    const text = s.winner === DRAW ? "Draw!" : s.winner === self?.side ? "You win!" : `${bySide(s.winner)?.name ?? "Nobody"} wins!`;
    const rows = [...s.players]
      .sort((a, b) => b.netWorth - a.netWorth)
      .map((p) => `<tr><td>${escapeHtml(p.name)}${p.connected ? "" : " (left)"}</td><td>${p.netWorth} worth</td><td>${p.coins} coins</td></tr>`)
      .join("");
    const note = s.endNote ? `<p class="muted">${escapeHtml(s.endNote)}</p>` : "";
    $("result").innerHTML = `<h1>${escapeHtml(text)}</h1>${note}<table>${rows}</table><button id="home-again" class="primary">Back to start</button>`;
    $("home-again").onclick = () => void room?.leave();
    aim(false);
  }
}

function barnCount(player: PlayerState): number {
  return CROP_IDS.reduce((sum, id) => sum + (player.barn.get(id) ?? 0), 0);
}

function cost(t: Tool): number {
  return t in CROPS ? CROPS[t as CropId].seed : BUILDINGS[t as BuildingId].cost;
}

function renderTools(self: PlayerState) {
  for (const button of $("tools").children as HTMLCollectionOf<HTMLButtonElement>) {
    const t = button.dataset.tool as Tool;
    button.classList.toggle("selected", t === tool && !aimingWeeds);
    button.classList.toggle("poor", self.coins < cost(t));
    button.dataset.tip = toolTip(t, self);
  }
}

/** Seconds a crop takes from seed to ripe on a tile like this. */
function growSeconds(crop: CropId, terrain: string, wet: boolean, weeds = false): number {
  return Math.ceil((CROPS[crop].growTicks * GROWTH_FULL) / rateFor(terrain, wet, weeds) / TICK_RATE);
}

function toolTip(t: Tool, self: PlayerState): string {
  const key = `<span class="tip-key">${TOOLS.indexOf(t) + 1}</span>`;
  const poor = self.coins < cost(t) ? `<div class="tip-warn">You need ${cost(t)} coins.</div>` : "";
  if (t in CROPS) {
    const crop = CROPS[t as CropId];
    const now = room?.state.prices.get(crop.id) ?? crop.price;
    const regrow = crop.regrowTicks
      ? `<div class="tip-row">Grows back ${crop.regrowTicks / TICK_RATE} s after each harvest, no replanting.</div>`
      : "";
    return (
      `<b>${CROP_ICONS[crop.id]} ${crop.name} seed · ${crop.seed} coins</b>${key}` +
      `<div class="tip-row">Ripe in ${growSeconds(crop.id, "grass", true)} s watered, ${growSeconds(crop.id, "grass", false)} s dry, ` +
      `${growSeconds(crop.id, "rich", true)} s on watered rich soil.</div>` +
      regrow +
      `<div class="tip-row">Sells for ${now} now (normally ${crop.price}).</div>` +
      `<div class="tip-muted">Click one of your empty plots to plant.</div>${poor}`
    );
  }
  const b = BUILDINGS[t as BuildingId];
  return (
    `<b>${BUILDING_ICONS[b.id]} ${b.name} · ${b.cost} coins</b>${key}<div class="tip-row">${BUILDING_HELP[b.id]}</div>` +
    `<div class="tip-muted">Uses a plot and can't be removed. Adds ${b.cost / 2} to your net worth. ` +
    `Hover your land to preview it.</div>${poor}`
  );
}

function sampleHistory(s: FarmState) {
  const second = Math.floor(s.tick / TICK_RATE);
  if (second === lastSample) return;
  lastSample = second;
  for (const id of CROP_IDS) {
    const list = (history[id] ??= []);
    list.push(s.prices.get(id) ?? CROPS[id].price);
    if (list.length > HISTORY_LENGTH) list.shift();
  }
}

function sparkline(crop: CropId): string {
  const points = history[crop] ?? [];
  const max = CROPS[crop].price;
  const path = points.map((p, i) => `${(i * 100) / (HISTORY_LENGTH - 1)},${16 - (14 * p) / max - 1}`).join(" ");
  return `<svg viewBox="0 0 100 16" preserveAspectRatio="none"><polyline points="${path}" fill="none" stroke="#8a7657" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderMarket(s: FarmState, self: PlayerState) {
  const dumpReady = (self.ready.get("dump") ?? 0) - s.tick;
  for (const row of $("market").children as HTMLCollectionOf<HTMLElement>) {
    const crop = row.dataset.crop as CropId;
    const stock = self.barn.get(crop) ?? 0;
    const price = s.prices.get(crop) ?? 0;
    row.querySelector(".stock")!.textContent = `${stock} in barn`;
    const priceEl = row.querySelector(".price")!;
    priceEl.textContent = String(price);
    priceEl.classList.toggle("low", price < CROPS[crop].price * 0.75);
    priceEl.classList.toggle("frozen", !!s.frozen.get(crop));
    row.querySelector(".spark")!.innerHTML = sparkline(crop);
    row.querySelector<HTMLElement>(".info")!.dataset.tip =
      `<b>${CROP_ICONS[crop]} ${CROPS[crop].name}: ${price} coins</b>` +
      `<div class="tip-row">Normal price ${CROPS[crop].price}. Every unit anyone sells drops it ${MARKET.dropPerUnit / 10}% for both of you, ` +
      `down to ${MARKET.floor / 10}%; it recovers over about ${Math.ceil((MARKET.full - MARKET.floor) / MARKET.recoverPerTick / TICK_RATE)} s.</div>` +
      (s.frozen.get(crop) ? `<div class="tip-warn">❄ Frozen by a market dump.</div>` : "") +
      `<div class="tip-muted">The line shows the last minute.</div>`;
    const sell = row.querySelector<HTMLButtonElement>("button.sell")!;
    sell.disabled = stock === 0;
    sell.textContent = stock ? `Sell ${stock}` : "Sell";
    sell.dataset.tip = stock
      ? `<b>Sell all ${stock} for about ${estimate(price, CROPS[crop].price, stock)} coins</b>` +
        `<div class="tip-muted">The price drops with each unit sold, then recovers.</div>`
      : `You have no ${CROPS[crop].name.toLowerCase()} to sell.`;
    const dump = row.querySelector<HTMLButtonElement>("button.dump")!;
    dump.disabled = stock < DUMP.units || dumpReady > 0 || self.coins < SABOTAGE.dump.cost;
    dump.dataset.tip =
      `<b>${SABOTAGE_ICONS.dump} Market dump · ${SABOTAGE.dump.cost} coins</b>` +
      `<div class="tip-row">Throw away ${DUMP.units} ${CROPS[crop].name.toLowerCase()} to crash its price to ${MARKET.floor / 10}% ` +
      `and freeze it there for ${DUMP.freezeTicks / TICK_RATE} s.</div>` +
      `<div class="tip-muted">Cooldown ${SABOTAGE.dump.cooldownTicks / TICK_RATE} s.</div>` +
      (dumpReady > 0 ? `<div class="tip-warn">Ready in ${Math.ceil(dumpReady / TICK_RATE)} s.</div>` : "") +
      (stock < DUMP.units ? `<div class="tip-warn">You need ${DUMP.units} in your barn.</div>` : "");
  }
}

/** What selling n units at the current price brings in, as the sim prices each unit. */
function estimate(price: number, base: number, n: number): number {
  let factor = (price * 1000) / base;
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Math.max(1, Math.floor((base * factor) / 1000));
    factor = Math.max(250, factor - 40);
  }
  return total;
}

function renderContracts(s: FarmState, self: PlayerState) {
  const key = [...s.contracts].map((c) => c.id).join();
  if (key !== contractKey) {
    contractKey = key;
    $("contracts").innerHTML = [...s.contracts]
      .map(
        (c) =>
          `<div class="contract" data-id="${c.id}"><span class="goods"></span><span class="reward">${c.reward}</span>` +
          `<button class="deliver">Deliver</button><span class="left"></span></div>`,
      )
      .join("");
    for (const el of $("contracts").children as HTMLCollectionOf<HTMLElement>) {
      el.querySelector<HTMLButtonElement>(".deliver")!.onclick = () => room?.send("fill", { id: Number(el.dataset.id) });
    }
    if (!s.contracts.length) $("contracts").innerHTML = '<p class="muted">No orders right now.</p>';
  }
  for (const el of $("contracts").querySelectorAll<HTMLElement>(".contract")) {
    const contract = [...s.contracts].find((c) => c.id === Number(el.dataset.id));
    if (!contract) continue;
    let ready = true;
    el.querySelector(".goods")!.innerHTML = [...contract.items]
      .map((item) => {
        const have = self.barn.get(item.crop) ?? 0;
        if (have < item.count) ready = false;
        return `<span class="${have >= item.count ? "have" : ""}">${CROP_ICONS[item.crop as CropId]} ${Math.min(have, item.count)}/${item.count}</span>`;
      })
      .join(" ");
    el.querySelector<HTMLButtonElement>(".deliver")!.disabled = !ready;
    const worth = [...contract.items].reduce((sum, item) => sum + (s.prices.get(item.crop) ?? 0) * item.count, 0);
    el.dataset.tip =
      `<b>Order: ${contract.reward} coins</b>` +
      `<div class="tip-row">Pays ${CONTRACTS.bonus}% of the normal price. Selling the same goods now would bring about ${worth}.</div>` +
      `<div class="tip-muted">The first farmer to deliver gets it.</div>` +
      (ready ? "" : `<div class="tip-warn">Not enough in your barn yet.</div>`);
    el.querySelector(".left")!.textContent = `${Math.max(0, Math.ceil((contract.expiresAt - s.tick) / TICK_RATE))} s`;
  }
}

function renderSabotage(s: FarmState, self: PlayerState) {
  for (const button of $("sabotage").children as HTMLCollectionOf<HTMLButtonElement>) {
    const id = button.dataset.id as SabotageId;
    const wait = Math.max(0, (self.ready.get(id) ?? 0) - s.tick);
    button.disabled = wait > 0 || self.coins < SABOTAGE[id].cost;
    button.classList.toggle("armed", id === "weeds" && aimingWeeds);
    button.querySelector(".state")!.textContent = wait > 0 ? `${Math.ceil(wait / TICK_RATE)} s` : `${SABOTAGE[id].cost}`;
    const how =
      id === "crows"
        ? `Eat the crops on ${CROWS.count} random enemy tiles, ripe ones first. Crops within ${CROWS.scarecrowRange} tiles of their scarecrow are safe.`
        : `Click, then pick a 2×2 patch of enemy land. Those crops grow at half speed for ${WEEDS_TICKS / TICK_RATE} s unless they pull the weeds tile by tile.`;
    button.dataset.tip =
      `<b>${SABOTAGE_ICONS[id]} ${SABOTAGE[id].name} · ${SABOTAGE[id].cost} coins</b><span class="tip-key">${id[0].toUpperCase()}</span>` +
      `<div class="tip-row">${how}</div><div class="tip-muted">Cooldown ${SABOTAGE[id].cooldownTicks / TICK_RATE} s.</div>` +
      (wait > 0 ? `<div class="tip-warn">Ready in ${Math.ceil(wait / TICK_RATE)} s.</div>` : "") +
      (self.coins < SABOTAGE[id].cost ? `<div class="tip-warn">You need ${SABOTAGE[id].cost} coins.</div>` : "");
  }
}

function tile(index: number): TileState | undefined {
  return room?.state.tiles[index];
}

function bordersMine(index: number, side: number): boolean {
  const x = tileX(index);
  const y = tileY(index);
  const around = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];
  return around.some(([nx, ny]) => nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && tile(ny * COLS + nx)?.owner === side);
}

interface Action {
  type: "buy" | "clear" | "plant" | "harvest" | "build" | "weed" | "weeds";
  text: string;
}

/** What clicking a tile would do with the current tool, if anything. */
function actionFor(index: number): Action | null {
  const self = me();
  const t = tile(index);
  if (!self || !t || room?.state.phase !== "playing") return null;
  const s = room.state;
  if (aimingWeeds) return { type: "weeds", text: `Sow weeds here (${SABOTAGE.weeds.cost} coins)` };
  if (t.owner === self.side) {
    if (t.weeds) return { type: "weed", text: "Pull the weeds" };
    if (t.crop && t.growth >= 100) return { type: "harvest", text: `Harvest ${CROPS[t.crop as CropId].name.toLowerCase()}` };
    if (t.terrain === "rock") return { type: "clear", text: `Clear the rock (${LAND.clear} coins)` };
    if (t.crop || t.building) return null;
    if (tool in CROPS) return { type: "plant", text: `Plant ${CROPS[tool as CropId].name.toLowerCase()} (${cost(tool)} coins)` };
    return { type: "build", text: `Build a ${BUILDINGS[tool as BuildingId].name.toLowerCase()} (${cost(tool)} coins)` };
  }
  if (t.terrain === "pond" || !bordersMine(index, self.side)) return null;
  if (t.owner === -1) {
    const price = LAND.base + self.bought * LAND.step + (t.terrain === "rich" ? LAND.rich : 0);
    return { type: "buy", text: `Buy this ${t.terrain === "rich" ? "rich soil" : t.terrain} for ${price} coins` };
  }
  if (t.home || t.building || t.guarded) return null;
  const wait = Math.max(0, (self.ready.get("buyout") ?? 0) - s.tick);
  const note = wait ? ` · ready in ${Math.ceil(wait / TICK_RATE)} s` : "";
  return { type: "buy", text: `Buy out for ${t.value * BUYOUT.factor} coins (they get ${t.value} back)${note}` };
}

function describe(index: number): string {
  const t = tile(index);
  if (!t) return "";
  const parts: string[] = [];
  if (t.crop) parts.push(t.growth >= 100 ? `Ripe ${CROPS[t.crop as CropId].name.toLowerCase()}` : `${CROPS[t.crop as CropId].name} ${t.growth}%`);
  if (t.building) parts.push(BUILDINGS[t.building as BuildingId].name);
  if (t.terrain === "rich") parts.push("rich soil, grows faster");
  if (t.terrain !== "pond" && t.terrain !== "rock") parts.push(t.wet ? "watered" : "dry, half speed");
  if (t.weeds) parts.push("weeds, half speed");
  if (t.home) parts.push("starting land");
  if (t.guarded) parts.push("just bought out");
  if (t.terrain === "pond") parts.push("pond, waters the tiles around it");
  return parts.join(" · ");
}

/** Tiles within a square radius of a tile, the tile itself included. */
function around(index: number, radius: number): number[] {
  const out: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tileX(index) + dx;
      const y = tileY(index) + dy;
      if (x >= 0 && x < COLS && y >= 0 && y < ROWS) out.push(tileAt(x, y));
    }
  }
  return out;
}

const TERRAIN_NAMES: Record<string, string> = { grass: "Grass", rich: "Rich soil", rock: "Rock", pond: "Pond" };

/** The card shown next to the cursor while hovering a tile. */
function tileTip(index: number): string {
  const t = tile(index);
  const self = me();
  const s = room?.state;
  if (!t || !s) return "";
  const side = self?.side ?? 0;
  const whose = t.owner === -1 ? "neutral" : t.owner === side ? (self ? "yours" : "left farmer") : self ? "theirs" : "right farmer";
  const rows: string[] = [];
  const row = (text: string, cls = "tip-row") => rows.push(`<div class="${cls}">${text}</div>`);
  if (t.terrain === "pond") row("Can't be bought or planted. Waters the 8 tiles around it.");
  else if (t.terrain === "rock") row(`Clear it for ${LAND.clear} coins before you can plant or build.`);
  if (t.crop) {
    const crop = CROPS[t.crop as CropId];
    if (t.growth >= 100) row(`${CROP_ICONS[crop.id]} <b>Ripe ${crop.name.toLowerCase()}</b> · sells for ${s.prices.get(crop.id) ?? crop.price}`);
    else {
      const left = Math.ceil(((100 - t.growth) / 100) * growSeconds(crop.id, t.terrain, t.wet, t.weeds));
      row(`${CROP_ICONS[crop.id]} ${crop.name} ${t.growth}% · ripe in about ${left} s`);
    }
  }
  if (t.building) {
    const b = t.building as BuildingId;
    row(`${BUILDING_ICONS[b]} <b>${BUILDINGS[b].name}</b>: ${BUILDING_HELP[b]}`);
  }
  if (t.terrain !== "pond" && t.terrain !== "rock" && !t.building) {
    const factors: string[] = [];
    if (t.terrain === "rich") factors.push("rich soil ×1.5");
    factors.push(t.wet ? "watered" : "dry ×½");
    if (t.weeds) factors.push("weeds ×½");
    const speed = rateFor(t.terrain, t.wet, t.weeds) / rateFor("grass", true, false);
    row(`Growth speed ${speed === 1 ? "normal" : `×${speed}`} (${factors.join(", ")})`);
    const byWell = around(index, 1).some((n) => n !== index && tile(n)?.building === "well");
    if (t.wet) row(`Watered by ${byWell ? "a well" : "a pond"} next to it.`, "tip-muted");
    else row("Dry: a pond or well next to it would double the speed.", "tip-warn");
    if (t.weeds) row(t.owner === side && self ? "Weeds! Click to pull them." : "Weeds slow this tile down.", "tip-warn");
  }
  if (t.owner !== -1 && t.crop) {
    const safe = around(index, CROWS.scarecrowRange).some((n) => tile(n)?.owner === t.owner && tile(n)?.building === "scarecrow");
    if (safe) row("🧑‍🌾 Safe from crows.", "tip-muted");
  }
  if (t.owner !== -1) {
    if (t.home) row(`Starting land, worth ${t.value}. Can't be bought out.`, "tip-muted");
    else if (t.building) row(`Worth ${t.value}. Land with a building can't be bought out.`, "tip-muted");
    else if (t.guarded) row(`Worth ${t.value}. Just bought out, safe for now.`, "tip-muted");
    else row(`Worth ${t.value}. Buyout price ${t.value * BUYOUT.factor}.`, "tip-muted");
  } else if (t.terrain !== "pond" && self) {
    const price = LAND.base + self.bought * LAND.step + (t.terrain === "rich" ? LAND.rich : 0);
    row(`Costs ${price} coins. You can buy land that touches yours (not diagonally).`, "tip-muted");
  }
  const action = actionFor(index);
  const click = action ? `<div class="tip-action">Click: ${action.text}</div>` : "";
  return `<b>${TERRAIN_NAMES[t.terrain] ?? t.terrain} · ${whose}</b>${rows.join("")}${click}`;
}

/** What hovering a tile highlights: a well's water, a scarecrow's cover or the weeds patch. */
function previewFor(index: number): { tiles: number[]; color: number } | null {
  const t = tile(index);
  if (index === -1 || !t) return null;
  if (aimingWeeds) {
    const x = Math.min(tileX(index), COLS - 2);
    const y = Math.min(tileY(index), ROWS - 2);
    const patch = [tileAt(x, y), tileAt(x + 1, y), tileAt(x, y + 1), tileAt(x + 1, y + 1)];
    return { tiles: patch.filter((n) => tile(n)?.owner === 1 - (me()?.side ?? 0)), color: PALETTE.weeds };
  }
  const building = actionFor(index)?.type === "build" ? tool : t.building;
  if (building === "well") return { tiles: around(index, 1).filter((n) => n !== index && tile(n)?.terrain !== "pond"), color: PALETTE.pond };
  if (building === "scarecrow") return { tiles: around(index, CROWS.scarecrowRange), color: PALETTE.wheat };
  return null;
}

function updateHint() {
  renderer.preview = previewFor(hovered);
  if (aimingWeeds) {
    $("hint").textContent = "Click enemy land to sow a 2×2 patch of weeds · Esc to cancel";
    return;
  }
  const action = hovered === -1 ? null : actionFor(hovered);
  const info = hovered === -1 ? "" : describe(hovered);
  $("hint").textContent = [action?.text, info].filter(Boolean).join(" — ");
}

/** Shows the tooltip for the panel element or board tile under the mouse, next to the cursor. */
function refreshTip() {
  const tip = $("tip");
  if (tipTarget && !document.body.contains(tipTarget)) tipTarget = null;
  const html = tipTarget ? (tipTarget.dataset.tip ?? "") : hovered !== -1 && room?.state.phase === "playing" ? tileTip(hovered) : "";
  tip.classList.toggle("hidden", !html);
  if (!html) return;
  if (tip.innerHTML !== html) tip.innerHTML = html;
  const pad = 14;
  const x = mouse.x + pad + tip.offsetWidth > innerWidth ? mouse.x - pad - tip.offsetWidth : mouse.x + pad;
  const y = mouse.y + pad + tip.offsetHeight > innerHeight ? mouse.y - pad - tip.offsetHeight : mouse.y + pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function clickTile(index: number) {
  const action = actionFor(index);
  if (!action || !room) return;
  if (action.type === "weeds") {
    room.send("sabotage", { id: "weeds", target: index });
    aim(false);
  } else if (action.type === "plant") {
    room.send("plant", { tile: index, crop: tool });
  } else if (action.type === "build") {
    room.send("build", { tile: index, building: tool });
  } else {
    room.send(action.type, { tile: index });
  }
}

function aim(on: boolean) {
  aimingWeeds = on;
  if (room?.state) render();
}

function selectTool(t: Tool) {
  tool = t;
  aim(false);
}

function onFx(events: Fx[]) {
  renderer.addFx(events);
  const side = me()?.side;
  for (const fx of events) {
    const mine = fx.side === side;
    if (fx.type === "harvest" && mine) sfx.harvest();
    else if (fx.type === "sell" && mine) sfx.sell(fx.count);
    else if (fx.type === "buy" && mine) sfx.buy();
    else if (fx.type === "buyout") sfx.buyout();
    else if (fx.type === "contract") {
      sfx.contract();
      if (!mine) toast(`${[...room!.state.players].find((p) => p.side === fx.side)?.name ?? "They"} filled an order`);
    } else if (fx.type === "crows") sfx.crows();
    else if (fx.type === "weeds") sfx.weeds();
    else if (fx.type === "dump") sfx.dump();
  }
}

function toast(message: string) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => $("toast").classList.add("hidden"), 1800);
}

function clock(ticks: number): string {
  const seconds = Math.ceil(ticks / TICK_RATE);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function enter(join: () => Promise<Room<any, FarmState>>) {
  $("home-error").textContent = "";
  localStorage.setItem("farm.name", $<HTMLInputElement>("name").value.trim());
  try {
    await rendererReady;
    room = await join();
  } catch (err) {
    $("home-error").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  history = {};
  lastSample = -1;
  contractKey = "";
  delete $("result").dataset.shown;
  room.onStateChange(render);
  room.onMessage("fx", onFx);
  room.onMessage("error", (message: string) => {
    sfx.error();
    toast(message);
  });
  room.onLeave(() => {
    room = null;
    aim(false);
    render();
  });
  render();
}

function buildPanel() {
  TOOLS.forEach((t, i) => {
    const button = document.createElement("button");
    button.className = "tool";
    button.dataset.tool = t;
    const crop = t in CROPS;
    const icon = crop ? CROP_ICONS[t as CropId] : BUILDING_ICONS[t as BuildingId];
    const name = crop ? CROPS[t as CropId].name : BUILDINGS[t as BuildingId].name;
    button.innerHTML = `<span class="key">${i + 1}</span><span class="icon">${icon}</span><span>${name}</span><span class="cost">${cost(t)}</span>`;
    button.onclick = () => selectTool(t);
    $("tools").appendChild(button);
  });

  $("market").innerHTML = CROP_IDS.map(
    (id) =>
      `<div class="market-row" data-crop="${id}"><span class="info"><span class="icon">${CROP_ICONS[id]}</span>` +
      `<span><div class="name">${CROPS[id].name}</div><div class="stock"></div></span>` +
      `<span><div class="price"></div><div class="spark"></div></span></span>` +
      `<span class="actions"><button class="sell"></button><button class="dump">${SABOTAGE_ICONS.dump}</button></span></div>`,
  ).join("");
  for (const row of $("market").children as HTMLCollectionOf<HTMLElement>) {
    const crop = row.dataset.crop;
    row.querySelector<HTMLButtonElement>(".sell")!.onclick = () => room?.send("sell", { crop, count: 999 });
    row.querySelector<HTMLButtonElement>(".dump")!.onclick = () => room?.send("sabotage", { id: "dump", target: crop });
  }

  for (const id of ["crows", "weeds"] as const) {
    const button = document.createElement("button");
    button.dataset.id = id;
    button.innerHTML = `<span>${SABOTAGE_ICONS[id]} ${SABOTAGE[id].name} <span class="muted">(${id[0].toUpperCase()})</span></span><span class="state"></span>`;
    button.onclick = () => (id === "crows" ? room?.send("sabotage", { id }) : aim(!aimingWeeds));
    $("sabotage").appendChild(button);
  }
  $("sabotage").classList.add("sabotage");
}

function main() {
  rendererReady = renderer.init($("stage"));
  renderer.onTile = clickTile;
  renderer.canAct = (index) => actionFor(index) !== null;
  renderer.onHover = (index) => {
    hovered = index;
    updateHint();
    refreshTip();
  };
  window.addEventListener("mousemove", (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    tipTarget = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null;
    refreshTip();
  });
  buildPanel();
  const muteLabel = () => ($("mute").textContent = isMuted() ? "🔇" : "🔊");
  muteLabel();
  $("mute").onclick = () => {
    toggleMute();
    muteLabel();
  };
  window.addEventListener("keydown", (e) => {
    if (room?.state.phase !== "playing" || e.target instanceof HTMLInputElement) return;
    const n = Number(e.key);
    if (n >= 1 && n <= TOOLS.length) selectTool(TOOLS[n - 1]);
    else if (e.key === "Escape") aim(false);
    else if (e.key.toLowerCase() === "c") room.send("sabotage", { id: "crows" });
    else if (e.key.toLowerCase() === "w") aim(!aimingWeeds);
    else if (e.key.toLowerCase() === "m") {
      toggleMute();
      muteLabel();
    }
  });

  const name = () => ({ name: $<HTMLInputElement>("name").value.trim() });
  $<HTMLInputElement>("name").value = localStorage.getItem("farm.name") ?? "";
  $("create").onclick = () => enter(() => client.create("farm", name(), FarmState));
  $("join").onclick = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    void enter(() => client.joinById(code, name(), FarmState));
  };
  $("start").onclick = () => room?.send("start");
  // Giving up takes a second click; moving the mouse away cancels it.
  $("concede").onclick = () => {
    const button = $("concede");
    if (button.classList.contains("confirm")) {
      room?.send("concede");
      return;
    }
    button.classList.add("confirm");
    button.textContent = "Click again to give up";
  };
  $("concede").onmouseleave = () => {
    $("concede").classList.remove("confirm");
    $("concede").textContent = "Give up";
  };
  render();
}

main();

// Test hook for Playwright.
(window as any).__farm = {
  get phase() {
    return room?.state.phase ?? null;
  },
  get code() {
    return room?.state.code ?? null;
  },
  get side() {
    return me()?.side ?? -1;
  },
  get coins() {
    return me()?.coins ?? 0;
  },
  get barn() {
    return Object.fromEntries(CROP_IDS.map((id) => [id, me()?.barn.get(id) ?? 0]));
  },
  get contracts() {
    return [...(room?.state.contracts ?? [])].map((c) => ({ id: c.id, items: [...c.items].map((i) => ({ crop: i.crop, count: i.count })) }));
  },
  get tiles() {
    return [...(room?.state.tiles ?? [])].map((t) => ({ owner: t.owner, terrain: t.terrain, crop: t.crop, growth: t.growth, weeds: t.weeds }));
  },
  get winner() {
    return room?.state.winner ?? -1;
  },
  get spectating() {
    return !!room && !me();
  },
  tileOnScreen: (index: number) => renderer.tileOnScreen(index),
  /** Sends a raw room message, for e2e steps that would take minutes by mouse. */
  send: (type: string, message: unknown) => room?.send(type, message),
};

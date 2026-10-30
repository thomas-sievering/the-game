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
  DUMP,
  type Fx,
  LAND,
  MATCH_TICKS,
  ROWS,
  SABOTAGE,
  type SabotageId,
  TICK_RATE,
  tileX,
  tileY,
} from "../shared/sim";
import { FarmState, type PlayerState, type TileState } from "../shared/state";
import { isMuted, sfx, toggleMute } from "./audio";
import { CROP_ICONS, Renderer } from "./render";

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
/** The farmer a spectator follows; their panel and side of the board are shown. */
let watchSide = 0;
/** Recent moves of both farmers, newest first, shown to spectators. */
let feed: { side: number; text: string }[] = [];
const FEED_LENGTH = 8;

function show(screen: "home" | "lobby" | "game") {
  $("home").classList.toggle("hidden", screen !== "home");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("hud").classList.toggle("hidden", screen !== "game");
}

function me(): PlayerState | undefined {
  return room ? [...room.state.players].find((p) => p.id === room!.sessionId) : undefined;
}

/** The farmer whose panel is shown: yourself, or the one you watch as a spectator. */
function viewed(): PlayerState | undefined {
  return me() ?? (room ? [...room.state.players].find((p) => p.side === watchSide) : undefined);
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
  const shown = viewed();
  const mySide = shown?.side ?? 0;
  renderer.mySide = mySide;
  $("hud").classList.toggle("spectator", !self);
  $("spectating").classList.toggle("hidden", !!self);
  $("spectating").textContent = shown && !self ? `Watching ${shown.name}` : "Spectating";
  $("panel").classList.toggle("hidden", !shown);
  $("tools").classList.toggle("hidden", !self);
  $("concede").classList.toggle("hidden", s.phase !== "playing" || !self);
  $("versus-box").classList.toggle("hidden", !!self);
  $("feed").classList.toggle("hidden", !!self || !feed.length);
  const bySide = (side: number) => [...s.players].find((p) => p.side === side);
  for (const el of document.querySelectorAll<HTMLElement>(".farmer")) {
    const player = bySide(el.dataset.who === "me" ? mySide : 1 - mySide);
    el.querySelector(".farmer-name")!.textContent = `${player?.name ?? "?"}${player && !player.connected ? " · away" : ""}`;
    el.querySelector(".farmer-worth")!.textContent = `${player?.netWorth ?? 0} worth`;
  }
  $("match-time").textContent = clock(Math.max(0, MATCH_TICKS - s.tick));

  sampleHistory(s);
  if (shown) {
    $("coins").textContent = `${shown.coins} coins`;
    $("barn-size").textContent = `Barn ${barnCount(shown)}/${shown.capacity}`;
    if (self) renderTools(self);
    else renderVersus(s, shown);
    renderMarket(s, shown, !self);
    renderContracts(s, shown, !self);
    renderSabotage(s, shown, !self);
  }
  renderer.setTiles([...s.tiles]);
  updateHint();

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

/** Both farmers side by side for spectators, the watched one first. */
function renderVersus(s: FarmState, shown: PlayerState) {
  const pair = [shown, [...s.players].find((p) => p.side !== shown.side)].filter((p): p is PlayerState => !!p);
  const tiles = [...s.tiles];
  const cooldowns = (p: PlayerState) =>
    (["crows", "weeds", "dump"] as const)
      .map((id) => {
        const wait = Math.max(0, (p.ready.get(id) ?? 0) - s.tick);
        return `<span class="${wait ? "muted" : ""}" title="${SABOTAGE[id].name}">${SABOTAGE_ICONS[id]}${wait ? Math.ceil(wait / TICK_RATE) : "✓"}</span>`;
      })
      .join(" ");
  const rows: [string, (p: PlayerState) => string][] = [
    ["Coins", (p) => String(p.coins)],
    ["Worth", (p) => String(p.netWorth)],
    ["Land", (p) => String(tiles.filter((t) => t.owner === p.side).length)],
    ["Barn", (p) => `${barnCount(p)}/${p.capacity}`],
    [
      "Crops",
      (p) => {
        const mine = tiles.filter((t) => t.owner === p.side && t.crop);
        return `${mine.length} · ${mine.filter((t) => t.growth >= 100).length} ripe`;
      },
    ],
    ["Sabotage", cooldowns],
  ];
  $("versus").innerHTML =
    `<tr><th></th>${pair.map((p, i) => `<th class="${i ? "them" : "me"}">${escapeHtml(p.name)}</th>`).join("")}</tr>` +
    rows.map(([label, cell]) => `<tr><td class="muted">${label}</td>${pair.map((p) => `<td>${cell(p)}</td>`).join("")}</tr>`).join("");
}

/** A spectator-facing line for a farmer's move, or null for moves too frequent to list. */
function feedText(fx: Fx): string | null {
  const name = (side: number) => escapeHtml([...room!.state.players].find((p) => p.side === side)?.name ?? "?");
  const who = name(fx.side);
  const rival = name(1 - fx.side);
  switch (fx.type) {
    case "sell":
      return `${who} sold ${fx.count} ${CROP_ICONS[fx.crop]} for ${fx.coins}`;
    case "buy":
      return `${who} bought land for ${fx.cost}`;
    case "buyout":
      return `${who} bought out ${rival}'s land for ${fx.cost}`;
    case "contract":
      return `${who} filled an order for ${fx.reward}`;
    case "crows":
      return `${who} sent crows at ${rival}`;
    case "weeds":
      return `${who} sowed weeds on ${rival}'s land`;
    case "dump":
      return `${who} dumped ${CROP_ICONS[fx.crop]} on the market`;
    default:
      return null;
  }
}

function renderFeed() {
  const side = viewed()?.side ?? 0;
  $("feed").innerHTML = feed.map((e) => `<li class="${e.side === side ? "me" : "them"}">${e.text}</li>`).join("");
}

function renderTools(self: PlayerState) {
  for (const button of $("tools").children as HTMLCollectionOf<HTMLButtonElement>) {
    const t = button.dataset.tool as Tool;
    button.classList.toggle("selected", t === tool && !aimingWeeds);
    button.classList.toggle("poor", self.coins < cost(t));
  }
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

function renderMarket(s: FarmState, self: PlayerState, readOnly: boolean) {
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
    const sell = row.querySelector<HTMLButtonElement>("button.sell")!;
    sell.disabled = readOnly || stock === 0;
    sell.textContent = stock ? `Sell ${stock}` : "Sell";
    sell.title = stock ? `Sell all ${stock} for about ${estimate(price, CROPS[crop].price, stock)} coins` : "";
    const dump = row.querySelector<HTMLButtonElement>("button.dump")!;
    dump.disabled = readOnly || stock < DUMP.units || dumpReady > 0 || self.coins < SABOTAGE.dump.cost;
    dump.title = `${SABOTAGE.dump.text} Costs ${SABOTAGE.dump.cost} coins.${dumpReady > 0 ? ` Ready in ${Math.ceil(dumpReady / TICK_RATE)} s.` : ""}`;
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

function renderContracts(s: FarmState, self: PlayerState, readOnly: boolean) {
  // Switching the watched farmer rebuilds the list so their stock shows at once.
  const key = `${self.side}:${[...s.contracts].map((c) => c.id).join()}`;
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
    el.querySelector<HTMLButtonElement>(".deliver")!.disabled = readOnly || !ready;
    el.querySelector(".left")!.textContent = `${Math.max(0, Math.ceil((contract.expiresAt - s.tick) / TICK_RATE))} s`;
  }
}

function renderSabotage(s: FarmState, self: PlayerState, readOnly: boolean) {
  for (const button of $("sabotage").children as HTMLCollectionOf<HTMLButtonElement>) {
    const id = button.dataset.id as SabotageId;
    const wait = Math.max(0, (self.ready.get(id) ?? 0) - s.tick);
    button.disabled = readOnly || wait > 0 || self.coins < SABOTAGE[id].cost;
    button.classList.toggle("armed", id === "weeds" && aimingWeeds);
    button.querySelector(".state")!.textContent = wait > 0 ? `${Math.ceil(wait / TICK_RATE)} s` : `${SABOTAGE[id].cost}`;
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

function updateHint() {
  if (aimingWeeds) {
    $("hint").textContent = "Click enemy land to sow a 2×2 patch of weeds · Esc to cancel";
    return;
  }
  const action = hovered === -1 ? null : actionFor(hovered);
  const info = hovered === -1 ? "" : describe(hovered);
  $("hint").textContent = [action?.text, info].filter(Boolean).join(" — ");
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
  const side = viewed()?.side;
  const spectating = !me();
  for (const fx of events) {
    const line = spectating ? feedText(fx) : null;
    if (line) feed.unshift({ side: fx.side, text: line });
    const mine = fx.side === side;
    if (fx.type === "harvest" && mine) sfx.harvest();
    else if (fx.type === "sell" && mine) sfx.sell(fx.count);
    else if (fx.type === "buy" && mine) sfx.buy();
    else if (fx.type === "buyout") sfx.buyout();
    else if (fx.type === "contract") {
      sfx.contract();
      if (!mine && !spectating) toast(`${[...room!.state.players].find((p) => p.side === fx.side)?.name ?? "They"} filled an order`);
    } else if (fx.type === "crows") sfx.crows();
    else if (fx.type === "weeds") sfx.weeds();
    else if (fx.type === "dump") sfx.dump();
  }
  if (spectating) {
    feed = feed.slice(0, FEED_LENGTH);
    renderFeed();
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
  watchSide = 0;
  feed = [];
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
    button.title = crop
      ? `${CROPS[t as CropId].growTicks / TICK_RATE} s to grow, sells for ${CROPS[t as CropId].price}${CROPS[t as CropId].regrowTicks ? ", grows back after harvest" : ""}`
      : BUILDINGS[t as BuildingId].text;
    button.innerHTML = `<span class="key">${i + 1}</span><span class="icon">${icon}</span><span>${name}</span><span class="cost">${cost(t)}</span>`;
    button.onclick = () => selectTool(t);
    $("tools").appendChild(button);
  });

  $("market").innerHTML = CROP_IDS.map(
    (id) =>
      `<div class="market-row" data-crop="${id}"><span class="icon">${CROP_ICONS[id]}</span>` +
      `<span><div class="name">${CROPS[id].name}</div><div class="stock"></div></span>` +
      `<span><div class="price"></div><div class="spark"></div></span>` +
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
    button.title = SABOTAGE[id].text;
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
  };
  buildPanel();
  // Spectators click the other farmer's name to follow them instead.
  document.querySelector<HTMLElement>('.farmer[data-who="them"]')!.onclick = () => {
    if (!room || me()) return;
    watchSide = 1 - watchSide;
    render();
    renderFeed();
  };
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
  get watching() {
    return viewed()?.name ?? null;
  },
  get spectating() {
    return !!room && !me();
  },
  tileOnScreen: (index: number) => renderer.tileOnScreen(index),
  /** Sends a raw room message, for e2e steps that would take minutes by mouse. */
  send: (type: string, message: unknown) => room?.send(type, message),
};

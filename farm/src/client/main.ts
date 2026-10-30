import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import {
  BEHIND,
  BRANCHES,
  BRANCH_IDS,
  BUILDINGS,
  BUILDING_IDS,
  type BuildingId,
  BUYOUT,
  CLAIM,
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
  GOATS,
  GROWTH_FULL,
  LAND,
  MARKET,
  MATCH_TICKS,
  OUTPOST,
  ROWS,
  RUSTLERS,
  SABOTAGE,
  type SabotageId,
  TAX,
  TECH,
  TECH_IDS,
  TICK_RATE,
  TRADE,
  type TechId,
  WEEDS_TICKS,
  landTax,
  rateFor,
  sabotageCost,
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

/** Crops and buildings, picked with the number keys, plus the one-off outpost (O). */
type Tool = CropId | BuildingId | "outpost";
const TOOLS: (CropId | BuildingId)[] = [...CROP_IDS, ...BUILDING_IDS];
const BUILDING_ICONS: Record<BuildingId, string> = { well: "🪣", scarecrow: "🧑‍🌾", silo: "🛢️", goats: "🐐" };
const SABOTAGE_ICONS: Record<SabotageId, string> = { crows: "🐦‍⬛", weeds: "🌿", dump: "📉", rustlers: "🤠" };
const OUTPOST_ICON = "🚩";
const CLAIM_ICON = "📜";
/** The sabotage panel's buttons; a land claim works like a sabotage but is priced per tile. */
type Move = "crows" | "weeds" | "rustlers" | "claim";
const MOVES: Move[] = ["crows", "weeds", "rustlers", "claim"];
const MOVE_KEYS: Record<Move, string> = { crows: "C", weeds: "W", rustlers: "R", claim: "L" };
const HISTORY_LENGTH = 60;
/** Longer help shown in a building's tooltip. */
const BUILDING_HELP: Record<BuildingId, string> = {
  well: "Waters the 8 tiles around it, diagonals included. Crops on dry (cracked) soil grow at half speed, so a well doubles their speed.",
  scarecrow: `Crows can't eat crops within ${CROWS.scarecrowRange} tiles of it (a 5×5 square).`,
  silo: `Your barn holds ${BARN_CAPACITY} more crops. Harvesting stops when the barn is full.`,
  goats:
    `Every ${GOATS.everyTicks / TICK_RATE} s its goat eats the nearest enemy crop within ${GOATS.range} tiles, ripe ones first. ` +
    "Fences keep goats out. Unlike other buildings, a goat pen can be bought out, goat and all.",
};

let room: Room<any, FarmState> | null = null;
let tool: Tool = "wheat";
/** Weeds and land claims wait for a target tile after their button is clicked. */
type Aim = "" | "weeds" | "claim";
let aiming: Aim = "";
let hovered = -1;
let toastTimer = 0;
/** One price sample per second for each crop's sparkline. */
let history: Record<string, number[]> = {};
let lastSample = -1;
let contractKey = "";
/** Whose tech tree is open, by side, or -1 when it's closed. */
let techSide = -1;
/** The farmer a spectator follows; their panel and side of the board are shown. */
let watchSide = 0;
/** Recent moves of both farmers, newest first, shown to spectators. */
let feed: { side: number; text: string }[] = [];
const FEED_LENGTH = 8;
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
    el.querySelector(".farmer-worth")!.textContent = `${player?.netWorth ?? 0} worth${player?.behind ? " · behind" : ""}`;
    el.classList.toggle("behind", !!player?.behind);
    const badge = el.querySelector<HTMLButtonElement>(".tech-badge")!;
    badge.dataset.side = String(player?.side ?? -1);
    badge.textContent = `🔬 ${player ? techCount(player) : 0}/${TECH_IDS.length}`;
    badge.classList.toggle("open", !!player && techSide === player.side);
  }
  $("match-time").textContent = clock(Math.max(0, MATCH_TICKS - s.tick));

  sampleHistory(s);
  if (shown) {
    $("coins").textContent = `${shown.coins} coins`;
    const stored = barnCount(shown);
    const silos = [...s.tiles].filter((t) => t.owner === shown.side && t.building === "silo").length;
    $("barn-size").textContent = `Barn ${stored}/${shown.capacity}`;
    $("barn-size").classList.toggle("full", stored >= shown.capacity);
    $("barn-size").dataset.tip =
      `<b>Barn ${stored}/${shown.capacity}</b><div class="tip-row">Harvested crops wait here until you sell them or deliver an order.</div>` +
      `<div class="tip-row">Holds ${BARN_CAPACITY}, plus ${BARN_CAPACITY} per silo. You have ${silos} silo${silos === 1 ? "" : "s"}.</div>` +
      (stored >= shown.capacity ? `<div class="tip-warn">Full: you can't harvest until you sell.</div>` : "");
    renderTax(s, shown);
    if (self) renderTools(self);
    else renderVersus(s, shown);
    renderMarket(s, shown, !self);
    renderContracts(s, shown, !self);
    renderSabotage(s, shown, !self);
    const open = $("tech-open");
    open.textContent = `🔬 Tech tree · ${techCount(shown)}/${TECH_IDS.length} (T)`;
    open.classList.toggle("ready", !!self && TECH_IDS.some((id) => canResearch(self, id) && self.coins >= TECH[id].cost));
  }
  renderTech(s, self);
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
    aim("");
  }
}

const has = (player: PlayerState | undefined, id: TechId) => !!player?.tech.get(id);
const techCount = (player: PlayerState) => TECH_IDS.filter((id) => has(player, id)).length;
/** Not researched yet, and the tech above it in its branch is. */
const canResearch = (player: PlayerState, id: TechId) => !has(player, id) && (!TECH[id].requires || has(player, TECH[id].requires));

/** Opens a farmer's tech tree, or closes it when it's already open or side is -1. */
function openTech(side: number) {
  techSide = techSide === side || side === -1 ? -1 : side;
  if (room?.state) render();
}

function renderTech(s: FarmState, self: PlayerState | undefined) {
  const player = [...s.players].find((p) => p.side === techSide);
  $("tech").classList.toggle("hidden", !player);
  if (!player) return;
  const mine = player === self;
  const playing = s.phase === "playing";
  $("tech-title").textContent = mine ? "Your tech tree" : `${player.name}'s tech tree`;
  for (const tab of $("tech-tabs").children as HTMLCollectionOf<HTMLButtonElement>) {
    const side = Number(tab.dataset.side);
    const owner = [...s.players].find((p) => p.side === side);
    tab.textContent = `${owner && owner === self ? "You" : (owner?.name ?? "?")} · ${owner ? techCount(owner) : 0}/${TECH_IDS.length}`;
    tab.classList.toggle("selected", side === techSide);
    tab.classList.toggle("enemy", side !== renderer.mySide);
  }
  for (const node of $("tech-tree").querySelectorAll<HTMLElement>(".tech-node")) {
    const id = node.dataset.tech as TechId;
    const { cost, requires } = TECH[id];
    const done = has(player, id);
    const open = canResearch(player, id);
    node.classList.toggle("done", done);
    node.classList.toggle("locked", !done && !open);
    const button = node.querySelector<HTMLButtonElement>("button")!;
    button.classList.toggle("hidden", !mine || !open || !playing);
    button.disabled = player.coins < cost;
    node.querySelector(".tech-state")!.textContent = done
      ? "✓ Researched"
      : mine && open && playing
        ? ""
        : `${open ? "Not yet" : `Needs ${TECH[requires!].name}`} · ${cost} coins`;
  }
  $("tech-note").textContent = `${mine ? "Each step needs the one above it." : `${player.name} has ${player.coins} coins.`} Research counts at half its cost toward net worth.`;
}

function renderTax(s: FarmState, shown: PlayerState) {
  const tiles = [...s.tiles].filter((t) => t.owner === shown.side).length;
  const tax = landTax(tiles);
  const next = Math.ceil((TAX.everyTicks - (s.tick % TAX.everyTicks)) / TICK_RATE);
  const period = TAX.everyTicks / TICK_RATE;
  $("tax").textContent = tax ? `Land tax ${tax} every ${period} s · next in ${next} s` : `No land tax yet (${tiles} tiles)`;
  $("tax").classList.toggle("due", tax > 0 && next <= 2);
  const examples = [10, 20, 30, 40].map((n) => `${n} tiles pay ${landTax(n)}`).join(", ");
  $("tax").dataset.tip =
    `<b>Land tax: ${tax} coins every ${period} s</b>` +
    `<div class="tip-row">Every ${period} s each farmer pays tiles² ÷ ${TAX.divisor} coins. You own ${tiles} tiles. ${examples}.</div>` +
    `<div class="tip-muted">It keeps a big farm from growing for free; it never takes you below 0 coins.</div>`;
}

function barnCount(player: PlayerState): number {
  return CROP_IDS.reduce((sum, id) => sum + (player.barn.get(id) ?? 0), 0);
}

function cost(t: CropId | BuildingId): number {
  return t in CROPS ? CROPS[t as CropId].seed : BUILDINGS[t as BuildingId].cost;
}

/** What a sabotage costs this farmer right now: being behind makes it cheaper. */
const moveCost = (player: PlayerState, id: SabotageId) => sabotageCost(SABOTAGE[id].cost, player.behind);

/** Both farmers side by side for spectators, the watched one first. */
function renderVersus(s: FarmState, shown: PlayerState) {
  const pair = [shown, [...s.players].find((p) => p.side !== shown.side)].filter((p): p is PlayerState => !!p);
  const tiles = [...s.tiles];
  const cooldowns = (p: PlayerState) =>
    (["crows", "weeds", "dump", "rustlers"] as const)
      .map((id) => {
        const wait = Math.max(0, (p.ready.get(id) ?? 0) - s.tick);
        return `<span class="${wait ? "muted" : ""}" title="${SABOTAGE[id].name}">${SABOTAGE_ICONS[id]}${wait ? Math.ceil(wait / TICK_RATE) : "✓"}</span>`;
      })
      .join(" ");
  const rows: [string, (p: PlayerState) => string][] = [
    ["Coins", (p) => String(p.coins)],
    ["Worth", (p) => `${p.netWorth}${p.behind ? " · behind" : ""}`],
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
    case "outpost":
      return `${who} set up an ${OUTPOST_ICON} outpost`;
    case "claim":
      return `${who} claimed ${rival}'s land for ${fx.cost}`;
    case "rustlers":
      return `${who}'s rustlers stole ${fx.crops.length} crops from ${rival}`;
    case "contract":
      return `${who} filled an order for ${fx.reward}`;
    case "crows":
      return `${who} sent crows at ${rival}`;
    case "weeds":
      return `${who} sowed weeds on ${rival}'s land`;
    case "dump":
      return `${who} dumped ${CROP_ICONS[fx.crop]} on the market`;
    case "research":
      return `${who} researched 🔬 ${TECH[fx.tech].name}`;
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
    button.classList.toggle("selected", t === tool && !aiming);
    if (t === "outpost") {
      button.classList.toggle("used", self.outpost);
      button.classList.toggle("poor", !self.outpost && self.coins < outpostCost(self, "grass"));
      button.querySelector(".cost")!.textContent = self.outpost ? "used" : String(outpostCost(self, "grass"));
      button.dataset.tip = outpostTip(self);
      continue;
    }
    button.classList.toggle("poor", self.coins < cost(t));
    button.dataset.tip = toolTip(t, self);
  }
}

function outpostTip(self: PlayerState): string {
  return (
    `<b>${OUTPOST_ICON} Outpost · ${outpostCost(self, "grass")} coins</b><span class="tip-key">O</span>` +
    `<div class="tip-row">Buy one neutral tile anywhere on the board, not just next to your land, for ${OUTPOST.percent}% of the land price. ` +
    "You can then buy the land around it as usual.</div>" +
    `<div class="tip-muted">Once per match. Grab the middle early, or put a goat pen next to their farm.</div>` +
    (self.outpost ? `<div class="tip-warn">You've set up your outpost.</div>` : "")
  );
}

/** Seconds a crop takes from seed to ripe on a tile like this. */
function growSeconds(crop: CropId, terrain: string, wet: boolean, weeds = false, fertilized = false): number {
  return Math.ceil((CROPS[crop].growTicks * GROWTH_FULL) / rateFor(terrain, wet, weeds, fertilized) / TICK_RATE);
}

/** What the next neutral tile of this terrain costs a player; surveying slows the rise. */
function landCost(player: PlayerState, terrain: string): number {
  return LAND.base + player.bought * (has(player, "survey") ? LAND.surveyStep : LAND.step) + (terrain === "rich" ? LAND.rich : 0);
}

const outpostCost = (player: PlayerState, terrain: string) => Math.floor((landCost(player, terrain) * OUTPOST.percent) / 100);

/** What buying out a tile costs; fences on the owner's land make it dearer. */
function buyoutCost(t: TileState): number {
  const owner = [...(room?.state.players ?? [])].find((p) => p.side === t.owner);
  return t.value * (has(owner, "fences") ? BUYOUT.fencedFactor : BUYOUT.factor);
}

const claimCost = (t: TileState) => Math.floor((buyoutCost(t) * CLAIM.percent) / 100);

/** Land that can change hands: not starting land, and no building but a goat pen. */
const takeable = (t: TileState) => !t.home && !t.guarded && (!t.building || t.building === "goats");

/** How far a well owned by this side waters: irrigation adds a ring. */
function wellReach(side: number): number {
  return has([...(room?.state.players ?? [])].find((p) => p.side === side), "irrigation") ? 2 : 1;
}

function toolTip(t: CropId | BuildingId, self: PlayerState): string {
  const key = `<span class="tip-key">${TOOLS.indexOf(t) + 1}</span>`;
  const poor = self.coins < cost(t) ? `<div class="tip-warn">You need ${cost(t)} coins.</div>` : "";
  if (t in CROPS) {
    const crop = CROPS[t as CropId];
    const now = room?.state.prices.get(crop.id) ?? crop.price;
    const regrow = crop.regrowTicks
      ? `<div class="tip-row">Grows back ${crop.regrowTicks / TICK_RATE} s after each harvest, no replanting.</div>`
      : "";
    const fert = has(self, "fertilizer");
    return (
      `<b>${CROP_ICONS[crop.id]} ${crop.name} seed · ${crop.seed} coins</b>${key}` +
      `<div class="tip-row">Ripe in ${growSeconds(crop.id, "grass", true, false, fert)} s watered, ${growSeconds(crop.id, "grass", false, false, fert)} s dry, ` +
      `${growSeconds(crop.id, "rich", true, false, fert)} s on watered rich soil${fert ? " (with fertilizer)" : ""}.</div>` +
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
    row.querySelector<HTMLElement>(".info")!.dataset.tip =
      `<b>${CROP_ICONS[crop]} ${CROPS[crop].name}: ${price} coins</b>` +
      `<div class="tip-row">Normal price ${CROPS[crop].price}. Every unit anyone sells drops it ${MARKET.dropPerUnit / 10}% for both of you, ` +
      `down to ${MARKET.floor / 10}%; it recovers over about ${Math.ceil((MARKET.full - MARKET.floor) / MARKET.recoverPerTick / TICK_RATE)} s.</div>` +
      (s.frozen.get(crop) ? `<div class="tip-warn">❄ Frozen by a market dump.</div>` : "") +
      `<div class="tip-muted">The line shows the last minute.</div>`;
    const sell = row.querySelector<HTMLButtonElement>("button.sell")!;
    sell.disabled = readOnly || stock === 0;
    sell.textContent = stock ? `Sell ${stock}` : "Sell";
    sell.dataset.tip = stock
      ? `<b>Sell all ${stock} for about ${estimate(price, CROPS[crop].price, stock, self)} coins</b>` +
        `<div class="tip-muted">The price drops with each unit sold, then recovers.</div>`
      : `You have no ${CROPS[crop].name.toLowerCase()} to sell.`;
    const dump = row.querySelector<HTMLButtonElement>("button.dump")!;
    const dumpCost = moveCost(self, "dump");
    dump.disabled = readOnly || stock < DUMP.units || dumpReady > 0 || self.coins < dumpCost;
    dump.dataset.tip =
      `<b>${SABOTAGE_ICONS.dump} Market dump · ${dumpCost} coins</b>` +
      (self.behind ? `<div class="tip-row">You're behind, so it costs ${BEHIND.discount}% less (normally ${SABOTAGE.dump.cost}).</div>` : "") +
      `<div class="tip-row">Throw away ${DUMP.units} ${CROPS[crop].name.toLowerCase()} to crash its price to ${MARKET.floor / 10}% ` +
      `and freeze it there for ${DUMP.freezeTicks / TICK_RATE} s.</div>` +
      `<div class="tip-muted">Cooldown ${SABOTAGE.dump.cooldownTicks / TICK_RATE} s.</div>` +
      (dumpReady > 0 ? `<div class="tip-warn">Ready in ${Math.ceil(dumpReady / TICK_RATE)} s.</div>` : "") +
      (stock < DUMP.units ? `<div class="tip-warn">You need ${DUMP.units} in your barn.</div>` : "");
  }
}

/** What selling n units at the current price brings in, as the sim prices each unit for this player's tech. */
function estimate(price: number, base: number, n: number, self: PlayerState): number {
  let factor = (price * MARKET.full) / base;
  const drop = has(self, "wholesale") ? TRADE.wholesaleDrop : MARKET.dropPerUnit;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const unit = Math.max(1, Math.floor((base * factor) / MARKET.full));
    total += has(self, "haggling") ? Math.floor((unit * TRADE.haggle) / 100) : unit;
    factor = Math.max(MARKET.floor, factor - drop);
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
    const guild = has(self, "guild");
    const reward = guild ? Math.floor((contract.reward * TRADE.guild) / 100) : contract.reward;
    el.querySelector(".reward")!.textContent = String(reward);
    const worth = [...contract.items].reduce((sum, item) => sum + (s.prices.get(item.crop) ?? 0) * item.count, 0);
    el.dataset.tip =
      `<b>Order: ${reward} coins</b>` +
      `<div class="tip-row">Pays ${CONTRACTS.bonus}% of the normal price${guild ? `, plus ${TRADE.guild - 100}% from the guild` : ""}. ` +
      `Selling the same goods now would bring about ${worth}.</div>` +
      `<div class="tip-muted">The first farmer to deliver gets it.</div>` +
      (ready ? "" : `<div class="tip-warn">Not enough in your barn yet.</div>`);
    el.querySelector(".left")!.textContent = `${Math.max(0, Math.ceil((contract.expiresAt - s.tick) / TICK_RATE))} s`;
  }
}

function renderSabotage(s: FarmState, self: PlayerState, readOnly: boolean) {
  const rival = [...s.players].find((p) => p.side !== self.side);
  const mine = !readOnly;
  const note = $("behind-note");
  const behindText = `sabotage costs ${BEHIND.discount}% less, and ${SABOTAGE_ICONS.rustlers} Rustlers and ${CLAIM_ICON} Land claim are unlocked.`;
  if (self.behind) note.textContent = `${mine ? "You're" : `${self.name} is`} behind: ${behindText}`;
  else if (rival?.behind) note.textContent = `${rival.name} is behind: their ${behindText}`;
  note.classList.toggle("hidden", !self.behind && !rival?.behind);
  note.classList.toggle("mine", self.behind);
  note.dataset.tip =
    `<b>Falling behind</b><div class="tip-row">A farmer whose net worth is below ${BEHIND.percent}% of the other's, ` +
    `and at least ${BEHIND.minGap} short, is behind. ` +
    `Their sabotage costs ${BEHIND.discount}% less and they get two comeback moves.</div>` +
    `<div class="tip-muted">It switches off again once they catch up.</div>`;

  for (const button of $("sabotage").children as HTMLCollectionOf<HTMLButtonElement>) {
    const id = button.dataset.id as Move;
    const wait = Math.max(0, (self.ready.get(id) ?? 0) - s.tick);
    const locked = (id === "claim" || SABOTAGE[id].behindOnly) && !self.behind;
    const price = id === "claim" ? 0 : moveCost(self, id);
    button.disabled = readOnly || wait > 0 || locked || self.coins < price;
    button.classList.toggle("armed", aiming === id);
    button.classList.toggle("locked", locked);
    const state = button.querySelector(".state")!;
    if (wait > 0) state.textContent = `${Math.ceil(wait / TICK_RATE)} s`;
    else if (locked) state.textContent = "🔒 behind";
    else if (id === "claim") state.textContent = `−${100 - CLAIM.percent}%`;
    else state.innerHTML = price < SABOTAGE[id].cost ? `<s>${SABOTAGE[id].cost}</s> ${price}` : String(price);
    const how = {
      crows: `Eat the crops on ${CROWS.count} random enemy tiles, ripe ones first. Crops within ${CROWS.scarecrowRange} tiles of their scarecrow are safe.`,
      weeds: `Click, then pick a 2×2 patch of enemy land. Those crops grow at half speed for ${WEEDS_TICKS / TICK_RATE} s unless they pull the weeds tile by tile.`,
      rustlers: `Steal up to ${RUSTLERS.count} of their most valuable stored crops into your barn.`,
      claim:
        `Click, then pick any of their tiles, anywhere on the board, to buy it out for ${CLAIM.percent}% of the buyout price. ` +
        "They get what they paid back. Not starting land, nor buildings other than goat pens.",
    }[id];
    const name = id === "claim" ? "Land claim" : SABOTAGE[id].name;
    const icon = id === "claim" ? CLAIM_ICON : SABOTAGE_ICONS[id];
    const cooldown = id === "claim" ? CLAIM.cooldownTicks : SABOTAGE[id].cooldownTicks;
    const title = id === "claim" ? "priced per tile" : `${price} coins`;
    button.dataset.tip =
      `<b>${icon} ${name} · ${title}</b><span class="tip-key">${MOVE_KEYS[id]}</span>` +
      `<div class="tip-row">${how}</div>` +
      (id !== "claim" && price < SABOTAGE[id].cost
        ? `<div class="tip-row">You're behind, so it costs ${BEHIND.discount}% less (normally ${SABOTAGE[id].cost}).</div>`
        : "") +
      `<div class="tip-muted">Cooldown ${cooldown / TICK_RATE} s.</div>` +
      (locked ? `<div class="tip-warn">🔒 Only while you're behind: below ${BEHIND.percent}% of their net worth and ${BEHIND.minGap} short.</div>` : "") +
      (wait > 0 ? `<div class="tip-warn">Ready in ${Math.ceil(wait / TICK_RATE)} s.</div>` : "") +
      (!locked && self.coins < price ? `<div class="tip-warn">You need ${price} coins.</div>` : "");
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
  type: "buy" | "clear" | "plant" | "harvest" | "build" | "weed" | "weeds" | "claim" | "outpost";
  text: string;
}

/** What clicking a tile would do with the current tool, if anything. */
function actionFor(index: number): Action | null {
  const self = me();
  const t = tile(index);
  if (!self || !t || room?.state.phase !== "playing") return null;
  const s = room.state;
  if (aiming === "weeds") return { type: "weeds", text: `Sow weeds here (${moveCost(self, "weeds")} coins)` };
  if (aiming === "claim") {
    if (t.owner !== 1 - self.side || !takeable(t)) return null;
    return { type: "claim", text: `Claim this tile for ${claimCost(t)} coins (they get ${t.value} back)` };
  }
  if (t.owner === self.side) {
    if (t.weeds) return { type: "weed", text: "Pull the weeds" };
    if (t.crop && t.growth >= 100) return { type: "harvest", text: `Harvest ${CROPS[t.crop as CropId].name.toLowerCase()}` };
    if (t.terrain === "rock") return { type: "clear", text: `Clear the rock (${LAND.clear} coins)` };
    if (t.crop || t.building || tool === "outpost") return null;
    if (tool in CROPS) return { type: "plant", text: `Plant ${CROPS[tool as CropId].name.toLowerCase()} (${cost(tool)} coins)` };
    return { type: "build", text: `Build a ${BUILDINGS[tool as BuildingId].name.toLowerCase()} (${cost(tool)} coins)` };
  }
  if (t.terrain === "pond") return null;
  if (!bordersMine(index, self.side)) {
    if (tool !== "outpost" || t.owner !== -1 || self.outpost) return null;
    return { type: "outpost", text: `Set up your outpost here for ${outpostCost(self, t.terrain)} coins` };
  }
  if (t.owner === -1) {
    const price = landCost(self, t.terrain);
    return { type: "buy", text: `Buy this ${t.terrain === "rich" ? "rich soil" : t.terrain} for ${price} coins` };
  }
  if (!takeable(t)) return null;
  const wait = Math.max(0, (self.ready.get("buyout") ?? 0) - s.tick);
  const note = wait ? ` · ready in ${Math.ceil(wait / TICK_RATE)} s` : "";
  return { type: "buy", text: `Buy out for ${buyoutCost(t)} coins (they get ${t.value} back)${note}` };
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
  const fert = has([...s.players].find((p) => p.side === t.owner), "fertilizer");
  if (t.crop) {
    const crop = CROPS[t.crop as CropId];
    if (t.growth >= 100) row(`${CROP_ICONS[crop.id]} <b>Ripe ${crop.name.toLowerCase()}</b> · sells for ${s.prices.get(crop.id) ?? crop.price}`);
    else {
      const left = Math.ceil(((100 - t.growth) / 100) * growSeconds(crop.id, t.terrain, t.wet, t.weeds, fert));
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
    if (fert) factors.push("fertilizer ×1.25");
    const speed = rateFor(t.terrain, t.wet, t.weeds, fert) / rateFor("grass", true, false);
    row(`Growth speed ${speed === 1 ? "normal" : `×${speed}`} (${factors.join(", ")})`);
    const byWell = around(index, 2).some((n) => n !== index && tile(n)?.building === "well" && around(n, wellReach(tile(n)!.owner)).includes(index));
    if (t.wet) row(`Watered by ${byWell ? "a well" : "a pond"} nearby.`, "tip-muted");
    else row("Dry: a pond or well next to it would double the speed.", "tip-warn");
    if (t.weeds) row(t.owner === side && self ? "Weeds! Click to pull them." : "Weeds slow this tile down.", "tip-warn");
  }
  if (t.owner !== -1 && t.crop) {
    const safe = around(index, CROWS.scarecrowRange).some((n) => tile(n)?.owner === t.owner && tile(n)?.building === "scarecrow");
    if (safe) row("🧑‍🌾 Safe from crows.", "tip-muted");
  }
  if (t.owner !== -1) {
    if (t.home) row(`Starting land, worth ${t.value}. Can't be bought out.`, "tip-muted");
    else if (t.building === "goats") row(`Worth ${t.value}. Buyout price ${buyoutCost(t)}, and the goat pen comes with it.`, "tip-muted");
    else if (t.building) row(`Worth ${t.value}. Land with a building can't be bought out.`, "tip-muted");
    else if (t.guarded) row(`Worth ${t.value}. Just bought out, safe for now.`, "tip-muted");
    else row(`Worth ${t.value}. Buyout price ${buyoutCost(t)}.`, "tip-muted");
  } else if (t.terrain !== "pond" && self) {
    const price = landCost(self, t.terrain);
    row(`Costs ${price} coins. You can buy land that touches yours (not diagonally).`, "tip-muted");
    if (!self.outpost) row(`Or set up your one ${OUTPOST_ICON} outpost on it (O) for ${outpostCost(self, t.terrain)} coins.`, "tip-muted");
  }
  const action = actionFor(index);
  const click = action ? `<div class="tip-action">Click: ${action.text}</div>` : "";
  return `<b>${TERRAIN_NAMES[t.terrain] ?? t.terrain} · ${whose}</b>${rows.join("")}${click}`;
}

/** What hovering a tile highlights: a well's water, a scarecrow's cover or the weeds patch. */
function previewFor(index: number): { tiles: number[]; color: number } | null {
  const t = tile(index);
  if (index === -1 || !t) return null;
  if (aiming === "weeds") {
    const x = Math.min(tileX(index), COLS - 2);
    const y = Math.min(tileY(index), ROWS - 2);
    const patch = [tileAt(x, y), tileAt(x + 1, y), tileAt(x, y + 1), tileAt(x + 1, y + 1)];
    return { tiles: patch.filter((n) => tile(n)?.owner === 1 - (me()?.side ?? 0)), color: PALETTE.weeds };
  }
  const building = actionFor(index)?.type === "build" ? tool : t.building;
  if (building === "well") {
    const reach = wellReach(t.building ? t.owner : (me()?.side ?? -1));
    return { tiles: around(index, reach).filter((n) => n !== index && tile(n)?.terrain !== "pond"), color: PALETTE.pond };
  }
  if (building === "scarecrow") return { tiles: around(index, CROWS.scarecrowRange), color: PALETTE.wheat };
  if (building === "goats") return { tiles: around(index, GOATS.range).filter((n) => n !== index), color: PALETTE.carrot };
  return null;
}

function updateHint() {
  renderer.preview = previewFor(hovered);
  if (aiming) {
    $("hint").textContent =
      aiming === "weeds" ? "Click enemy land to sow a 2×2 patch of weeds · Esc to cancel" : "Click any of their tiles to claim it · Esc to cancel";
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
    aim("");
  } else if (action.type === "claim") {
    room.send("claim", { tile: index });
    aim("");
  } else if (action.type === "outpost") {
    room.send("outpost", { tile: index });
    selectTool("wheat");
  } else if (action.type === "plant") {
    room.send("plant", { tile: index, crop: tool });
  } else if (action.type === "build") {
    room.send("build", { tile: index, building: tool });
  } else {
    room.send(action.type, { tile: index });
  }
}

function aim(mode: Aim) {
  aiming = mode;
  if (room?.state) render();
}

/** Arms a targeted move, or disarms it when it's already armed. */
const toggleAim = (mode: Aim) => aim(aiming === mode ? "" : mode);

function selectTool(t: Tool) {
  tool = t;
  aim("");
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
    else if (fx.type === "outpost") {
      sfx.buy();
      if (!mine && !spectating) toast(`${nameOf(fx.side)} set up an outpost`);
    } else if (fx.type === "claim") {
      sfx.buyout();
      if (!mine && !spectating) toast(`${nameOf(fx.side)} claimed your land`);
    } else if (fx.type === "rustlers") {
      sfx.rustlers();
      if (!spectating) toast(mine ? `Your rustlers stole ${fx.crops.length} crops` : `Rustlers stole ${fx.crops.length} crops from your barn`);
    } else if (fx.type === "goat") sfx.goat();
    else if (fx.type === "contract") {
      sfx.contract();
      if (!mine && !spectating) toast(`${[...room!.state.players].find((p) => p.side === fx.side)?.name ?? "They"} filled an order`);
    } else if (fx.type === "crows") sfx.crows();
    else if (fx.type === "weeds") sfx.weeds();
    else if (fx.type === "dump") sfx.dump();
    else if (fx.type === "research") {
      sfx.research();
      if (!mine && !spectating) toast(`${[...room!.state.players].find((p) => p.side === fx.side)?.name ?? "They"} researched ${TECH[fx.tech].name}`);
    }
  }
  if (spectating) {
    feed = feed.slice(0, FEED_LENGTH);
    renderFeed();
  }
}

const nameOf = (side: number) => [...(room?.state.players ?? [])].find((p) => p.side === side)?.name ?? "They";

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
  techSide = -1;
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
    aim("");
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
  const post = document.createElement("button");
  post.className = "tool";
  post.dataset.tool = "outpost";
  post.innerHTML = `<span class="key">O</span><span class="icon">${OUTPOST_ICON}</span><span>Outpost</span><span class="cost"></span>`;
  post.onclick = () => selectTool("outpost");
  $("tools").appendChild(post);

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

  for (const id of MOVES) {
    const button = document.createElement("button");
    button.dataset.id = id;
    const label = id === "claim" ? `${CLAIM_ICON} Land claim` : `${SABOTAGE_ICONS[id]} ${SABOTAGE[id].name}`;
    button.innerHTML = `<span>${label} <span class="muted">(${MOVE_KEYS[id]})</span></span><span class="state"></span>`;
    button.onclick = () => (id === "weeds" || id === "claim" ? toggleAim(id) : room?.send("sabotage", { id }));
    $("sabotage").appendChild(button);
  }
  $("sabotage").classList.add("sabotage");

  $("tech-tabs").innerHTML = [0, 1].map((side) => `<button data-side="${side}"></button>`).join("");
  for (const tab of $("tech-tabs").children as HTMLCollectionOf<HTMLButtonElement>) tab.onclick = () => openTech(Number(tab.dataset.side));
  $("tech-tree").innerHTML = BRANCH_IDS.map(
    (branch) =>
      `<div class="tech-branch"><h2>${BRANCHES[branch]}</h2>` +
      TECH_IDS.filter((id) => TECH[id].branch === branch)
        .map(
          (id) =>
            `<div class="tech-node" data-tech="${id}"><div class="tech-name">${TECH[id].name}</div>` +
            `<div class="tech-text">${TECH[id].text}</div><div class="tech-state"></div>` +
            `<button class="research">Research · ${TECH[id].cost}</button></div>`,
        )
        .join("") +
      "</div>",
  ).join("");
  for (const node of $("tech-tree").querySelectorAll<HTMLElement>(".tech-node")) {
    node.querySelector<HTMLButtonElement>("button")!.onclick = () => room?.send("research", { id: node.dataset.tech });
  }
  $("tech-close").onclick = () => openTech(-1);
  $("tech-open").onclick = () => openTech(viewed()?.side ?? 0);
  for (const badge of document.querySelectorAll<HTMLButtonElement>(".tech-badge")) {
    badge.onclick = (e) => {
      e.stopPropagation();
      openTech(Number(badge.dataset.side));
    };
  }
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
    // The tech tree covers the board; the tile under it isn't hovered.
    if (hovered !== -1 && e.target instanceof Element && e.target.closest("#tech")) {
      hovered = -1;
      updateHint();
    }
    refreshTip();
  });
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
    if (!room || room.state.phase === "lobby" || e.target instanceof HTMLInputElement) return;
    // Anyone, spectators included, can open the tech trees, even after the match.
    if (e.key.toLowerCase() === "t") return openTech(techSide === -1 ? (viewed()?.side ?? 0) : -1);
    if (e.key === "Escape" && techSide !== -1) return openTech(-1);
    if (room.state.phase !== "playing") return;
    const n = Number(e.key);
    if (n >= 1 && n <= TOOLS.length) selectTool(TOOLS[n - 1]);
    else if (e.key === "Escape") aim("");
    else if (e.key.toLowerCase() === "c") room.send("sabotage", { id: "crows" });
    else if (e.key.toLowerCase() === "r") room.send("sabotage", { id: "rustlers" });
    else if (e.key.toLowerCase() === "w") toggleAim("weeds");
    else if (e.key.toLowerCase() === "l") toggleAim("claim");
    else if (e.key.toLowerCase() === "o") selectTool("outpost");
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
  get tech() {
    return TECH_IDS.filter((id) => has(me(), id));
  },
  get behind() {
    return !!me()?.behind;
  },
  get outpost() {
    return !!me()?.outpost;
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

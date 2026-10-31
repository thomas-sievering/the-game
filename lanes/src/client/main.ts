import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import { CARDS, type Card, DECK_SIZE, MAX_COPIES, STARTER_DECK, deckError } from "../shared/cards";
import { BASE_HP, DRAW, type Fx, HAND_SIZE, MATCH_TICKS, MAX_LEVEL, MAX_TIER, RESEARCH, SHRINE, TICK_RATE, WAVE_TICKS, sellValue } from "../shared/sim";
import { LanesState, type PlayerState } from "../shared/state";
import { isMuted, sfx, toggleMute } from "./audio";
import { type Board, Renderer } from "./render";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2568` : location.origin;
const client = new Client(serverUrl);
const renderer = new Renderer();
/** Resolves once the canvas is ready. Buttons work before that; joining waits for it. */
let rendererReady: Promise<void> = Promise.resolve();

let room: Room<any, LanesState> | null = null;
/** Hand slot of the unit card waiting for a grid pad, or -1. */
let selected = -1;
let toastTimer = 0;
/** Saved deck, sent when joining a room and whenever it changes in the lobby. */
let deck = loadDeck();
/** Deck being edited while the deck screen is open, else null. */
let draft: string[] | null = null;
/** Own pad picked for selling, or -1. */
let selectedCell = -1;
/** What the last state showed, to play sounds for changes the server made. */
let heard = { levels: [] as number[], income: 0, tier: 1, tick: -1, phase: "" };

function show(screen: "home" | "deck" | "lobby" | "game") {
  $("home").classList.toggle("hidden", screen !== "home");
  $("deck").classList.toggle("hidden", screen !== "deck");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("hud").classList.toggle("hidden", screen !== "game");
  // The deck screen covers the field, so stop drawing it there; ticker is unset until the renderer is ready.
  if (renderer.app.ticker) {
    if (screen === "deck") renderer.app.stop();
    else renderer.app.start();
  }
}

function loadDeck(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem("lanes.deck") ?? "null");
    if (!deckError(saved)) return saved;
  } catch {}
  return [...STARTER_DECK];
}

async function openDeck() {
  // Card art is drawn by the renderer.
  await rendererReady;
  draft = [...deck];
  render();
}

function closeDeck(save: boolean) {
  if (save && draft && !deckError(draft)) {
    deck = draft;
    localStorage.setItem("lanes.deck", JSON.stringify(deck));
    if (room?.state.phase === "lobby") room.send("deck", deck);
  }
  draft = null;
  render();
}

function changeDraft(id: string, delta: 1 | -1) {
  if (!draft) return;
  const copies = draft.filter((c) => c === id).length;
  if (delta === 1 && copies < MAX_COPIES && draft.length < DECK_SIZE) draft.push(id);
  if (delta === -1 && copies > 0) draft.splice(draft.lastIndexOf(id), 1);
  renderDeck(draft);
}

function renderDeck(cards: string[]) {
  show("deck");
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  const units = cards.filter((id) => CARDS[id].kind === "unit").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  $("deck-count").textContent = `${cards.length}/${DECK_SIZE} cards · ${plural(units, "unit")} · ${plural(cards.length - units, "spell")}`;
  const error = deckError(cards);
  $("deck-error").textContent = cards.length < DECK_SIZE ? "" : (error ?? "");
  $<HTMLButtonElement>("deck-done").disabled = !!error;
  $("deck-rules").textContent =
    `Pick ${DECK_SIZE} cards, up to ${MAX_COPIES} copies of each. Click a card to add it, right-click to remove it. ` +
    `Cards of tier II and III can only be played after researching that tier in the match; each tier also opens another column of pads.`;
  const container = $("deck-cards");
  if (!container.children.length) {
    container.innerHTML = Object.values(CARDS)
      .map(
        (card) =>
          `<div class="deck-slot" data-card="${card.id}"><div class="hand-card ${card.kind}">${cardHtml(card, null, 0, false)}</div>` +
          `<div class="counter"><button data-delta="-1" aria-label="Remove ${card.name}">−</button>` +
          `<span class="copies"></span><button data-delta="1" aria-label="Add ${card.name}">+</button></div></div>`,
      )
      .join("");
    for (const slot of container.querySelectorAll<HTMLElement>(".deck-slot")) {
      const id = slot.dataset.card!;
      const tile = slot.querySelector<HTMLElement>(".hand-card")!;
      tile.onclick = () => changeDraft(id, 1);
      tile.oncontextmenu = (e) => {
        e.preventDefault();
        changeDraft(id, -1);
      };
      for (const button of slot.querySelectorAll<HTMLButtonElement>("button")) {
        button.onclick = () => changeDraft(id, Number(button.dataset.delta) as 1 | -1);
      }
    }
  }
  for (const slot of container.querySelectorAll<HTMLElement>(".deck-slot")) {
    const copies = counts.get(slot.dataset.card!) ?? 0;
    slot.classList.toggle("in-deck", copies > 0);
    slot.querySelector(".copies")!.textContent = `${copies}/${MAX_COPIES}`;
    slot.querySelector<HTMLButtonElement>("[data-delta='-1']")!.disabled = copies === 0;
    slot.querySelector<HTMLButtonElement>("[data-delta='1']")!.disabled = copies >= MAX_COPIES || cards.length >= DECK_SIZE;
  }
}

function me(): PlayerState | undefined {
  return room ? [...room.state.players].find((p) => p.id === room!.sessionId) : undefined;
}

function renderLobby(s: LanesState) {
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
  $("lobby-players-title").textContent = `Players ${s.players.length}/2`;
  $("lobby-players").innerHTML = [...s.players].map((p) => `<li>${escapeHtml(p.name)}${rowEnd(p.id, true)}</li>`).join("");
  $("lobby-spectators").innerHTML = [...s.spectators].map((sp) => `<li>👁 ${escapeHtml(sp.name)}${rowEnd(sp.id, false)}</li>`).join("");
  $("lobby-spectators-box").classList.toggle("hidden", s.spectators.length === 0);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#lobby button[data-id]")) {
    button.onclick = () => room?.send("spectate", { id: button.dataset.id, spectate: button.dataset.spectate === "true" });
  }
  $("lobby-deck").classList.toggle("hidden", !me());
  $("start").classList.toggle("hidden", !isHost || s.players.length !== 2);
  const spectating = !me() ? "You're spectating. " : "";
  $("lobby-wait").textContent =
    s.players.length < 2 ? `${spectating}Waiting for players…` : isHost ? "" : `${spectating}Waiting for the host to start…`;
}

function render() {
  const s = room?.state;
  // The deck screen only works outside a match; a starting match closes it unsaved.
  if (draft && s && s.phase !== "lobby") draft = null;
  if (draft) return renderDeck(draft);
  if (!s) return show("home");
  if (s.phase === "lobby") return renderLobby(s);
  show("game");
  const self = me();
  $("spectating").classList.toggle("hidden", !!self);
  document.querySelector(".bottom")!.classList.toggle("hidden", !self);
  const bySide = (side: number) => [...s.players].find((p) => p.side === side);
  const sides = { me: self?.side ?? 0, them: 1 - (self?.side ?? 0) };
  for (const el of document.querySelectorAll<HTMLElement>(".base")) {
    const player = bySide(sides[el.dataset.who as "me" | "them"]);
    const hp = Math.max(0, player?.baseHp ?? 0);
    // Spectators see both players' gold next to their names.
    const gold = !self && player ? ` · ${player.gold} gold` : "";
    el.querySelector(".base-name")!.textContent = `${player?.name ?? "?"}${player && !player.connected ? " · left" : ""}${gold}`;
    el.querySelector(".base-hp")!.textContent = String(hp);
    el.querySelector<HTMLElement>(".fill")!.style.width = `${(100 * hp) / BASE_HP}%`;
  }
  $("match-time").textContent = clock(Math.max(0, MATCH_TICKS - s.tick));
  $("wave-time").textContent = `Next wave ${Math.ceil((WAVE_TICKS - (s.tick % WAVE_TICKS)) / TICK_RATE)} s`;

  renderer.mySide = sides.me;
  renderer.interactive = !!self;
  if (self) {
    $("gold").textContent = `${self.gold} gold`;
    const shrine = s.shrineOwner === self.side ? SHRINE.income : 0;
    $("income").textContent = self.researchDone ? "paused" : `+${self.income + shrine}/s`;
    $("income").title = self.researchDone ? "No gold per second while researching" : shrine ? `Includes +${shrine}/s from the shrine` : "";
    $("income").classList.toggle("shrine", shrine > 0);
    $("invest").textContent = `Invest ${self.investCost} → +1/s`;
    $<HTMLButtonElement>("invest").disabled = self.gold < self.investCost;
    renderResearch(self, s.tick);
    renderHand(self, s.tick);
    if (selectedCell !== -1 && !self.grid[selectedCell]) selectPad(-1);
    renderSell(self);
  }
  const board = (p?: PlayerState): Board => ({ grid: [...(p?.grid ?? [])], levels: [...(p?.levels ?? [])], tier: p?.tier ?? 1 });
  // Spectators see both build grids, side 0 on the left.
  renderer.setBoards(board(self ?? bySide(0)), self ? null : board(bySide(1)));
  renderer.setShrine(s.shrineOwner, s.shrineControl);
  renderer.setTowers([[...(bySide(0)?.towers ?? [])], [...(bySide(1)?.towers ?? [])]]);
  renderer.setUnits([...s.units.values()]);
  playStateSounds(s, self);

  $("result").classList.toggle("hidden", s.phase !== "finished");
  if (s.phase === "finished") {
    const text = s.winner === DRAW ? "Draw!" : s.winner === self?.side ? "You win!" : `${bySide(s.winner)?.name ?? "Nobody"} wins!`;
    $("result").innerHTML = `<h1>${escapeHtml(text)}</h1><button id="home-again" class="primary">Back to start</button>`;
    $("home-again").onclick = () => void room?.leave();
    select(-1);
  }
}

const ROMAN = ["", "I", "II", "III"];

function renderResearch(self: PlayerState, tick: number) {
  const button = $<HTMLButtonElement>("research");
  const researching = self.researchDone > 0;
  button.classList.toggle("researching", researching);
  if (self.tier >= MAX_TIER) {
    button.textContent = `Tier ${ROMAN[self.tier]} · max`;
    button.disabled = true;
  } else if (researching) {
    button.textContent = `Researching ${ROMAN[self.tier + 1]} · ${Math.ceil(Math.max(0, self.researchDone - tick) / TICK_RATE)} s`;
    button.disabled = true;
  } else {
    const { cost, ticks } = RESEARCH[(self.tier + 1) as 2 | 3];
    button.textContent = `Tier ${ROMAN[self.tier + 1]} ${cost} · ${ticks / TICK_RATE} s`;
    button.disabled = self.gold < cost;
  }
}

function renderHand(self: PlayerState, tick: number) {
  const buttons = $("hand").children;
  for (let i = 0; i < HAND_SIZE; i++) {
    const button = buttons[i] as HTMLButtonElement;
    const card = CARDS[self.hand[i] ?? ""];
    const cooldown = card?.kind === "spell" ? Math.max(0, (self.ready.get(card.id) ?? 0) - tick) : 0;
    const locked = !!card && card.tier > self.tier;
    const left = card?.kind === "spell" && card.uses !== undefined ? card.uses - (self.used.get(card.id) ?? 0) : undefined;
    const key = `${card?.id}|${Math.ceil(cooldown / TICK_RATE)}|${locked}|${left}`;
    if (button.dataset.key !== key) {
      button.dataset.key = key;
      button.className = `hand-card ${card?.kind ?? "empty"}`;
      button.innerHTML = card ? cardHtml(card, i, cooldown, locked, left) : "";
    }
    button.classList.toggle("poor", !card || locked || self.gold < card.cost || cooldown > 0);
    button.classList.toggle("selected", i === selected);
  }
}

/**
 * `slot` is the hand slot whose shortcut key to show, or null outside the hand; `locked` covers a card above your tier;
 * `left` is the casts left of a limited spell.
 */
function cardHtml(card: Card, slot: number | null, cooldown: number, locked: boolean, left?: number): string {
  const top =
    `<span class="cost">${card.cost}</span><span class="tier t${card.tier}" title="Tier ${card.tier}">${ROMAN[card.tier]}</span>` +
    (slot === null ? "" : `<span class="key">${slot + 1}</span>`) +
    (locked ? `<span class="locked">🔒 Tier ${ROMAN[card.tier]}</span>` : "") +
    `<span class="art"><span class="mini" style="background-image: url('${renderer.cardArt(card.id)}')"></span></span>`;
  if (card.kind === "spell") {
    return (
      `${top}<strong>${card.name}</strong>` +
      `<span class="text">${card.text}</span><span class="stats">Spell · ${card.cooldownTicks / TICK_RATE} s cooldown${uses(card, left)}</span>` +
      (cooldown ? `<span class="cooldown">${Math.ceil(cooldown / TICK_RATE)}</span>` : "")
    );
  }
  const count = card.count ? `${card.count}× ` : "";
  const healer = card.role === "healer";
  return (
    `${top}<strong>${card.name}</strong>` +
    `<span class="text">${card.text}</span>` +
    `<span class="stats"><span title="Health">♥ ${count}${card.hp}</span>` +
    `<span title="${healer ? "Healing" : "Damage"}">${healer ? "✚" : "⚔"} ${card.damage}</span>` +
    `<span title="Range">◎ ${card.range}</span></span>`
  );
}

function uses(card: Card, left?: number): string {
  if (card.kind !== "spell" || card.uses === undefined) return "";
  return left === undefined ? ` · ${card.uses}× per match` : ` · ${left}/${card.uses} left`;
}

function select(slot: number) {
  selected = slot;
  if (slot !== -1) selectPad(-1);
  renderer.placing = slot === -1 ? "" : (me()?.hand[slot] ?? "");
  const name = CARDS[renderer.placing]?.name;
  $("hint").textContent =
    slot === -1 ? "" : `Click an empty pad to place it, or a ${name} below level ${MAX_LEVEL} to level it up · Esc to cancel`;
  for (let i = 0; i < HAND_SIZE; i++) $("hand").children[i]?.classList.toggle("selected", i === selected);
}

/** Picks one of your pads to sell, or -1 to clear. */
function selectPad(cell: number) {
  selectedCell = cell;
  renderer.selectedCell = cell;
  if (cell !== -1 && selected !== -1) select(-1);
  if (cell !== -1) sfx.select();
  const self = me();
  if (self) renderSell(self);
}

function renderSell(self: PlayerState) {
  const card = self.grid[selectedCell] ?? "";
  $("sell").classList.toggle("hidden", !card);
  if (card) $("sell").textContent = `Sell ${CARDS[card].name} +${sellValue(card, self.levels[selectedCell])}`;
  if (selected === -1) $("hint").textContent = card ? "S or the Sell button to sell · Esc to cancel" : "";
}

function sellPad(cell: number) {
  if (!room || room.state.phase !== "playing" || !me()?.grid[cell]) return;
  room.send("sell", { cell });
  selectPad(-1);
}

/** Sounds for battle events; each kind is rate-limited in audio.ts. */
function playFx(events: Fx[]) {
  for (const fx of events) {
    if (fx.type === "hit") {
      if (fx.id === 0) sfx.turret();
      else if (fx.splash) sfx.blast();
      else if (fx.ranged) sfx.shot();
      else sfx.melee();
    } else if (fx.type === "heal") sfx.heal();
    else if (fx.type === "death") sfx.death(fx.side === renderer.mySide);
    else if (fx.type === "breach") sfx.breach(fx.side !== renderer.mySide);
    else if (fx.type === "tower") sfx.breach(fx.side === renderer.mySide);
    else if (fx.type === "spell") sfx.spell(fx.card);
    else if (fx.type === "shrine" && fx.owner !== -1) sfx.shrine(fx.owner === renderer.mySide);
  }
}

/** Sounds for changes that only show up in the state: your own placements, sales, investments and tiers, waves, the result. */
function playStateSounds(s: LanesState, self: PlayerState | undefined) {
  const levels = [...(self?.levels ?? [])];
  const income = self?.income ?? 0;
  const tier = self?.tier ?? 1;
  // The first render of a match (or after rejoining) only records the state.
  if (heard.phase === "playing" && s.tick >= heard.tick) {
    for (let cell = 0; cell < levels.length; cell++) {
      const before = heard.levels[cell] ?? 0;
      if (levels[cell] > before) before === 0 ? sfx.place() : sfx.levelUp(levels[cell]);
      else if (levels[cell] < before) sfx.sell();
    }
    if (income > heard.income) sfx.invest();
    if (tier > heard.tier) sfx.levelUp(tier);
    if (Math.floor(s.tick / WAVE_TICKS) > Math.floor(heard.tick / WAVE_TICKS)) sfx.wave();
    else if (s.phase === "playing" && s.tick > heard.tick) {
      const secondsLeft = (t: number) => Math.ceil((WAVE_TICKS - (t % WAVE_TICKS)) / TICK_RATE);
      const left = secondsLeft(s.tick);
      if (left <= 3 && left < secondsLeft(heard.tick)) sfx.tick();
    }
    if (s.phase === "finished") {
      if (s.winner === self?.side) sfx.win();
      else if (self && s.winner !== DRAW) sfx.lose();
      else sfx.wave();
    }
  }
  heard = { levels, income, tier, tick: s.tick, phase: s.phase };
}

/** Clicking a unit card arms it for placement; clicking a spell casts it. */
function useSlot(slot: number) {
  const card = CARDS[me()?.hand[slot] ?? ""];
  if (!room || room.state.phase !== "playing" || !card) return;
  if (card.tier > (me()?.tier ?? 1)) {
    toast(`${card.name} needs tier ${ROMAN[card.tier]}; research it first (T)`);
    sfx.error();
  } else if (card.kind === "spell") {
    select(-1);
    room.send("play", { hand: slot });
  } else {
    select(selected === slot ? -1 : slot);
    sfx.select();
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

async function enter(join: () => Promise<Room<any, LanesState>>) {
  $("home-error").textContent = "";
  localStorage.setItem("lanes.name", $<HTMLInputElement>("name").value.trim());
  try {
    await rendererReady;
    room = await join();
  } catch (err) {
    $("home-error").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  room.onStateChange(render);
  room.onMessage("fx", (events: Fx[]) => {
    renderer.addFx(events);
    playFx(events);
  });
  room.onMessage("error", (message: string) => {
    toast(message);
    sfx.error();
  });
  room.onLeave(() => {
    room = null;
    heard = { levels: [], income: 0, tier: 1, tick: -1, phase: "" };
    select(-1);
    selectPad(-1);
    render();
  });
  render();
}

function main() {
  rendererReady = renderer.init($("stage"));
  renderer.onCell = (cell) => {
    if (!room) return;
    if (selected !== -1) {
      if (cell === -1) return;
      room.send("play", { hand: selected, cell });
      select(-1);
    } else {
      // Clicking a built pad picks it for selling; clicking it again or anywhere else lets go.
      selectPad(cell !== selectedCell && me()?.grid[cell] ? cell : -1);
    }
  };
  renderer.onSellCell = sellPad;
  $("sell").onclick = () => sellPad(selectedCell);
  const showMute = () => ($("mute").textContent = isMuted() ? "🔇" : "🔊");
  showMute();
  $("mute").onclick = () => {
    toggleMute();
    showMute();
  };
  for (let i = 0; i < HAND_SIZE; i++) {
    const button = document.createElement("button");
    button.className = "hand-card";
    button.onclick = () => useSlot(i);
    $("hand").appendChild(button);
  }
  $("invest").onclick = () => room?.send("invest");
  $("research").onclick = () => room?.send("research");
  window.addEventListener("keydown", (e) => {
    if (draft && e.key === "Escape") return closeDeck(false);
    if (room?.state.phase !== "playing" || e.target instanceof HTMLInputElement) return;
    if (e.key >= "1" && e.key <= String(HAND_SIZE)) useSlot(Number(e.key) - 1);
    else if (e.key === "Escape") {
      select(-1);
      selectPad(-1);
    } else if (e.key.toLowerCase() === "i") room.send("invest");
    else if (e.key.toLowerCase() === "t") room.send("research");
    else if (e.key.toLowerCase() === "s" && selectedCell !== -1) sellPad(selectedCell);
    else if (e.key.toLowerCase() === "m") $("mute").click();
  });

  const name = () => ({ name: $<HTMLInputElement>("name").value.trim(), deck });
  $<HTMLInputElement>("name").value = localStorage.getItem("lanes.name") ?? "";
  $("create").onclick = () => enter(() => client.create("lanes", name(), LanesState));
  $("join").onclick = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    void enter(() => client.joinById(code, name(), LanesState));
  };
  $("start").onclick = () => room?.send("start");
  $("home-deck").onclick = () => void openDeck();
  $("lobby-deck").onclick = () => void openDeck();
  $("deck-done").onclick = () => closeDeck(true);
  $("deck-cancel").onclick = () => closeDeck(false);
  $("deck-reset").onclick = () => {
    draft = [...STARTER_DECK];
    render();
  };
  render();
}

main();

// Test hook for Playwright.
(window as any).__lanes = {
  get phase() {
    return room?.state.phase ?? null;
  },
  get code() {
    return room?.state.code ?? null;
  },
  get unitCount() {
    return room?.state.units.size ?? 0;
  },
  get gold() {
    return me()?.gold ?? 0;
  },
  get hand() {
    return [...(me()?.hand ?? [])];
  },
  /** The saved deck this client plays with. */
  get deck() {
    return [...deck];
  },
  get grid() {
    return [...(me()?.grid ?? [])];
  },
  get levels() {
    return [...(me()?.levels ?? [])];
  },
  get tier() {
    return me()?.tier ?? 0;
  },
  get researchDone() {
    return me()?.researchDone ?? 0;
  },
  get side() {
    return me()?.side ?? -1;
  },
  get spectating() {
    return !!room && !me();
  },
  get spellsCast() {
    return me()?.ready.size ?? 0;
  },
  /** Grid length of every player as this client sees them; the opponent's should be 0. */
  get visibleGrids() {
    return [...(room?.state.players ?? [])].map((p) => p.grid?.length ?? 0);
  },
  cellOnScreen: (cell: number) => renderer.cellOnScreen(cell),
  get shrineOwner() {
    return room?.state.shrineOwner ?? -1;
  },
  get winner() {
    return room?.state.winner ?? -1;
  },
};

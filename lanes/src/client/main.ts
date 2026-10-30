import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import { CARDS, type Card, DECK_SIZE, MAX_COPIES, type Role, STARTER_DECK, deckError } from "../shared/cards";
import { BASE_HP, DRAW, type Fx, HAND_SIZE, MATCH_TICKS, SHRINE, TICK_RATE, WAVE_TICKS } from "../shared/sim";
import { LanesState, type PlayerState } from "../shared/state";
import { isMuted, sfx, toggleMute } from "./audio";
import { Renderer } from "./render";

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
/** What the last render saw, so sounds play only on changes. */
let heard = { tick: -1, grid: "", income: 0, phase: "" };

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

function openDeck() {
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
  $("deck-rules").textContent = `Pick ${DECK_SIZE} cards, up to ${MAX_COPIES} copies of each. Click a card to add it, right-click to remove it.`;
  const container = $("deck-cards");
  if (!container.children.length) {
    container.innerHTML = Object.values(CARDS)
      .map(
        (card) =>
          `<div class="deck-slot" data-card="${card.id}"><div class="hand-card ${card.kind}">${cardHtml(card, null, 0)}</div>` +
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
    el.querySelector(".base-name")!.textContent = `${player?.name ?? "?"}${player && !player.connected ? " · left" : ""}`;
    el.querySelector(".base-hp")!.textContent = String(hp);
    el.querySelector<HTMLElement>(".fill")!.style.width = `${(100 * hp) / BASE_HP}%`;
  }
  $("match-time").textContent = clock(Math.max(0, MATCH_TICKS - s.tick));
  $("wave-time").textContent = `Next wave ${Math.ceil((WAVE_TICKS - (s.tick % WAVE_TICKS)) / TICK_RATE)} s`;

  if (self) {
    renderer.mySide = self.side;
    $("gold").textContent = `${self.gold} gold`;
    const shrine = s.shrineOwner === self.side ? SHRINE.income : 0;
    $("income").textContent = `+${self.income + shrine}/s`;
    $("income").title = shrine ? `Includes +${shrine}/s from the shrine` : "";
    $("income").classList.toggle("shrine", shrine > 0);
    $("invest").textContent = `Invest ${self.investCost} → +1/s`;
    $<HTMLButtonElement>("invest").disabled = self.gold < self.investCost;
    renderHand(self, s.tick);
  }
  playStateSounds(s, self);
  renderer.setGrid([...(self?.grid ?? [])]);
  renderer.setShrine(s.shrineOwner, s.shrineControl);
  renderer.setUnits([...s.units.values()]);

  $("result").classList.toggle("hidden", s.phase !== "finished");
  if (s.phase === "finished") {
    const text = s.winner === DRAW ? "Draw!" : s.winner === self?.side ? "You win!" : `${bySide(s.winner)?.name ?? "Nobody"} wins!`;
    $("result").innerHTML = `<h1>${escapeHtml(text)}</h1><button id="home-again" class="primary">Back to start</button>`;
    $("home-again").onclick = () => void room?.leave();
    select(-1);
  }
}

/** Sounds for state changes that have no fx event: waves, placements, investing and the result. */
function playStateSounds(s: LanesState, self: PlayerState | undefined) {
  const grid = (self?.grid ?? []).join(",");
  const income = self?.income ?? 0;
  // The first render of a match (or after rejoining) only records the state.
  if (heard.tick !== -1 && s.tick >= heard.tick) {
    if (s.phase === "playing" && s.tick > heard.tick) {
      if (Math.floor(s.tick / WAVE_TICKS) > Math.floor(heard.tick / WAVE_TICKS)) sfx.wave();
      else {
        const secondsLeft = (t: number) => Math.ceil((WAVE_TICKS - (t % WAVE_TICKS)) / TICK_RATE);
        const left = secondsLeft(s.tick);
        if (left <= 3 && left < secondsLeft(heard.tick)) sfx.tick();
      }
    }
    if (s.phase === "playing" && heard.phase === "playing") {
      if (grid !== heard.grid) sfx.place();
      if (income > heard.income) sfx.invest();
    }
    if (s.phase === "finished" && heard.phase !== "finished") {
      if (s.winner === self?.side) sfx.win();
      else if (self && s.winner !== DRAW) sfx.lose();
      else sfx.wave();
    }
  }
  heard = { tick: s.tick, grid, income, phase: s.phase };
}

function playFxSounds(events: Fx[]) {
  const mySide = me()?.side ?? -1;
  for (const fx of events) {
    if (fx.type === "hit") {
      if (fx.id === 0) sfx.turret();
      else if (fx.splash > 0) sfx.splash();
      else if (fx.ranged) sfx.shot();
      else sfx.melee();
    } else if (fx.type === "heal") sfx.heal();
    else if (fx.type === "death") sfx.death(fx.side === mySide);
    else if (fx.type === "breach") sfx.breach(1 - fx.side === mySide);
    else if (fx.type === "spell") sfx.spell(fx.card);
    else if (fx.type === "shrine" && fx.owner !== -1) sfx.shrine(mySide === -1 || fx.owner === mySide);
  }
}

function renderHand(self: PlayerState, tick: number) {
  const buttons = $("hand").children;
  for (let i = 0; i < HAND_SIZE; i++) {
    const button = buttons[i] as HTMLButtonElement;
    const card = CARDS[self.hand[i] ?? ""];
    const cooldown = card?.kind === "spell" ? Math.max(0, (self.ready.get(card.id) ?? 0) - tick) : 0;
    const key = `${card?.id}|${Math.ceil(cooldown / TICK_RATE)}`;
    if (button.dataset.key !== key) {
      button.dataset.key = key;
      button.className = `hand-card ${card?.kind ?? "empty"}`;
      button.innerHTML = card ? cardHtml(card, i, cooldown) : "";
    }
    button.classList.toggle("poor", !card || self.gold < card.cost || cooldown > 0);
    button.classList.toggle("selected", i === selected);
  }
}

/** `slot` is the hand slot whose shortcut key to show, or null outside the hand. */
function cardHtml(card: Card, slot: number | null, cooldown: number): string {
  const top = `<span class="cost">${card.cost}</span>${slot === null ? "" : `<span class="key">${slot + 1}</span>`}`;
  if (card.kind === "spell") {
    return (
      `${top}<span class="icon">${SPELL_ICONS[card.id] ?? "✦"}</span><strong>${card.name}</strong>` +
      `<span class="text">${card.text}</span><span class="stats">Spell · ${card.cooldownTicks / TICK_RATE} s cooldown</span>` +
      (cooldown ? `<span class="cooldown">${Math.ceil(cooldown / TICK_RATE)}</span>` : "")
    );
  }
  const count = card.count ? `${card.count}× ` : "";
  const healer = card.role === "healer";
  return (
    `${top}<span class="icon">${roleIcon(card.role)}</span><strong>${card.name}</strong>` +
    `<span class="text">${card.text}</span>` +
    `<span class="stats"><span title="Health">♥ ${count}${card.hp}</span>` +
    `<span title="${healer ? "Healing" : "Damage"}">${healer ? "✚" : "⚔"} ${card.damage}</span>` +
    `<span title="Range">◎ ${card.range}</span></span>`
  );
}

const SPELL_ICONS: Record<string, string> = { rally: "»", lightning: "ϟ", mend: "✚", frost: "❄" };

/** Same silhouettes as on the battlefield. */
function roleIcon(role: Role): string {
  const shapes: Record<Role, string> = {
    melee: '<circle cx="12" cy="12" r="9"/>',
    ranged: '<polygon points="12,3 21,19 3,19"/>',
    tank: '<rect x="3" y="3" width="18" height="18" rx="3"/>',
    fast: '<polygon points="12,2 22,12 12,22 2,12"/>',
    splash: '<polygon points="21,12 16.5,19.8 7.5,19.8 3,12 7.5,4.2 16.5,4.2"/>',
    healer: '<polygon points="9,3 15,3 15,9 21,9 21,15 15,15 15,21 9,21 9,15 3,15 3,9 9,9"/>',
  };
  return `<svg viewBox="0 0 24 24" width="22" height="22">${shapes[role]}</svg>`;
}

function select(slot: number) {
  selected = slot;
  renderer.placing = slot === -1 ? "" : (me()?.hand[slot] ?? "");
  $("hint").textContent = slot === -1 ? "" : "Click a pad on your grid to place it · Esc to cancel";
  for (let i = 0; i < HAND_SIZE; i++) $("hand").children[i]?.classList.toggle("selected", i === selected);
}

/** Clicking a unit card arms it for placement; clicking a spell casts it. */
function useSlot(slot: number) {
  const card = CARDS[me()?.hand[slot] ?? ""];
  if (!room || room.state.phase !== "playing" || !card) return;
  if (card.kind === "spell") {
    select(-1);
    room.send("play", { hand: slot });
  } else {
    select(selected === slot ? -1 : slot);
    sfx.click();
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
    playFxSounds(events);
  });
  room.onMessage("error", (message: string) => {
    toast(message);
    sfx.error();
  });
  room.onLeave(() => {
    room = null;
    heard = { tick: -1, grid: "", income: 0, phase: "" };
    select(-1);
    render();
  });
  render();
}

function main() {
  rendererReady = renderer.init($("stage"));
  renderer.onCell = (cell) => {
    if (selected === -1 || !room) return;
    room.send("play", { hand: selected, cell });
    select(-1);
  };
  for (let i = 0; i < HAND_SIZE; i++) {
    const button = document.createElement("button");
    button.className = "hand-card";
    button.onclick = () => useSlot(i);
    $("hand").appendChild(button);
  }
  $("invest").onclick = () => room?.send("invest");
  $("mute").textContent = isMuted() ? "🔇" : "🔊";
  $("mute").onclick = () => ($("mute").textContent = toggleMute() ? "🔇" : "🔊");
  window.addEventListener("keydown", (e) => {
    if (draft && e.key === "Escape") return closeDeck(false);
    if (room?.state.phase !== "playing" || e.target instanceof HTMLInputElement) return;
    if (e.key >= "1" && e.key <= String(HAND_SIZE)) useSlot(Number(e.key) - 1);
    else if (e.key === "Escape") select(-1);
    else if (e.key.toLowerCase() === "i") room.send("invest");
  });

  const name = () => ({ name: $<HTMLInputElement>("name").value.trim(), deck });
  $<HTMLInputElement>("name").value = localStorage.getItem("lanes.name") ?? "";
  $("create").onclick = () => enter(() => client.create("lanes", name(), LanesState));
  $("join").onclick = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    void enter(() => client.joinById(code, name(), LanesState));
  };
  $("start").onclick = () => room?.send("start");
  $("home-deck").onclick = openDeck;
  $("lobby-deck").onclick = openDeck;
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

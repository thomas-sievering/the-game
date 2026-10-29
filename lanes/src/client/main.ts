import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import { CARDS, type Card, type Role } from "../shared/cards";
import { BASE_HP, DRAW, type Fx, HAND_SIZE, MATCH_TICKS, SHRINE, TICK_RATE, WAVE_TICKS } from "../shared/sim";
import { LanesState, type PlayerState } from "../shared/state";
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

function show(screen: "home" | "lobby" | "game") {
  $("home").classList.toggle("hidden", screen !== "home");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("hud").classList.toggle("hidden", screen !== "game");
}

function me(): PlayerState | undefined {
  return room ? [...room.state.players].find((p) => p.id === room!.sessionId) : undefined;
}

function render() {
  const s = room?.state;
  if (!s) return show("home");
  if (s.phase === "lobby") {
    show("lobby");
    $("lobby-code").textContent = s.code;
    $("lobby-players").innerHTML = [...s.players].map((p) => `<li>${escapeHtml(p.name)}</li>`).join("");
    const isHost = s.hostId === room!.sessionId;
    $("start").classList.toggle("hidden", !isHost || s.players.length !== 2);
    $("lobby-wait").textContent = s.players.length < 2 ? "Waiting for an opponent…" : isHost ? "" : "Waiting for the host to start…";
    return;
  }
  show("game");
  const self = me();
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

function cardHtml(card: Card, slot: number, cooldown: number): string {
  const top = `<span class="cost">${card.cost}</span><span class="key">${slot + 1}</span>`;
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
  room.onMessage("fx", (events: Fx[]) => renderer.addFx(events));
  room.onMessage("error", (message: string) => toast(message));
  room.onLeave(() => {
    room = null;
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
  window.addEventListener("keydown", (e) => {
    if (room?.state.phase !== "playing" || e.target instanceof HTMLInputElement) return;
    if (e.key >= "1" && e.key <= String(HAND_SIZE)) useSlot(Number(e.key) - 1);
    else if (e.key === "Escape") select(-1);
    else if (e.key.toLowerCase() === "i") room.send("invest");
  });

  const name = () => ({ name: $<HTMLInputElement>("name").value.trim() });
  $<HTMLInputElement>("name").value = localStorage.getItem("lanes.name") ?? "";
  $("create").onclick = () => enter(() => client.create("lanes", name(), LanesState));
  $("join").onclick = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    void enter(() => client.joinById(code, name(), LanesState));
  };
  $("start").onclick = () => room?.send("start");
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
  get grid() {
    return [...(me()?.grid ?? [])];
  },
  get side() {
    return me()?.side ?? -1;
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

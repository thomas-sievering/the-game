import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import type { Hole, Point } from "../shared/hole";
import { HOLES } from "../shared/holes";
import { MAX_AIM_DISTANCE, type ShotResult, TICK_RATE, clockSubstep, simulateShot } from "../shared/physics";
import { MAX_PLAYERS } from "../shared/rules";
import { GolfState, type Phase, type PlayerState, type ShotMessage } from "../shared/state";
import { getMusicVolume, isMuted, setMusicVolume, sfx, startMusic, toggleMute } from "./audio";
import { type BallView, Renderer } from "./render";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2567` : location.origin;
const client = new Client(serverUrl);
const renderer = new Renderer();
/** Resolves once the canvas is ready. Buttons work before that; joining waits for it. */
let rendererReady: Promise<void> = Promise.resolve();

interface Anim {
  msg: ShotMessage;
  result: ShotResult;
  startedAt: number;
  nextEvent: number;
  done: boolean;
  stateArrived: boolean;
}

let room: Room<any, GolfState> | null = null;
let myName = localStorage.getItem("golf.name") ?? "";
let anim: Anim | null = null;
let waitingForShot = false;
let mouse: Point | null = null;
let turnSeq = -1;
let turnStartedAt = 0;
let leaving = false;

const stats = { shots: 0, checks: 0, desyncs: 0 };

// ── Helpers ──

function state(): GolfState | null {
  return room?.state ?? null;
}

function players(): PlayerState[] {
  return state() ? [...state()!.players] : [];
}

function me(): PlayerState | undefined {
  return players().find((p) => p.name === myName);
}

function spectators() {
  return state() ? [...state()!.spectators] : [];
}

/** My id as a player or a spectator. */
function myId(): string | undefined {
  return (me() ?? spectators().find((sp) => sp.name === myName))?.id;
}

const HOLES_BY_ID = new Map(HOLES.map((h) => [h.id, h]));

/** Holes drawn for this match, in play order. */
function matchHoles(s: GolfState): Hole[] {
  return [...s.holeIds].map((id) => HOLES_BY_ID.get(id)!);
}

function currentHole() {
  const s = state();
  return s && s.phase !== "lobby" ? (matchHoles(s)[s.holeIndex] ?? null) : null;
}

function isMyTurn(): boolean {
  const s = state();
  return !!s && s.phase === "playing" && !!me() && s.turnId === me()!.id;
}

function canShoot(): boolean {
  return isMyTurn() && !anim && !waitingForShot;
}

/** Where a player's ball currently is, or null if it is not on the course. */
function ballPosition(p: PlayerState): Point | null {
  const s = state()!;
  const hole = currentHole();
  if (!hole || p.dnf || p.holed || p.pickedUp) return null;
  if (p.onCourse) return [p.x, p.y];
  if (s.turnId === p.id && s.phase === "playing") return hole.tee;
  return null;
}

function show(id: string, visible: boolean) {
  $(id).classList.toggle("hidden", !visible);
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function dot(color: string) {
  return `<span class="dot" style="background:${color}"></span>`;
}

function setBanner(text: string | null) {
  $("banner").textContent = text ?? "";
  show("banner", !!text);
}

// ── Joining ──

function saveSession(code: string) {
  sessionStorage.setItem("golf.session", JSON.stringify({ code, name: myName }));
  history.replaceState(null, "", `?room=${code}`);
}

function clearSession() {
  sessionStorage.removeItem("golf.session");
  history.replaceState(null, "", location.pathname);
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|no rooms|invalid/i.test(msg)) return "No room with that code.";
  return msg || "Could not connect.";
}

async function enter(join: () => Promise<Room<any, GolfState>>) {
  $("home-error").textContent = "";
  const name = $<HTMLInputElement>("name").value.trim();
  if (!name) {
    $("home-error").textContent = "Pick a nickname first.";
    return;
  }
  myName = name.slice(0, 16);
  localStorage.setItem("golf.name", myName);
  try {
    await rendererReady;
    attach(await join());
  } catch (e) {
    $("home-error").textContent = errorMessage(e);
  }
}

function attach(r: Room<any, GolfState>) {
  room = r;
  leaving = false;
  anim = null;
  waitingForShot = false;
  turnSeq = -1;
  saveSession(r.roomId);

  r.onStateChange((s) => {
    // Patches queued before the shot (e.g. someone joining) can land after it; wait for the post-shot clock.
    if (anim && s.courseTick === anim.msg.startTick + anim.result.ticks) {
      anim.stateArrived = true;
      if (anim.done) finishAnim();
    }
    onState();
  });

  r.onMessage("shot", (msg: ShotMessage) => startAnim(msg));

  r.onDrop(() => setBanner("Connection lost, reconnecting…"));
  r.onReconnect(() => setBanner(null));
  r.onLeave(async (code) => {
    room = null;
    if (leaving || code === 4000) return;
    // Seat expired: rejoin by nickname, which the server allows within the reconnect window.
    const saved = sessionStorage.getItem("golf.session");
    if (saved) {
      try {
        const { code: roomCode } = JSON.parse(saved);
        attach(await client.joinById(roomCode, { name: myName }, GolfState));
        setBanner(null);
        return;
      } catch {}
    }
    setBanner(null);
    clearSession();
    onState();
    $("home-error").textContent = "Disconnected from the room.";
  });
  onState();
}

async function leave() {
  leaving = true;
  clearSession();
  const r = room;
  room = null;
  onState();
  await r?.leave(true);
}

// ── Shots ──

function startAnim(msg: ShotMessage) {
  waitingForShot = false;
  const hole = HOLES_BY_ID.get(msg.holeId)!;
  const result = simulateShot(hole, msg.start, msg.shooterId, msg.aim, { record: true, startTick: msg.startTick });
  anim = { msg, result, startedAt: performance.now(), nextEvent: 0, done: false, stateArrived: false };
  stats.shots++;
  renderer.clearTrails();
  const power = Math.min(1, Math.hypot(...msg.aim) / MAX_AIM_DISTANCE);
  sfx.hit(power);
}

function finishAnim() {
  if (!anim) return;
  // The server's authoritative positions must match our local replay exactly.
  for (const ball of anim.result.balls) {
    const p = players().find((pl) => pl.id === ball.id);
    if (!p || ball.holed) continue;
    stats.checks++;
    if (p.x !== ball.x || p.y !== ball.y) {
      stats.desyncs++;
      console.warn("desync", JSON.stringify({ local: ball, server: { x: p.x, y: p.y } }));
    }
  }
  anim = null;
  renderer.clearTrails();
}

function stepAnim(now: number) {
  if (!anim) return;
  const tick = Math.floor(((now - anim.startedAt) / 1000) * TICK_RATE);
  const { events, frames, ticks } = anim.result;
  if (anim.done) {
    // Safety net: never stay stuck if the post-shot state somehow does not match.
    if (tick > ticks + TICK_RATE * 3) finishAnim();
    return;
  }
  while (anim.nextEvent < events.length && events[anim.nextEvent].tick <= tick) {
    const e = events[anim.nextEvent++];
    const p = players().find((pl) => pl.id === e.id);
    if (e.type === "wall") sfx.wall(e.speed);
    else if (e.type === "ball") sfx.ball(e.speed);
    else if (e.type === "mover") sfx.mover(e.speed);
    else if (e.type === "bumper") {
      sfx.bumper(e.speed);
      renderer.bumperHit(e.index);
    } else if (e.type === "cup") {
      sfx.cup();
      renderer.burst(...HOLES_BY_ID.get(anim.msg.holeId)!.cup, p?.color ?? "#ffffff");
    } else if (e.type === "boost") sfx.boost();
    else if (e.type === "portal") {
      sfx.portal();
      renderer.portalHit(e.index);
      renderer.clearTrail(e.id);
    } else if (e.type === "splash") {
      sfx.splash();
      renderer.splash(e.x, e.y);
    }
  }
  if (tick >= ticks) {
    anim.done = true;
    if (anim.stateArrived) finishAnim();
    return;
  }
  const frame = frames![Math.min(tick, frames!.length - 1)];
  anim.msg.start.forEach((b, i) => {
    const x = frame[i * 2];
    if (!Number.isNaN(x)) renderer.addTrailPoint(b.id, x, frame[i * 2 + 1]);
  });
}

function animatedPositions(now: number): Map<string, Point | null> {
  const out = new Map<string, Point | null>();
  if (!anim) return out;
  if (anim.done) {
    for (const b of anim.result.balls) out.set(b.id, b.holed ? null : [b.x, b.y]);
    return out;
  }
  const tick = Math.floor(((now - anim.startedAt) / 1000) * TICK_RATE);
  const frame = anim.result.frames![Math.min(tick, anim.result.frames!.length - 1)];
  anim.msg.start.forEach((b, i) => {
    const x = frame[i * 2];
    out.set(b.id, Number.isNaN(x) ? null : [x, frame[i * 2 + 1]]);
  });
  return out;
}

/** Course-clock substep to draw moving obstacles at: follows the replay, otherwise the synced clock. */
function courseClock(now: number): number {
  if (anim) {
    const tick = anim.done ? anim.result.ticks : Math.floor(((now - anim.startedAt) / 1000) * TICK_RATE);
    return clockSubstep(anim.msg.startTick + Math.min(tick, anim.result.ticks));
  }
  return clockSubstep(state()?.courseTick ?? 0);
}

function shoot(aim: Point) {
  if (!canShoot()) return false;
  waitingForShot = true;
  room!.send("shoot", { aim });
  return true;
}

// ── UI ──

function onState() {
  const s = state();
  const phase: Phase | "" = s ? (s.phase as Phase) : "";

  show("home", !s);
  show("lobby", phase === "lobby");
  show("hud", phase === "playing" || phase === "holeEnd");
  show("scoreboard", phase === "holeEnd");
  show("podium", phase === "finished");
  renderer.setHole(phase === "playing" || phase === "holeEnd" ? currentHole() : null);

  if (!s) {
    return;
  }

  if (s.turnSeq !== turnSeq) {
    turnSeq = s.turnSeq;
    turnStartedAt = performance.now();
    waitingForShot = false;
    if (isMyTurn()) sfx.yourTurn();
  }

  const isHost = myId() === s.hostId;
  show("spectating", !me());
  if (phase === "lobby") renderLobby(s, isHost);
  if (phase === "playing" || phase === "holeEnd") renderHud(s);
  if (phase === "holeEnd") renderScoreboard(s);
  if (phase === "finished") renderPodium(s, isHost);
}

function renderLobby(s: GolfState, isHost: boolean) {
  $("lobby-code").textContent = s.code;
  const seatFree = players().length < MAX_PLAYERS;
  /** Host tag plus, for the host, a button that moves the person to the other list. */
  const rowEnd = (id: string, spectate: boolean) => {
    const tag = id === s.hostId ? '<span class="tag">host</span>' : "";
    const move =
      isHost && (spectate || seatFree)
        ? `<button class="link" data-id="${escapeHtml(id)}" data-spectate="${spectate}">${spectate ? "Spectate" : "Play"}</button>`
        : "";
    return `<span class="row-end">${tag}${move}</span>`;
  };
  $("lobby-players-title").textContent = `Players ${players().length}/${MAX_PLAYERS}`;
  $("lobby-players").innerHTML = players()
    .map((p) => `<li>${dot(p.color)}<span>${escapeHtml(p.name)}</span>${rowEnd(p.id, true)}</li>`)
    .join("");
  $("lobby-spectators").innerHTML = spectators()
    .map((sp) => `<li><span class="eye">👁</span><span>${escapeHtml(sp.name)}</span>${rowEnd(sp.id, false)}</li>`)
    .join("");
  show("lobby-spectators-box", spectators().length > 0);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#lobby button[data-id]")) {
    button.onclick = () => room?.send("spectate", { id: button.dataset.id, spectate: button.dataset.spectate === "true" });
  }
  show("start", isHost);
  $<HTMLButtonElement>("start").disabled = players().length === 0;
  $("lobby-wait").textContent = me() ? "Waiting for the host to start…" : "You're spectating. Waiting for the host to start…";
  show("lobby-wait", !isHost);
}

function renderHud(s: GolfState) {
  const hole = matchHoles(s)[s.holeIndex];
  $("hole-info").textContent = `Hole ${s.holeIndex + 1}/${s.holeCount} · ${hole.name} · Par ${hole.par}`;
  const turn = players().find((p) => p.id === s.turnId);
  const mine = isMyTurn();
  $("turn-info").textContent =
    s.phase !== "playing" ? "Hole complete" : mine ? "Your turn" : turn ? `${turn.name} is up` : "Waiting for players…";
  $("turn-info").classList.toggle("mine", mine);
  $("side-players").innerHTML = players()
    .map((p) => {
      const strokes = p.strokes[s.holeIndex] ?? 0;
      const total = [...p.strokes].reduce((a, b) => a + b, 0);
      const status = p.dnf ? "DNF" : !p.connected ? "away" : p.holed ? "⛳" : p.pickedUp ? "picked up" : "";
      const cls = [p.id === s.turnId ? "turn" : "", !p.connected || p.dnf ? "away" : ""].join(" ");
      return `<li class="${cls}">${dot(p.color)}<span>${escapeHtml(p.name)}</span><span class="score">${status} ${strokes} · ${total}</span></li>`;
    })
    .join("");
}

function scoreTable(s: GolfState, upTo: number) {
  const holes = matchHoles(s);
  const head = `<tr><th></th>${holes.map((_, i) => `<th>${i + 1}</th>`).join("")}<th>Total</th></tr>`;
  const par = `<tr><td class="name muted">Par</td>${holes.map((h) => `<td class="muted">${h.par}</td>`).join("")}<td class="muted">${holes.reduce((a, h) => a + h.par, 0)}</td></tr>`;
  const rows = sortedByTotal()
    .map(({ p, total }) => {
      const cells = holes
        .map((h, i) => {
          if (i > upTo) return "<td></td>";
          const v = p.strokes[i] ?? 0;
          const cls = v < h.par ? "under" : v > h.par ? "over" : "";
          return `<td class="${cls}">${v}</td>`;
        })
        .join("");
      return `<tr><td class="name"><span>${dot(p.color)}${escapeHtml(p.name)}${p.dnf ? " (DNF)" : ""}</span></td>${cells}<td class="total">${total}</td></tr>`;
    })
    .join("");
  return `<table class="scores">${head}${par}${rows}</table>`;
}

function sortedByTotal() {
  return players()
    .map((p) => ({ p, total: [...p.strokes].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => Number(a.p.dnf) - Number(b.p.dnf) || a.total - b.total);
}

function renderScoreboard(s: GolfState) {
  $("scoreboard-title").textContent = `Hole ${s.holeIndex + 1} done`;
  $("scoreboard-table").innerHTML = scoreTable(s, s.holeIndex);
  $("scoreboard-next").textContent = s.holeIndex + 1 >= s.holeCount ? "Final results coming up…" : `Next: ${matchHoles(s)[s.holeIndex + 1].name}`;
}

function renderPodium(s: GolfState, isHost: boolean) {
  const ranked = sortedByTotal();
  const places: number[] = [];
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    places.push(prev && prev.total === r.total && prev.p.dnf === r.p.dnf ? places[i - 1] : i + 1);
  });
  const order = [1, 0, 2].filter((i) => ranked[i]);
  $("podium-blocks").innerHTML = order
    .map((i) => {
      const { p, total } = ranked[i];
      return `<div class="step p${i + 1}"><div class="who">${dot(p.color)}${escapeHtml(p.name)}</div><div class="muted">${total} strokes</div><div class="block">${places[i]}</div></div>`;
    })
    .join("");
  $("podium-table").innerHTML = scoreTable(s, s.holeCount - 1);
  show("play-again", isHost);
  show("podium-wait", !isHost);
}

function tickUi(now: number) {
  const s = state();
  if (s && s.phase === "playing" && s.turnId) {
    const left = Math.max(0, s.turnMs - (now - turnStartedAt));
    $("timer").textContent = `${Math.ceil(left / 1000)}s`;
    $("timer").classList.toggle("low", left < 10_000);
  } else {
    $("timer").textContent = "–";
  }

  const aiming = canShoot() && mouse !== null;
  show("power", aiming);
  if (aiming) {
    const from = ballPosition(me()!)!;
    const power = Math.min(1, Math.hypot(mouse![0] - from[0], mouse![1] - from[1]) / MAX_AIM_DISTANCE);
    $("power-fill").style.width = `${power * 100}%`;
    $("power-fill").classList.toggle("max", power >= 1);
  }
  renderer.canvas.style.cursor = canShoot() ? "crosshair" : "default";
}

// ── Main loop ──

async function main() {
  rendererReady = renderer.init($("stage"));

  $<HTMLInputElement>("name").value = myName;
  const params = new URLSearchParams(location.search);
  if (params.get("room")) $<HTMLInputElement>("code").value = params.get("room")!.toUpperCase();

  $("create").onclick = () => enter(() => client.create("golf", { name: $<HTMLInputElement>("name").value.trim() }, GolfState));
  $("join").onclick = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    if (code.length !== 4) {
      $("home-error").textContent = "Room codes have 4 letters.";
      return;
    }
    void enter(() => client.joinById(code, { name: $<HTMLInputElement>("name").value.trim() }, GolfState));
  };
  $("code").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());
  $("name").addEventListener("keydown", (e) => e.key === "Enter" && ($<HTMLInputElement>("code").value ? $("join") : $("create")).click());
  $("start").onclick = () => room?.send("start");
  $("play-again").onclick = () => room?.send("playAgain");
  $("leave-lobby").onclick = () => void leave();
  $("leave-podium").onclick = () => void leave();
  $("copy-link").onclick = async () => {
    await navigator.clipboard.writeText(`${location.origin}/?room=${state()?.code}`);
    $("copy-link").textContent = "Link copied!";
    setTimeout(() => ($("copy-link").textContent = "Copy invite link"), 1500);
  };
  $("mute").textContent = isMuted() ? "🔇" : "🔊";
  $("mute").onclick = () => ($("mute").textContent = toggleMute() ? "🔇" : "🔊");
  const musicVolume = $<HTMLInputElement>("music-volume");
  musicVolume.value = String(Math.round(getMusicVolume() * 100));
  musicVolume.oninput = () => setMusicVolume(Number(musicVolume.value) / 100);
  // Browsers only allow audio after a user gesture.
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, startMusic, { once: true, capture: true });

  await rendererReady;
  renderer.canvas.addEventListener("pointermove", (e) => (mouse = renderer.screenToWorld(e.clientX, e.clientY)));
  renderer.canvas.addEventListener("pointerleave", () => (mouse = null));
  renderer.canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !canShoot()) return;
    const target = renderer.screenToWorld(e.clientX, e.clientY);
    const from = ballPosition(me()!)!;
    shoot([target[0] - from[0], target[1] - from[1]]);
  });

  let last = performance.now();
  renderer.app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stepAnim(now);
    tickUi(now);
    const s = state();
    if (!s || (s.phase !== "playing" && s.phase !== "holeEnd")) return;
    const animated = animatedPositions(now);
    const balls: BallView[] = [];
    for (const p of players()) {
      const pos = animated.has(p.id) ? animated.get(p.id)! : ballPosition(p);
      if (!pos) continue;
      balls.push({ id: p.id, x: pos[0], y: pos[1], color: p.color, name: p.name, isTurn: !anim && p.id === s.turnId, isMe: p.name === myName });
    }
    const aimFrom = canShoot() && me() ? ballPosition(me()!) : null;
    renderer.draw(dt, balls, aimFrom && mouse ? { from: aimFrom, to: mouse } : null, courseClock(now));
  });

  // Rejoin after a page refresh.
  const saved = sessionStorage.getItem("golf.session");
  if (saved) {
    try {
      const { code, name } = JSON.parse(saved);
      myName = name;
      attach(await client.joinById(code, { name }, GolfState));
    } catch {
      clearSession();
    }
  }
  onState();
}

// Hooks for automated end-to-end tests.
declare global {
  interface Window {
    __golf: unknown;
  }
}
window.__golf = {
  stats,
  get phase() {
    return state()?.phase ?? null;
  },
  get code() {
    return state()?.code ?? null;
  },
  get holeIndex() {
    return state()?.holeIndex ?? null;
  },
  get hole() {
    return currentHole();
  },
  get busy() {
    return !!anim;
  },
  get spectating() {
    return !!state() && !me();
  },
  isMyTurn: () => canShoot(),
  myBall: () => (me() ? ballPosition(me()!) : null),
  shoot: (dx: number, dy: number) => shoot([dx, dy]),
  scores: () => players().map((p) => ({ name: p.name, strokes: [...p.strokes], holed: p.holed, pickedUp: p.pickedUp })),
};

void main();

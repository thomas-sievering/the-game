import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import {
  BOT_NAMES,
  CAR,
  type Car,
  type CarStatus,
  DT,
  KEY,
  LAP_OPTIONS,
  MAX_CARS,
  type Race,
  type RaceEvent,
  TICK_RATE,
  createRace,
  lapTime,
  standings,
  stepCar,
  stepRace,
} from "../shared/sim";
import { type CarState, type InputMessage, RaceState } from "../shared/state";
import { TRACKS, TRACK_IDS, type Track, type TrackId, isTrackId } from "../shared/tracks";
import { getMusicVolume, isMuted, playSong, setMusicVolume, sfx, startEngine, stopEngine, toggleMute, unlockAudio, updateEngine } from "./audio";
import { CAR_COLORS, type CarView, Renderer, css, drawTrackThumb } from "./render";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2570` : location.origin;
const client = new Client(serverUrl);
const renderer = new Renderer();
let rendererReady: Promise<void> = Promise.resolve();

/** Remote cars are drawn this many ticks in the past, between two received states. */
const INTERP_TICKS = 3;
const SPEED_KMH = 0.42;
const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

let room: Room<any, RaceState> | null = null;

// Own car prediction: inputs are applied locally right away, and replayed on top of each server state.
let predicted: Car | null = null;
let prev = { x: 0, y: 0, hx: 1, hy: 0 };
let pending: InputMessage[] = [];
let seq = 0;
let acc = 0;
/** Visual-only offset that eases out corrections from the server. */
let offset = { x: 0, y: 0 };

/** Received positions of every car by tick, for interpolation. */
type Snap = { tick: number; x: number; y: number; hx: number; hy: number; vx: number; vy: number };
const snaps = new Map<string, Snap[]>();
let latestTick = 0;
let latestAt = 0;

/** The car the camera follows when you're not driving (spectating, finished or retired). */
let watchId: string | null = null;
let overview = false;
const held = new Set<string>();
let lastLight = -1;
let bannerTimer = 0;
let lapPopTimer = 0;
let toastTimer = 0;
let hudAt = 0;
/** A bots-only race that plays behind the home screen and lobby. */
let attract: Race | null = null;
let attractAcc = 0;
let lastCarCount = 0;

function show(screen: "home" | "lobby" | "game") {
  $("home").classList.toggle("hidden", screen !== "home");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("hud").classList.toggle("hidden", screen !== "game");
}

function myCar(): CarState | undefined {
  return room ? [...room.state.cars].find((c) => c.id === room!.sessionId) : undefined;
}

function isPlayer(): boolean {
  return !!room && [...room.state.players].some((p) => p.id === room!.sessionId);
}

function track(): Track {
  const id = room?.state.track;
  return TRACKS[isTrackId(id) ? id : "meadow"];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function chip(color: number): string {
  return `<span class="chip" style="background:${css(CAR_COLORS[color % CAR_COLORS.length])}"></span>`;
}

// ---------------------------------------------------------------- lobby

function renderLobby(s: RaceState) {
  show("lobby");
  $("lobby-code").textContent = s.code;
  const isHost = s.hostId === room!.sessionId;
  const seatFree = s.players.length + s.bots < MAX_CARS;
  for (const card of document.querySelectorAll<HTMLButtonElement>(".track-card")) {
    card.classList.toggle("selected", card.dataset.track === s.track);
    card.disabled = !isHost;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#laps button")) {
    b.classList.toggle("selected", Number(b.dataset.laps) === s.laps);
    b.disabled = !isHost;
  }
  $("bots-count").textContent = String(s.bots);
  $<HTMLButtonElement>("bots-less").disabled = !isHost || s.bots === 0;
  $<HTMLButtonElement>("bots-more").disabled = !isHost || !seatFree;

  const rowEnd = (id: string, spectate: boolean) => {
    const tag = id === s.hostId ? '<span class="tag">host</span>' : "";
    const you = id === room!.sessionId ? '<span class="tag you">you</span>' : "";
    const move =
      isHost && (spectate || seatFree)
        ? `<button data-id="${escapeHtml(id)}" data-spectate="${spectate}">${spectate ? "Spectate" : "Drive"}</button>`
        : "";
    return `<span class="row-end">${you}${tag}${move}</span>`;
  };
  $("lobby-players-title").textContent = `Drivers ${s.players.length + s.bots}/${MAX_CARS}`;
  const taken = new Set([...s.players].map((p) => p.color));
  const botColors = Array.from({ length: MAX_CARS }, (_, i) => i).filter((c) => !taken.has(c));
  $("lobby-players").innerHTML =
    [...s.players].map((p) => `<li>${chip(p.color)}${escapeHtml(p.name)}${rowEnd(p.id, true)}</li>`).join("") +
    Array.from({ length: s.bots }, (_, i) => `<li class="bot">${chip(botColors[i])}${BOT_NAMES[botColors[i]]}<span class="row-end"><span class="tag">AI</span></span></li>`).join("");
  $("lobby-spectators").innerHTML = [...s.spectators].map((sp) => `<li>👁 ${escapeHtml(sp.name)}${rowEnd(sp.id, false)}</li>`).join("");
  $("lobby-spectators-box").classList.toggle("hidden", s.spectators.length === 0);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#lobby-players button[data-id], #lobby-spectators button[data-id]")) {
    button.onclick = () => room?.send("spectate", { id: button.dataset.id, spectate: button.dataset.spectate === "true" });
  }
  const ready = s.players.length + s.bots > 0;
  $("start").classList.toggle("hidden", !isHost || !ready);
  const spectating = !isPlayer() ? "You're spectating. " : "";
  $("lobby-wait").textContent = isHost
    ? ready
      ? s.players.length === 1 && s.bots === 0
        ? "Share the code, add bots, or race alone."
        : ""
      : "Add a driver or a bot to start."
    : `${spectating}Waiting for the host to start…`;
}

function buildLobby() {
  $("tracks").innerHTML = TRACK_IDS.map(
    (id) =>
      `<button class="track-card" data-track="${id}"><canvas width="220" height="150"></canvas>` +
      `<span class="track-name">${TRACKS[id].name}</span><span class="track-blurb">${TRACKS[id].blurb}</span></button>`,
  ).join("");
  for (const card of document.querySelectorAll<HTMLButtonElement>(".track-card")) {
    drawTrackThumb(card.querySelector("canvas")!, TRACKS[card.dataset.track as TrackId]);
    card.onclick = () => {
      sfx.click();
      room?.send("track", { id: card.dataset.track });
    };
  }
  $("laps").innerHTML = LAP_OPTIONS.map((n) => `<button data-laps="${n}">${n}</button>`).join("");
  for (const b of document.querySelectorAll<HTMLButtonElement>("#laps button")) b.onclick = () => room?.send("laps", { laps: Number(b.dataset.laps) });
  $("bots-less").onclick = () => room?.send("bots", { count: (room?.state.bots ?? 0) - 1 });
  $("bots-more").onclick = () => room?.send("bots", { count: (room?.state.bots ?? 0) + 1 });
  $("start").onclick = () => room?.send("start");
  $("leave-lobby").onclick = () => void room?.leave();
}

// ---------------------------------------------------------------- race HUD

function render() {
  const s = room?.state;
  if (!s) {
    show("home");
    playSong("meadow");
    return;
  }
  playSong(track().id);
  if (s.phase === "lobby") return renderLobby(s);
  show("game");
  $("result").classList.toggle("hidden", s.phase !== "finished");
  if (s.phase === "finished") renderResult(s);
  else delete $("result").dataset.key;
}

function renderResult(s: RaceState) {
  const isHost = s.hostId === room!.sessionId;
  const cars = [...s.cars].sort((a, b) => a.place - b.place);
  const key = `${cars.map((c) => `${c.id}${c.place}${c.status}`).join()}|${isHost}`;
  if ($("result").dataset.key === key) return;
  $("result").dataset.key = key;
  const mine = myCar();
  const title = mine ? (mine.status === "finished" ? `You finished ${ORDINAL[mine.place]}!` : "Race over") : `${cars[0]?.name ?? "Nobody"} wins!`;
  const medal = (place: number) => ["", "🥇", "🥈", "🥉"][place] ?? String(place);
  const rows = cars
    .map((c) => {
      const time = c.status === "finished" ? lapTime(c.finishTick - s.startTick) : c.status === "retired" ? "Retired" : "DNF";
      return (
        `<tr class="${c.id === room!.sessionId ? "me" : ""}"><td class="place">${medal(c.place)}</td><td>${chip(c.color)}${escapeHtml(c.name)}${c.bot ? ' <span class="tag">AI</span>' : ""}</td>` +
        `<td class="num">${time}</td><td class="num">${c.bestLap ? lapTime(c.bestLap) : "–"}</td></tr>`
      );
    })
    .join("");
  $("result").innerHTML =
    `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(track().name)} · ${s.laps} lap${s.laps === 1 ? "" : "s"}</p>` +
    `<table class="results"><tr><th></th><th>Driver</th><th class="num">Time</th><th class="num">Best lap</th></tr>${rows}</table>` +
    (isHost ? '<button id="again" class="primary">Back to lobby</button>' : '<p class="muted">Waiting for the host…</p>') +
    '<button id="leave-result" class="link">Leave</button>';
  const again = document.getElementById("again");
  if (again) again.onclick = () => room?.send("lobby");
  $("leave-result").onclick = () => void room?.leave();
}

/** Text HUD; refreshed a few times a second. */
function renderHud(s: RaceState, focus: CarState | undefined) {
  const t = track();
  const mine = myCar();
  const per = t.checkpoints.length;
  const cars = [...s.cars].sort((a, b) => a.place - b.place);
  const leader = cars[0];
  $("standings").innerHTML = cars
    .map((c) => {
      const lap = Math.min(s.laps, Math.floor(c.cp / per) + 1);
      const note =
        c.status === "finished" ? `🏁 ${lapTime(c.finishTick - s.startTick)}` : c.status === "retired" ? "out" : c.ghost ? "away" : leader && c !== leader ? gap(s, leader, c) : `L${lap}`;
      const classes = [c.id === room!.sessionId ? "me" : "", focus && c.id === focus.id ? "watched" : "", c.status !== "racing" ? "done" : ""].join(" ");
      return `<li class="${classes}" data-id="${escapeHtml(c.id)}"><b>${c.place}</b>${chip(c.color)}<span class="name">${escapeHtml(c.name)}</span><span class="note">${note}</span></li>`;
    })
    .join("");
  for (const li of $("standings").querySelectorAll<HTMLElement>("li")) {
    li.onclick = () => {
      watchId = li.dataset.id ?? null;
      overview = false;
    };
  }
  const shown = focus ?? leader;
  const racing = s.tick >= s.startTick;
  if (shown) {
    const lap = Math.min(s.laps, Math.floor(shown.cp / per) + 1);
    $("lap").innerHTML = `LAP <b>${lap}</b>/${s.laps}`;
    const now = shown.status === "finished" ? shown.finishTick : s.tick;
    $("race-time").textContent = lapTime(racing ? now - s.startTick : 0);
    $("best-lap").textContent = shown.bestLap ? `Best ${lapTime(shown.bestLap)}` : shown.status === "racing" && racing ? `Lap ${lapTime(s.tick - shown.lapStart)}` : "";
    $("position").innerHTML = `<b>${ORDINAL[shown.place] ?? ""}</b><small>/${s.cars.length}</small>`;
  }
  const driving = !!mine && mine.status === "racing";
  $("spectating").classList.toggle("hidden", driving);
  $("spectating").textContent = overview ? "Overview" : shown ? `Watching ${shown.name}` : "";
  $("retire").classList.toggle("hidden", !driving || s.phase !== "racing");
  $("speedo").classList.toggle("hidden", !shown || overview);
  const endsIn = s.endTick ? Math.max(0, Math.ceil((s.endTick - s.tick) / TICK_RATE)) : 0;
  $("help").innerHTML = driving
    ? s.tick < s.startTick + 6 * TICK_RATE
      ? "<kbd>↑</kbd> gas · <kbd>↓</kbd> brake / reverse · <kbd>←</kbd><kbd>→</kbd> steer · hit the glowing pads to boost"
      : endsIn
        ? `Race ends in ${endsIn} s`
        : ""
    : `<kbd>←</kbd><kbd>→</kbd> switch car · <kbd>O</kbd> ${overview ? "follow" : "overview"}${endsIn ? ` · race ends in ${endsIn} s` : ""}`;
}

/** Gap to the leader in seconds, estimated from the distance between them at a typical speed. */
function gap(s: RaceState, leader: CarState, car: CarState): string {
  const t = track();
  const per = t.checkpoints.length;
  const laps = Math.floor(leader.cp / per) - Math.floor(car.cp / per);
  if (laps > 1) return `+${laps} laps`;
  const n = t.path.length;
  const distance = (c: CarState) => c.cp * (n / per) + Math.min((n / per) * 1.5, (c.seg - t.checkpoints[c.cp % per] + n) % n);
  const seconds = Math.max(0, ((distance(leader) - distance(car)) * t.spacing) / (CAR.maxSpeed * 0.8));
  return `+${seconds.toFixed(1)}`;
}

function updateLights(s: RaceState) {
  const left = s.startTick - s.tick;
  const n = left > 0 ? Math.ceil(left / TICK_RATE) : 0;
  const lights = $("lights");
  const visible = s.phase === "racing" && left > -TICK_RATE;
  lights.classList.toggle("hidden", !visible);
  if (!visible) {
    lastLight = -1;
    return;
  }
  const lit = Math.min(3, 3 - n + 1);
  [...lights.children].forEach((el, i) => {
    el.classList.toggle("on", n > 0 && i < lit);
    el.classList.toggle("go", n === 0);
  });
  if (n !== lastLight) {
    if (lastLight !== -1 || n > 0) sfx.light(n);
    if (n === 0) banner("GO!", 900);
    lastLight = n;
  }
}

function banner(text: string, ms = 1600) {
  const el = $("banner");
  el.textContent = text;
  el.classList.remove("hidden");
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => el.classList.add("hidden"), ms);
}

function toast(message: string) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 2500);
}

function onFx(events: RaceEvent[]) {
  const s = room?.state;
  if (!s) return;
  const views = new Map(currentViews.map((v) => [v.id, v]));
  const focusId = currentFocus?.id;
  for (const e of events) {
    renderer.fx(e, views);
    const mine = e.car === room!.sessionId;
    const name = [...s.cars].find((c) => c.id === e.car)?.name ?? "Someone";
    if (e.type === "lap") {
      if (!mine) continue;
      const pop = $("lap-pop");
      pop.innerHTML = `Lap ${e.lap} · ${lapTime(e.ticks)}${e.best ? ' <span class="best">best</span>' : ""}`;
      pop.classList.remove("hidden");
      clearTimeout(lapPopTimer);
      lapPopTimer = window.setTimeout(() => pop.classList.add("hidden"), 2200);
      if (e.lap === s.laps - 1) {
        banner("FINAL LAP");
        sfx.finalLap();
      } else if (e.lap < s.laps) sfx.lap(e.best);
    } else if (e.type === "finish") {
      if (mine) {
        banner(`FINISHED ${ORDINAL[e.place]}!`, 3000);
        sfx.finish(e.place);
        watchId = null;
      } else if (e.place === 1) {
        toast(`${name} wins!`);
        if (!myCar()) sfx.finish(2);
      }
    } else if (e.type === "bump") {
      if (mine || e.car === focusId) sfx.bump(e.strength);
    } else if (e.type === "boost") {
      if (mine || (e.car === focusId && !myCar())) sfx.boost();
    }
  }
}

// ---------------------------------------------------------------- input and prediction

function keys(): number {
  let k = 0;
  if (held.has("ArrowUp") || held.has("KeyW")) k |= KEY.up;
  if (held.has("ArrowDown") || held.has("KeyS")) k |= KEY.down;
  if (held.has("ArrowLeft") || held.has("KeyA")) k |= KEY.left;
  if (held.has("ArrowRight") || held.has("KeyD")) k |= KEY.right;
  return k;
}

function toCar(c: CarState): Car {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    bot: c.bot,
    x: c.x,
    y: c.y,
    vx: c.vx,
    vy: c.vy,
    hx: c.hx,
    hy: c.hy,
    seg: c.seg,
    boost: c.boost,
    offroad: c.offroad,
    input: c.input,
    cp: c.cp,
    lapStart: c.lapStart,
    lastLap: c.lastLap,
    bestLap: c.bestLap,
    status: c.status as CarStatus,
    finishTick: c.finishTick,
    ghost: c.ghost,
  };
}

/** Runs one local tick of the own car and sends the input. */
function driveTick(s: RaceState, car: CarState) {
  if (!predicted) return;
  const k = car.status === "racing" ? keys() : 0;
  seq++;
  room!.send("input", { seq, keys: k });
  pending.push({ seq, keys: k });
  if (pending.length > 60) pending.splice(0, pending.length - 60);
  prev = { x: predicted.x, y: predicted.y, hx: predicted.hx, hy: predicted.hy };
  // The server is roughly as many ticks ahead as there are unacknowledged inputs.
  stepCar(track(), predicted, k, s.tick + pending.length < s.startTick);
}

/** Rebuilds the prediction from the server's car plus the inputs it hasn't applied yet. */
function reconcile(s: RaceState, car: CarState) {
  pending = pending.filter((p) => p.seq > car.ack);
  const base = toCar(car);
  pending.forEach((p, i) => stepCar(track(), base, car.status === "racing" ? p.keys : 0, s.tick + i + 1 < s.startTick));
  if (predicted) {
    const dx = predicted.x - base.x;
    const dy = predicted.y - base.y;
    if (dx * dx + dy * dy > 150 * 150) {
      offset = { x: 0, y: 0 };
      prev = { x: base.x, y: base.y, hx: base.hx, hy: base.hy };
    } else {
      offset = { x: offset.x + dx, y: offset.y + dy };
      prev = { x: prev.x - dx, y: prev.y - dy, hx: prev.hx, hy: prev.hy };
    }
  } else {
    prev = { x: base.x, y: base.y, hx: base.hx, hy: base.hy };
  }
  predicted = base;
}

function onPatch() {
  const s = room?.state;
  if (!s) return;
  if (s.phase === "lobby") {
    predicted = null;
    pending = [];
    snaps.clear();
    return;
  }
  if (s.cars.length !== lastCarCount) {
    lastCarCount = s.cars.length;
    renderer.clearSkids();
  }
  if (s.tick !== latestTick) {
    latestTick = s.tick;
    latestAt = performance.now();
    for (const c of s.cars) {
      let list = snaps.get(c.id);
      if (!list) snaps.set(c.id, (list = []));
      list.push({ tick: s.tick, x: c.x, y: c.y, hx: c.hx, hy: c.hy, vx: c.vx, vy: c.vy });
      if (list.length > 20) list.shift();
    }
  }
  const mine = myCar();
  if (mine && s.phase === "racing") reconcile(s, mine);
}

function interpolated(c: CarState): Snap {
  const list = snaps.get(c.id);
  if (!list?.length) return { tick: 0, x: c.x, y: c.y, hx: c.hx, hy: c.hy, vx: c.vx, vy: c.vy };
  const at = latestTick + Math.min(2, (performance.now() - latestAt) / (1000 / TICK_RATE)) - INTERP_TICKS;
  if (at <= list[0].tick) return list[0];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a.tick > at) continue;
    const b = list[i + 1];
    if (!b) {
      // Past the newest state: carry on along its velocity for a moment.
      const ahead = Math.min(3, at - a.tick) * DT;
      return { ...a, x: a.x + a.vx * ahead, y: a.y + a.vy * ahead };
    }
    const f = (at - a.tick) / (b.tick - a.tick);
    const lerp = (p: number, q: number) => p + (q - p) * f;
    const hx = lerp(a.hx, b.hx);
    const hy = lerp(a.hy, b.hy);
    const len = Math.sqrt(hx * hx + hy * hy) || 1;
    return { tick: at, x: lerp(a.x, b.x), y: lerp(a.y, b.y), hx: hx / len, hy: hy / len, vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy) };
  }
  return list[list.length - 1];
}

// ---------------------------------------------------------------- frame loop

let currentViews: CarView[] = [];
let currentFocus: CarView | null = null;

function frame(dt: number) {
  dt = Math.min(dt, 0.1);
  const s = room?.state;
  if (!s || s.phase === "lobby") {
    runAttract(dt, s ? track() : TRACKS.meadow);
    return;
  }
  attract = null;
  renderer.setTrack(track());
  const mine = myCar();
  if (mine && s.phase === "racing" && predicted) {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      driveTick(s, mine);
    }
  }
  const alpha = Math.min(1, acc / DT);
  const decay = Math.exp(-dt * 10);
  offset = { x: offset.x * decay, y: offset.y * decay };

  const views: CarView[] = [...s.cars].map((c) => {
    const faded = c.ghost || c.status === "retired";
    if (c.id === room!.sessionId && predicted && s.phase === "racing") {
      const hx = prev.hx + (predicted.hx - prev.hx) * alpha;
      const hy = prev.hy + (predicted.hy - prev.hy) * alpha;
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        x: prev.x + (predicted.x - prev.x) * alpha + offset.x,
        y: prev.y + (predicted.y - prev.y) * alpha + offset.y,
        hx,
        hy,
        vx: predicted.vx,
        vy: predicted.vy,
        input: predicted.input,
        boost: predicted.boost,
        offroad: predicted.offroad,
        faded,
        me: true,
      };
    }
    const p = interpolated(c);
    return { id: c.id, name: c.name, color: c.color, x: p.x, y: p.y, hx: p.hx, hy: p.hy, vx: p.vx, vy: p.vy, input: c.input, boost: c.boost, offroad: c.offroad, faded, me: c.id === room!.sessionId };
  });

  // Follow your own car while you race; otherwise the watched car, falling back to the leader.
  const driving = mine && mine.status === "racing";
  let focusState: CarState | undefined = driving ? mine : [...s.cars].find((c) => c.id === watchId);
  if (!focusState) focusState = mine && mine.status === "finished" && s.phase === "finished" ? mine : [...s.cars].sort((a, b) => a.place - b.place)[0];
  const focus = views.find((v) => v.id === focusState?.id) ?? null;
  currentViews = views;
  currentFocus = focus;
  renderer.frame(views, focus, overview && !driving, dt);

  if (focus && s.phase === "racing" && !overview) {
    startEngine();
    const speed = Math.sqrt(focus.vx * focus.vx + focus.vy * focus.vy);
    const lat = Math.abs(-focus.vx * focus.hy + focus.vy * focus.hx);
    updateEngine(speed / CAR.maxSpeed, (focus.input & KEY.up) !== 0, Math.max(0, (lat - 60) / 200), focus.offroad, focus.boost > 0);
    $("speed").textContent = String(Math.round(speed * SPEED_KMH));
    $("boost-fill").style.width = `${(focus.boost / CAR.boostTicks) * 100}%`;
  } else {
    stopEngine();
  }
  updateLights(s);
  const now = performance.now();
  if (now - hudAt > 150) {
    hudAt = now;
    renderHud(s, focusState);
  }
}

/** Bots race on the home screen and in the lobby, with the camera on the leader. */
function runAttract(dt: number, t: Track) {
  stopEngine();
  if (!attract || attract.track !== t || attract.over) {
    attract = createRace(
      t.id,
      99,
      Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, name: "", color: i, bot: true })),
    );
    attract.tick = attract.startTick - 1;
    renderer.setTrack(t);
    renderer.clearSkids();
  }
  attractAcc += dt;
  while (attractAcc >= DT) {
    attractAcc -= DT;
    stepRace(attract, new Map());
    for (const e of attract.events) if (e.type !== "lap" && e.type !== "finish") renderer.fx(e, new Map());
    attract.events.length = 0;
  }
  const views: CarView[] = attract.cars.map((c) => ({ ...c, faded: false, me: false, name: "" }));
  const lead = standings(attract)[0];
  renderer.frame(views, views.find((v) => v.id === lead.id) ?? null, false, dt);
}

// ---------------------------------------------------------------- setup

async function enter(join: () => Promise<Room<any, RaceState>>) {
  $("home-error").textContent = "";
  localStorage.setItem("racer.name", $<HTMLInputElement>("name").value.trim());
  unlockAudio();
  try {
    await rendererReady;
    room = await join();
  } catch (err) {
    $("home-error").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  predicted = null;
  pending = [];
  seq = 0;
  watchId = null;
  overview = false;
  snaps.clear();
  room.onStateChange(() => {
    const s = room!.state;
    // A new race: start predicting from the grid.
    if (s.phase === "racing" && !predicted) {
      const mine = myCar();
      if (mine) {
        predicted = toCar(mine);
        prev = { x: mine.x, y: mine.y, hx: mine.hx, hy: mine.hy };
        pending = [];
        acc = 0;
      }
      lastLight = -1;
      renderer.clearSkids();
    }
    onPatch();
    render();
  });
  room.onMessage("fx", onFx);
  room.onMessage("error", (message: string) => {
    sfx.error();
    toast(message);
  });
  room.onLeave(() => {
    room = null;
    predicted = null;
    stopEngine();
    render();
  });
  render();
}

function cycleWatch(step: number) {
  const s = room?.state;
  if (!s || !s.cars.length) return;
  const cars = [...s.cars].sort((a, b) => a.place - b.place);
  const current = Math.max(0, cars.findIndex((c) => c.id === (watchId ?? currentFocus?.id)));
  watchId = cars[(current + step + cars.length) % cars.length].id;
  overview = false;
}

function main() {
  rendererReady = renderer.init($("stage")).then(() => {
    renderer.app.ticker.add((ticker) => frame(ticker.deltaMS / 1000));
  });
  buildLobby();
  const name = () => ({ name: $<HTMLInputElement>("name").value.trim() });
  $<HTMLInputElement>("name").value = localStorage.getItem("racer.name") ?? "";
  $("create").onclick = () => enter(() => client.create("racer", name(), RaceState));
  const join = () => {
    const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
    if (code.length !== 4) {
      $("home-error").textContent = "Enter a 4-letter room code";
      return;
    }
    void enter(() => client.joinById(code, name(), RaceState));
  };
  $("join").onclick = join;
  $("code").onkeydown = (e) => {
    if (e.key === "Enter") join();
  };
  $("retire").onclick = () => {
    room?.send("retire");
    $("retire").blur();
  };

  const mute = $("mute");
  const showMute = () => (mute.textContent = isMuted() ? "🔇" : "🔊");
  showMute();
  mute.onclick = () => {
    unlockAudio();
    toggleMute();
    showMute();
  };
  const volume = $<HTMLInputElement>("music-volume");
  volume.value = String(Math.round(getMusicVolume() * 100));
  volume.oninput = () => {
    unlockAudio();
    setMusicVolume(Number(volume.value) / 100);
  };
  window.addEventListener("pointerdown", () => unlockAudio(), { once: true });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    unlockAudio();
    if (e.code.startsWith("Arrow")) e.preventDefault();
    held.add(e.code);
    if (e.code === "KeyM") {
      toggleMute();
      showMute();
    }
    const s = room?.state;
    const mine = myCar();
    const driving = mine && mine.status === "racing" && s?.phase === "racing";
    if (!s || s.phase === "lobby" || driving) return;
    if (e.code === "ArrowLeft") cycleWatch(-1);
    if (e.code === "ArrowRight") cycleWatch(1);
    if (e.code === "KeyO") overview = !overview;
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  // Let go of everything when the window loses focus so the car doesn't drive on by itself.
  window.addEventListener("blur", () => held.clear());
  document.addEventListener("visibilitychange", () => held.clear());
  render();
}

main();

// Test hooks for the Playwright suite.
(window as any).__racer = {
  get phase() {
    return room?.state.phase ?? null;
  },
  get track() {
    return room?.state.track ?? null;
  },
  get me() {
    const c = myCar();
    return c ? { x: c.x, y: c.y, cp: c.cp, status: c.status, place: c.place, speed: Math.sqrt(c.vx * c.vx + c.vy * c.vy) } : null;
  },
  get predicted() {
    return predicted ? { x: predicted.x, y: predicted.y } : null;
  },
  get cars() {
    return room ? [...room.state.cars].map((c) => ({ id: c.id, name: c.name, status: c.status, place: c.place, cp: c.cp, bot: c.bot })) : [];
  },
  get started() {
    return !!room && room.state.phase === "racing" && room.state.tick >= room.state.startTick;
  },
  get spectating() {
    return !!room && !isPlayer();
  },
  get focus() {
    return currentFocus?.name ?? null;
  },
  get overview() {
    return overview;
  },
  send(type: string, message: unknown) {
    room?.send(type, message);
  },
};

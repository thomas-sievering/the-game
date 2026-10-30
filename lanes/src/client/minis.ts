import type { Graphics } from "pixi.js";
import { CARDS, SIZE } from "../shared/cards";

/** Colours shared by the painted miniatures, the board and its props. */
export const TABLE = {
  ink: 0x2a1d14,
  wood: 0x8a5a34,
  woodLight: 0xa8733f,
  woodDark: 0x5e3b20,
  steel: 0xcfd3d8,
  skin: 0xe6bd92,
  stone: 0xa39d90,
  stoneDark: 0x726c61,
  cloth: 0xf3ead8,
  bomb: 0x2b2b30,
  spark: 0xffd166,
};

/** Scales each colour channel; below 1 darkens, above 1 moves toward white. */
export function shade(color: number, k: number): number {
  const channel = (shift: number) => {
    const c = (color >> shift) & 0xff;
    return Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1));
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** Linear blend from `a` to `b`. */
export function mix(a: number, b: number, t: number): number {
  const channel = (shift: number) => Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export interface MiniStyle {
  /** Team paint. */
  paint: number;
  alpha?: number;
  /** Rim colour of the base, for levelled units. */
  rim?: number;
  /** Seconds, for small animations like a bomb fuse or a pennant. */
  time?: number;
}

/**
 * A painted miniature standing on a round base, facing right, with its base centred on (0, 0).
 * `r` is the base radius; the figure stands about 2.2 r tall. Callers mirror and move it with
 * the Graphics transform.
 */
export function drawMini(g: Graphics, cardId: string, r: number, style: MiniStyle): void {
  const card = CARDS[cardId];
  if (card?.kind !== "unit") return;
  const { paint, alpha = 1, rim, time = 0 } = style;
  const u = r;
  const ink = { color: TABLE.ink, width: Math.max(1.2, r / 11), alpha };
  const fill = (color: number) => ({ color, alpha });
  const dark = shade(paint, 0.62);

  // Base: a painted coin with a visible edge.
  g.ellipse(0, u * 0.16, u, u * 0.48).fill(fill(shade(paint, 0.35))).stroke(ink);
  g.ellipse(0, 0, u, u * 0.48).fill(fill(dark)).stroke(rim === undefined ? ink : { color: rim, width: Math.max(2.5, r / 5), alpha });

  const y0 = -u * 0.08;
  /** A meeple-like body `w` wide and `h` tall, leaning forward by `lean`. */
  const body = (w: number, h: number, color = paint, lean = 0) => {
    g.poly([
      -w * 0.5 * u, y0,
      w * 0.5 * u, y0,
      (w * 0.42 + lean * 0.75) * u, y0 - h * 0.72 * u,
      (w * 0.26 + lean) * u, y0 - h * u,
      (-w * 0.26 + lean) * u, y0 - h * u,
      (-w * 0.42 + lean * 0.75) * u, y0 - h * 0.72 * u,
    ]).fill(fill(color)).stroke(ink);
    // A dry-brushed highlight on the lit side.
    g.ellipse((-w * 0.18 + lean * 0.5) * u, y0 - h * 0.6 * u, w * 0.1 * u, h * 0.26 * u).fill({ color: 0xffffff, alpha: alpha * 0.22 });
  };
  const head = (x: number, y: number, rad: number, color = TABLE.skin) => g.circle(x * u, y * u, rad * u).fill(fill(color)).stroke(ink);
  const line = (x1: number, y1: number, x2: number, y2: number, color: number, width: number) =>
    g.moveTo(x1 * u, y1 * u).lineTo(x2 * u, y2 * u).stroke({ color, width: width * u, alpha, cap: "round" });
  const outlinedLine = (x1: number, y1: number, x2: number, y2: number, color: number, width: number) => {
    g.moveTo(x1 * u, y1 * u).lineTo(x2 * u, y2 * u).stroke({ color: TABLE.ink, width: width * u + ink.width * 2, alpha, cap: "round" });
    line(x1, y1, x2, y2, color, width);
  };

  switch (cardId) {
    case "footman": {
      body(1.2, 1.0);
      head(0, -1.38, 0.36);
      g.ellipse(0, -1.5 * u, 0.38 * u, 0.2 * u).fill(fill(TABLE.steel)).stroke(ink);
      g.circle(0.48 * u, -0.6 * u, 0.4 * u).fill(fill(shade(paint, 0.8))).stroke(ink);
      g.circle(0.48 * u, -0.6 * u, 0.13 * u).fill(fill(TABLE.steel)).stroke(ink);
      break;
    }
    case "spearman": {
      body(1.15, 1.0);
      head(0, -1.38, 0.36);
      g.ellipse(0, -1.5 * u, 0.38 * u, 0.2 * u).fill(fill(TABLE.steel)).stroke(ink);
      outlinedLine(0.55, 0.05, 0.78, -2.15, TABLE.wood, 0.1);
      g.poly([0.7 * u, -2.1 * u, 0.86 * u, -2.12 * u, 0.8 * u, -2.5 * u]).fill(fill(TABLE.steel)).stroke(ink);
      g.circle(0.6 * u, -0.7 * u, 0.13 * u).fill(fill(TABLE.skin)).stroke(ink);
      break;
    }
    case "knight": {
      // Cape behind the body.
      g.poly([-0.5 * u, y0, -0.15 * u, -1.05 * u, -0.85 * u, -0.1 * u]).fill(fill(dark)).stroke(ink);
      body(1.3, 1.1);
      head(0, -1.48, 0.38, TABLE.steel);
      line(0.06, -1.5, 0.34, -1.5, TABLE.ink, 0.07);
      g.poly([0 * u, -1.86 * u, -0.25 * u, -2.15 * u, -0.7 * u, -1.95 * u, -0.3 * u, -1.8 * u]).fill(fill(paint)).stroke(ink);
      outlinedLine(0.5, -0.45, 1.05, -1.55, TABLE.steel, 0.12);
      line(0.36, -0.68, 0.72, -0.5, TABLE.woodDark, 0.1);
      break;
    }
    case "archer": {
      g.roundRect(-0.62 * u, -1.15 * u, 0.28 * u, 0.7 * u, 0.08 * u).fill(fill(TABLE.woodDark)).stroke(ink);
      line(-0.52, -1.15, -0.62, -1.4, TABLE.cloth, 0.06);
      body(1.0, 0.95);
      head(0, -1.3, 0.34, dark);
      head(0.12, -1.26, 0.2);
      // Bow: an arc in front of the body, its string closing it.
      const [ex, ey] = [0.2 + Math.cos(1.1) * 0.75, Math.sin(1.1) * 0.75];
      line(ex, -0.75 - ey, ex, -0.75 + ey, TABLE.cloth, 0.03);
      for (const [color, width] of [[TABLE.ink, 0.14 * u + ink.width * 2], [TABLE.wood, 0.14 * u]]) {
        g.moveTo(ex * u, (-0.75 - ey) * u).arc(0.2 * u, -0.75 * u, 0.75 * u, -1.1, 1.1).stroke({ color, width, alpha });
      }
      break;
    }
    case "sniper": {
      body(1.0, 0.95, shade(paint, 0.78));
      head(0, -1.3, 0.34, dark);
      head(0.12, -1.26, 0.2);
      outlinedLine(-0.35, -0.72, 1.45, -0.86, TABLE.woodDark, 0.15);
      line(1.45, -0.86, 1.95, -0.9, TABLE.steel, 0.08);
      g.roundRect(0.3 * u, -1.06 * u, 0.45 * u, 0.14 * u, 0.05 * u).fill(fill(TABLE.ink));
      break;
    }
    case "runner": {
      body(0.95, 0.9, paint, 0.3);
      head(0.3, -1.22, 0.32);
      const wave = Math.sin(time * 14) * 0.08;
      line(0.05, -1.3, -0.55, -1.2 + wave, paint, 0.12);
      line(0.05, -1.3, -0.45, -1.42 - wave, shade(paint, 0.8), 0.1);
      break;
    }
    case "swarm": {
      const wiggle = Math.sin(time * 18) * 0.06;
      g.moveTo(-0.7 * u, -0.35 * u).quadraticCurveTo(-1.15 * u, -0.6 * u + wiggle * u, -1.1 * u, -0.95 * u).stroke({ color: TABLE.ink, width: 0.08 * u, alpha, cap: "round" });
      g.ellipse(-0.05 * u, -0.4 * u, 0.75 * u, 0.5 * u).fill(fill(paint)).stroke(ink);
      g.ellipse(-0.2 * u, -0.6 * u, 0.3 * u, 0.15 * u).fill({ color: 0xffffff, alpha: alpha * 0.25 });
      g.circle(0.68 * u, -0.48 * u, 0.36 * u).fill(fill(shade(paint, 0.85))).stroke(ink);
      g.circle(0.55 * u, -0.86 * u, 0.15 * u).fill(fill(TABLE.skin)).stroke(ink);
      g.circle(0.82 * u, -0.55 * u, 0.06 * u).fill(fill(TABLE.ink));
      g.circle(1.02 * u, -0.42 * u, 0.07 * u).fill(fill(TABLE.ink));
      break;
    }
    case "brute": {
      body(1.55, 0.95);
      line(-0.62, -0.25, 0.55, -0.85, TABLE.woodDark, 0.14);
      head(0.05, -1.22, 0.3);
      g.poly([-0.2 * u, -1.42 * u, -0.38 * u, -1.75 * u, -0.08 * u, -1.5 * u]).fill(fill(TABLE.cloth)).stroke(ink);
      g.poly([0.3 * u, -1.42 * u, 0.48 * u, -1.75 * u, 0.18 * u, -1.5 * u]).fill(fill(TABLE.cloth)).stroke(ink);
      head(-0.85, -0.5, 0.3);
      head(0.88, -0.55, 0.32);
      break;
    }
    case "golem": {
      g.roundRect(-1.0 * u, -1.15 * u, 0.4 * u, 0.85 * u, 0.12 * u).fill(fill(TABLE.stoneDark)).stroke(ink);
      g.roundRect(-0.72 * u, -1.35 * u, 1.44 * u, 1.3 * u, 0.2 * u).fill(fill(TABLE.stone)).stroke(ink);
      g.roundRect(-0.36 * u, -1.82 * u, 0.72 * u, 0.52 * u, 0.12 * u).fill(fill(TABLE.stone)).stroke(ink);
      g.rect(-0.72 * u, -0.95 * u, 1.44 * u, 0.22 * u).fill(fill(paint));
      g.rect(0.0 * u, -1.64 * u, 0.12 * u, 0.1 * u).fill(fill(shade(paint, 1.5)));
      g.rect(0.2 * u, -1.64 * u, 0.12 * u, 0.1 * u).fill(fill(shade(paint, 1.5)));
      line(-0.4, -1.25, -0.2, -1.05, TABLE.stoneDark, 0.05);
      line(0.3, -0.6, 0.45, -0.35, TABLE.stoneDark, 0.05);
      g.roundRect(0.6 * u, -1.15 * u, 0.4 * u, 0.85 * u, 0.12 * u).fill(fill(TABLE.stoneDark)).stroke(ink);
      break;
    }
    case "bomber": {
      body(1.1, 0.95);
      head(0, -1.3, 0.34);
      line(-0.32, -1.36, 0.32, -1.36, TABLE.woodDark, 0.12);
      g.circle(0.2 * u, -1.36 * u, 0.1 * u).fill(fill(TABLE.steel)).stroke(ink);
      g.circle(0.6 * u, -0.5 * u, 0.33 * u).fill(fill(TABLE.bomb)).stroke(ink);
      g.circle(0.5 * u, -0.6 * u, 0.08 * u).fill({ color: 0xffffff, alpha: alpha * 0.4 });
      line(0.72, -0.8, 0.85, -1.0, TABLE.wood, 0.05);
      g.circle(0.88 * u, -1.05 * u, (0.08 + 0.05 * Math.abs(Math.sin(time * 20))) * u).fill(fill(TABLE.spark));
      break;
    }
    case "catapult": {
      const wave = Math.sin(time * 6) * 0.08;
      line(0.78, -0.25, 0.78, -1.55, TABLE.woodDark, 0.07);
      g.poly([0.8 * u, -1.55 * u, 1.35 * u, (-1.42 + wave) * u, 0.8 * u, -1.25 * u]).fill(fill(paint)).stroke(ink);
      outlinedLine(-0.1, -0.65, 0.25, -0.35, TABLE.woodDark, 0.12);
      outlinedLine(0.4, -0.65, 0.15, -0.35, TABLE.woodDark, 0.12);
      outlinedLine(0.25, -0.65, -0.85, -1.3, TABLE.wood, 0.13);
      g.circle(-0.9 * u, -1.38 * u, 0.24 * u).fill(fill(TABLE.woodDark)).stroke(ink);
      g.circle(-0.9 * u, -1.46 * u, 0.15 * u).fill(fill(TABLE.stone)).stroke(ink);
      g.roundRect(-0.95 * u, -0.48 * u, 1.85 * u, 0.28 * u, 0.06 * u).fill(fill(paint)).stroke(ink);
      for (const wx of [-0.6, 0.6]) {
        g.circle(wx * u, -0.15 * u, 0.25 * u).fill(fill(TABLE.woodDark)).stroke(ink);
        g.circle(wx * u, -0.15 * u, 0.07 * u).fill(fill(TABLE.steel));
      }
      break;
    }
    case "medic": {
      g.roundRect(-0.68 * u, -0.85 * u, 0.32 * u, 0.4 * u, 0.06 * u).fill(fill(TABLE.wood)).stroke(ink);
      body(1.05, 1.0);
      head(0, -1.36, 0.34);
      g.ellipse(0, -1.58 * u, 0.32 * u, 0.13 * u).fill(fill(TABLE.cloth)).stroke(ink);
      g.rect(0.04 * u, -0.78 * u, 0.36 * u, 0.12 * u).fill(fill(TABLE.cloth));
      g.rect(0.16 * u, -0.9 * u, 0.12 * u, 0.36 * u).fill(fill(TABLE.cloth));
      break;
    }
    default:
      body(1.1, 1.0);
      head(0, -1.35, 0.34);
  }
}

/** How tall a miniature stands above its base centre, for health bars and floaters. */
export function miniHeight(cardId: string, r: number): number {
  const tall: Record<string, number> = { swarm: 1.2, catapult: 1.7, golem: 1.9, spearman: 2.5, knight: 2.2 };
  return (tall[cardId] ?? 1.8) * r;
}

export function miniRadius(cardId: string): number {
  const card = CARDS[cardId];
  return card?.kind === "unit" ? SIZE[card.role] : 14;
}

/** Spell emblem centred on (0, 0), about `s` in radius. */
export function drawSpellIcon(g: Graphics, cardId: string, s: number): void {
  const ink = { color: TABLE.ink, width: Math.max(1.5, s / 12) };
  switch (cardId) {
    case "rally":
      for (const dx of [-0.35, 0.3]) {
        g.moveTo((dx - 0.3) * s, -0.6 * s).lineTo((dx + 0.25) * s, 0).lineTo((dx - 0.3) * s, 0.6 * s)
          .stroke({ color: TABLE.ink, width: 0.32 * s, cap: "round", join: "round" })
          .moveTo((dx - 0.3) * s, -0.6 * s).lineTo((dx + 0.25) * s, 0).lineTo((dx - 0.3) * s, 0.6 * s)
          .stroke({ color: 0xffd166, width: 0.2 * s, cap: "round", join: "round" });
      }
      break;
    case "lightning":
      g.poly([0.15 * s, -0.95 * s, -0.5 * s, 0.1 * s, -0.05 * s, 0.1 * s, -0.25 * s, 0.95 * s, 0.5 * s, -0.2 * s, 0.05 * s, -0.2 * s])
        .fill(0xfff3a0).stroke(ink);
      break;
    case "mend":
      g.poly([
        -0.25 * s, -0.75 * s, 0.25 * s, -0.75 * s, 0.25 * s, -0.25 * s, 0.75 * s, -0.25 * s, 0.75 * s, 0.25 * s, 0.25 * s, 0.25 * s,
        0.25 * s, 0.75 * s, -0.25 * s, 0.75 * s, -0.25 * s, 0.25 * s, -0.75 * s, 0.25 * s, -0.75 * s, -0.25 * s, -0.25 * s, -0.25 * s,
      ]).fill(0x7fd38a).stroke(ink);
      break;
    case "frost":
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3 + Math.PI / 2;
        const [dx, dy] = [Math.cos(a) * 0.85 * s, Math.sin(a) * 0.85 * s];
        g.moveTo(-dx, -dy).lineTo(dx, dy).stroke({ color: TABLE.ink, width: 0.22 * s, cap: "round" });
      }
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3 + Math.PI / 2;
        const [dx, dy] = [Math.cos(a) * 0.85 * s, Math.sin(a) * 0.85 * s];
        g.moveTo(-dx, -dy).lineTo(dx, dy).stroke({ color: 0xcdeeff, width: 0.12 * s, cap: "round" });
      }
      g.circle(0, 0, 0.18 * s).fill(0xffffff).stroke(ink);
      break;
    case "meteor":
      g.poly([0.95 * s, -0.95 * s, 0.25 * s, -0.55 * s, 0.05 * s, -0.2 * s, 0.55 * s, 0.05 * s]).fill(0xff9a3c).stroke(ink);
      g.poly([0.6 * s, -0.75 * s, 0.15 * s, -0.4 * s, 0.4 * s, -0.15 * s]).fill(0xffe0a0);
      g.circle(-0.2 * s, 0.25 * s, 0.5 * s).fill(TABLE.stoneDark).stroke(ink);
      g.circle(-0.35 * s, 0.15 * s, 0.12 * s).fill(TABLE.stone);
      break;
    case "fury":
      g.poly([0, -0.95 * s, 0.35 * s, -0.35 * s, 0.6 * s, -0.55 * s, 0.6 * s, 0.25 * s, 0.3 * s, 0.85 * s, -0.3 * s, 0.85 * s, -0.6 * s, 0.25 * s, -0.55 * s, -0.4 * s, -0.25 * s, -0.2 * s])
        .fill(0xff5a3c).stroke(ink);
      g.poly([0, -0.2 * s, 0.25 * s, 0.25 * s, 0.15 * s, 0.75 * s, -0.15 * s, 0.75 * s, -0.25 * s, 0.25 * s]).fill(0xffd166);
      break;
    case "muster":
      g.moveTo(-0.5 * s, 0.95 * s).lineTo(-0.5 * s, -0.95 * s).stroke({ color: TABLE.ink, width: 0.2 * s, cap: "round" })
        .moveTo(-0.5 * s, 0.95 * s).lineTo(-0.5 * s, -0.95 * s).stroke({ color: TABLE.woodLight, width: 0.1 * s, cap: "round" });
      g.poly([-0.45 * s, -0.9 * s, 0.85 * s, -0.6 * s, 0.4 * s, -0.3 * s, 0.85 * s, 0, -0.45 * s, -0.1 * s]).fill(0x4f8fe0).stroke(ink);
      break;
    default:
      g.star(0, 0, 5, 0.8 * s, 0.4 * s).fill(0xffd166).stroke(ink);
  }
}

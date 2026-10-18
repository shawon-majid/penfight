/**
 * The look of everything around the game: a walnut desk at night under one
 * warm lamp, glossy pens, and soft champagne for the few things that should
 * catch the eye.
 *
 * Shared by the boot screen and the screens that follow it, so they all come
 * from the same desk. Canvas only — nothing here knows about the DOM beyond
 * the canvas it is handed.
 */

import type { PlayerColour } from './theme';

/** Warm pearl text and champagne accents. Kept soft on purpose: nothing glows. */
export const INK = {
  night: '#08070a',
  title: '#ece9e4',
  text: '#efece7',
  dim: '#8f8a82',
  caption: '#8a857d',
  tip: '#98938a',
  champagne: '#cdb894',
  onChampagne: '#211a10',
} as const;

export const FONT_SERIF = '"Fraunces Variable", Georgia, serif';
export const FONT_SANS = '"Inter Variable", system-ui, sans-serif';

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));
export const easeOutCubic = (k: number): number => 1 - Math.pow(1 - k, 3);
export const easeInOutCubic = (k: number): number =>
  k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
/** Overshoots a little and settles — a pen landing. */
export const easeOutBack = (k: number): number => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
};

/** Same grain every time the page loads, so the desk does not shuffle on resize. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walnut planks with wavy grain, drawn once and reused every frame. */
export function makeWoodTexture(width: number, height: number, pixelRatio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  g.scale(pixelRatio, pixelRatio);
  const random = seededRandom(20261017);

  const plankHeight = Math.max(70, height / 5);
  const planks = Math.ceil(height / plankHeight);
  for (let p = 0; p < planks; p++) {
    g.fillStyle = `hsl(24, ${40 + (p % 2) * 6}%, ${19 + ((p * 7) % 5)}%)`;
    g.fillRect(0, p * plankHeight, width, plankHeight + 1);
  }

  const lines = Math.round((width * height) / 900);
  for (let i = 0; i < lines; i++) {
    const y = random() * height;
    const amplitude = 1 + random() * 5;
    const frequency = 0.003 + random() * 0.02;
    const phase = random() * 6;
    g.beginPath();
    for (let x = 0; x <= width; x += 6) {
      const yy = y + Math.sin(x * frequency + phase) * amplitude;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.strokeStyle =
      random() < 0.72
        ? `rgba(20, 8, 0, ${0.06 + random() * 0.14})`
        : `rgba(255, 205, 150, ${0.03 + random() * 0.06})`;
    g.lineWidth = 0.4 + random() * 1.8;
    g.stroke();
  }

  for (let p = 1; p < planks; p++) {
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(0, p * plankHeight, width, 1.5);
    g.fillStyle = 'rgba(255, 210, 160, 0.08)';
    g.fillRect(0, p * plankHeight + 1.5, width, 1);
  }
  return canvas;
}

interface Mote {
  x: number;
  y: number;
  speed: number;
  radius: number;
  phase: number;
}

/**
 * The backdrop: the desk, the dark room around it, the lamp's pool of light
 * and dust drifting through it.
 */
export class Desk {
  private wood: HTMLCanvasElement | null = null;
  private motes: Mote[] = [];
  private width = 0;
  private height = 0;
  private readonly calm: boolean;

  constructor(calm = false) {
    this.calm = calm;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (width === this.width && height === this.height && this.wood) return;
    this.width = width;
    this.height = height;
    this.wood = makeWoodTexture(width, height, pixelRatio);
    const count = this.calm ? 0 : Math.round(clamp((width * height) / 4000, 30, 110));
    this.motes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      speed: 4 + Math.random() * 8,
      radius: 0.4 + Math.random() * 1.4,
      phase: Math.random() * 6,
    }));
  }

  /** The wood texture, for drawing smaller tables and card art from the same grain. */
  get texture(): HTMLCanvasElement | null {
    return this.wood;
  }

  /**
   * @param lamp 0 is the room dark, 1 the lamp fully on.
   * @param lampX/lampY where the light is centred.
   * @param dim extra darkness on top, for screens that sit over the desk.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    lamp: number,
    time: number,
    dt: number,
    lampX: number,
    lampY: number,
    dim = 0,
  ): void {
    const { width: w, height: h } = this;
    if (this.wood) ctx.drawImage(this.wood, 0, 0, w, h);
    const reach = Math.max(w, h) * 0.75;

    let g = ctx.createRadialGradient(lampX, lampY, 20, lampX, lampY + h * 0.1, reach);
    g.addColorStop(0, 'rgba(5, 7, 12, 0)');
    g.addColorStop(0.5, 'rgba(5, 7, 12, 0.5)');
    g.addColorStop(1, 'rgba(4, 5, 9, 0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = `rgba(4, 5, 9, ${clamp((1 - lamp) * 0.95 + dim)})`;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    g = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY + h * 0.05, reach * 0.7);
    g.addColorStop(0, `rgba(255, 185, 110, ${0.2 * lamp})`);
    g.addColorStop(1, 'rgba(255, 185, 110, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#ffd9a0';
    const lightRadius = reach * 0.6;
    for (const mote of this.motes) {
      mote.y -= mote.speed * dt * 0.4;
      mote.x += Math.sin(time * 0.5 + mote.phase) * dt * 3;
      if (mote.y < -5) {
        mote.y = h + 5;
        mote.x = Math.random() * w;
      }
      const inLight = clamp(1 - Math.hypot(mote.x - lampX, mote.y - lampY) / lightRadius);
      ctx.globalAlpha = lamp * inLight * (0.35 + 0.3 * Math.sin(time * 2 + mote.phase));
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Brushed champagne metal — the loading line, buttons, the table rim. */
export function champagneGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#6f5f45');
  g.addColorStop(0.35, '#bfa983');
  g.addColorStop(0.5, '#efe4cd');
  g.addColorStop(0.65, INK.champagne);
  g.addColorStop(1, '#63543c');
  return g;
}

/**
 * A lacquered pen lying on the desk, centred on (x, y), its tip pointing
 * along `angle`.
 *
 * @param lift 0 resting on the desk; above that it is held in the air — bigger,
 *   with a softer shadow further away.
 * @param radius half the barrel's thickness. Left out, it is in proportion
 *   to the length; the game passes the physics radius so what you see is
 *   what gets hit.
 */
export function drawPen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  colour: PlayerColour,
  lift = 0,
  alpha = 1,
  radius?: number,
): void {
  const r = radius ?? length * 0.058;
  const size = 1 + lift * 0.4;
  const x0 = -length / 2;
  const x1 = length / 2;
  const tipStart = x1 - length * 0.15;
  const capEnd = x0 + length * 0.33;

  // The shadow is cast by a copy drawn far off to the side, with the shadow
  // offset bringing it back. Shadow offsets ignore the transform, so this
  // works however the pen is turned, and needs no `filter` (Safari has none).
  const { a, b } = ctx.getTransform();
  const pixelScale = Math.hypot(a, b);
  const away = 10000;
  ctx.save();
  ctx.globalAlpha = alpha * (1 - lift * 0.3);
  ctx.shadowColor = `rgba(0, 0, 0, ${0.55 - clamp(lift) * 0.3})`;
  ctx.shadowBlur = (5 + lift * 14) * pixelScale;
  ctx.shadowOffsetX = (away + 4 + lift * 24) * pixelScale;
  ctx.shadowOffsetY = (7 + lift * 30) * pixelScale;
  ctx.translate(x - away, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(x0, -r, length, 2 * r, r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);

  // Barrel: dark at the edges, a bright stripe where the lamp catches it.
  let g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, colour.cap);
  g.addColorStop(0.28, colour.body);
  g.addColorStop(0.42, colour.accent);
  g.addColorStop(0.6, colour.body);
  g.addColorStop(1, '#120b0b');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x0, -r, tipStart - x0, 2 * r, r * 0.4);
  ctx.fill();

  // Steel tip.
  g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, '#4d525a');
  g.addColorStop(0.4, '#f2f4f7');
  g.addColorStop(1, '#5d6168');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(tipStart, -r * 0.9);
  ctx.lineTo(x1 - length * 0.025, -r * 0.2);
  ctx.lineTo(x1, 0);
  ctx.lineTo(x1 - length * 0.025, r * 0.2);
  ctx.lineTo(tipStart, r * 0.9);
  ctx.closePath();
  ctx.fill();

  // Cap.
  g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, '#08080a');
  g.addColorStop(0.35, colour.cap);
  g.addColorStop(0.48, colour.body);
  g.addColorStop(1, '#060608');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x0 - 1, -r * 1.1, capEnd - x0, r * 2.2, r);
  ctx.fill();

  // Champagne trim: cap band, tip collar, clip.
  ctx.fillStyle = champagneGradient(ctx, 0, -r, 0, r);
  ctx.fillRect(capEnd - 4, -r * 1.1, 3.2, r * 2.2);
  ctx.fillRect(tipStart - 2, -r, 2, 2 * r);
  ctx.beginPath();
  ctx.roundRect(x0 + length * 0.05, -r * 1.5, length * 0.22, r * 0.5, r * 0.25);
  ctx.fill();

  // Gloss.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.beginPath();
  ctx.roundRect(x0 + 5, -r * 0.62, length * 0.8, r * 0.24, r * 0.12);
  ctx.fill();
  ctx.restore();
}

/**
 * The playing table seen from above: lamp-warmed walnut with a champagne
 * brass rim, sitting on the desk with a deep shadow.
 *
 * @param wood a texture at least the table's size, from `makeWoodTexture`.
 */
export function drawTable(
  ctx: CanvasRenderingContext2D,
  wood: HTMLCanvasElement,
  cx: number,
  cy: number,
  w: number,
  h: number,
  radius: number,
): void {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const { a, b } = ctx.getTransform();
  const pixelScale = Math.hypot(a, b);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 50 * pixelScale;
  ctx.shadowOffsetY = 24 * pixelScale;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = '#2a170b';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  ctx.drawImage(wood, x, y, w, h);
  const light = ctx.createRadialGradient(cx, cy - h * 0.25, 10, cx, cy, Math.max(w, h) * 0.75);
  light.addColorStop(0, 'rgba(255, 200, 140, 0.26)');
  light.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, h);
  // A shadow just inside the rim, so the top reads as recessed.
  ctx.lineWidth = 18;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = champagneGradient(ctx, x, y, x + w, y + h);
  ctx.shadowColor = 'rgba(205, 184, 148, 0.3)';
  ctx.shadowBlur = 10 * pixelScale;
  ctx.stroke();
  ctx.restore();
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  radius: number;
  colour: string;
}

interface Ring {
  x: number;
  y: number;
  colour: string;
  grow: number;
  start: number;
  duration: number;
  progress: number;
}

/** Little bursts of light: a pen landing, a player sitting down, the bar filling. */
export class Sparks {
  private sparks: Spark[] = [];
  private rings: Ring[] = [];

  burst(x: number, y: number, count: number, colour: string, speed = 140): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.25 + Math.random());
      this.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: 1,
        decay: 0.9 + Math.random() * 0.9,
        radius: 0.8 + Math.random() * 2,
        colour,
      });
    }
  }

  /** One drifting fleck, for ink coming off a nib. */
  fleck(x: number, y: number, colour: string): void {
    this.sparks.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 30,
      vy: -10 - Math.random() * 25,
      life: 1,
      decay: 2,
      radius: 0.8,
      colour,
    });
  }

  ring(x: number, y: number, colour: string, grow = 40, start = 10, duration = 0.7): void {
    this.rings.push({ x, y, colour, grow, start, duration, progress: 0 });
  }

  clear(): void {
    this.sparks = [];
    this.rings = [];
  }

  draw(ctx: CanvasRenderingContext2D, dt: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.sparks = this.sparks.filter((s) => (s.life -= dt * s.decay) > 0);
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.95;
      s.vy *= 0.95;
      ctx.globalAlpha = s.life;
      ctx.fillStyle = s.colour;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    this.rings = this.rings.filter((r) => (r.progress += dt / r.duration) < 1);
    for (const r of this.rings) {
      ctx.globalAlpha = (1 - r.progress) * 0.9;
      ctx.strokeStyle = r.colour;
      ctx.lineWidth = 2 * (1 - r.progress) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.start + r.grow * easeOutCubic(r.progress), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

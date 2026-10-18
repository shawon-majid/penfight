/**
 * The first thing on screen: the lamp comes on over the desk, the name
 * appears, and a pen writes the loading line.
 *
 * index.html loads this as its own small entry point, ahead of the game, so it
 * is up while everything else downloads. The game imports the same module —
 * one instance — to report progress with `boot.reach()` and to hand over with
 * `boot.finish()` once the lobby is ready underneath.
 */

import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource-variable/inter/wght.css';

import { PLAYER_COLOURS } from '../render/theme';
import {
  Desk,
  FONT_SANS,
  FONT_SERIF,
  INK,
  Sparks,
  champagneGradient,
  clamp,
  drawPen,
  easeOutCubic,
} from '../render/premium';

export type BootStep = 'fonts' | 'game' | 'account';

/** How much of the line each step is worth. They add up to one. */
const STEP_WEIGHTS: Record<BootStep, number> = { fonts: 0.2, game: 0.4, account: 0.4 };

/** The lamp warms up before the pen starts writing. */
const LAMP_SECONDS = 0.5;
/**
 * Fastest the line may fill, per second — quick, but still a stroke of the
 * pen rather than a jump. In `npm run dev`, `?slowboot` in the address slows it
 * right down so the screen can be looked at properly.
 */
const MAX_FILL_PER_SECOND =
  import.meta.env.DEV && new URLSearchParams(location.search).has('slowboot') ? 0.08 : 3;
/** A beat on the finished line before the screen lifts. */
const HOLD_SECONDS = 0.15;
const FADE_SECONDS = 0.35;
/** Give up waiting on the fonts; the fallbacks are fine. */
const FONT_TIMEOUT_MS = 2500;

const TIPS = [
  'Grab a tip of the pen to send it spinning.',
  'A longer pull hits harder.',
  'Grab the middle and it slides straight.',
  'Stay away from the edge. Make them go over it.',
];
const TIP_SECONDS = 2.8;

class BootScreen {
  private readonly root: HTMLElement | null;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private readonly desk = new Desk(this.calm);
  private readonly sparks = new Sparks();
  private readonly logo = document.createElement('canvas');

  private readonly reached = new Set<BootStep>();
  private shown = 0;
  private startedAt: number | null = null;
  private lastFrame: number | null = null;
  private finishing = false;
  private filledAt: number | null = null;
  private done: Promise<void> | null = null;
  private resolveDone: (() => void) | null = null;
  private readonly firstTip = Math.floor(Math.random() * TIPS.length);

  constructor(root: HTMLElement | null) {
    this.root = root;
    this.canvas = root?.querySelector('canvas') ?? null;
    this.ctx = this.canvas?.getContext('2d') ?? null;
    if (!this.root || !this.ctx) return;

    void waitForFonts().then(() => this.reach('fonts'));
    requestAnimationFrame(this.frame);
  }

  /** One part of loading is done; the line catches up to it. */
  reach(step: BootStep): void {
    this.reached.add(step);
  }

  /** Everything is ready: fill the rest of the line, then lift the screen away. */
  finish(): Promise<void> {
    if (!this.done) {
      this.done = new Promise((resolve) => {
        this.resolveDone = resolve;
      });
      this.finishing = true;
      // Nobody is watching a background tab, and it gets no frames to animate
      // the ending with — step straight aside.
      if (!this.root || !this.ctx || document.hidden) this.remove();
    }
    return this.done;
  }

  private get target(): number {
    if (this.finishing) return 1;
    let total = 0;
    for (const step of this.reached) total += STEP_WEIGHTS[step];
    // Hold back the last sliver until finish() — the line never sits full while
    // the lobby is still on its way.
    return Math.min(total, 0.95);
  }

  private remove(): void {
    this.root?.remove();
    // index.html reads this to skip the screen on later loads in this tab.
    try {
      sessionStorage.setItem('penfight:booted', '1');
    } catch {
      // Storage blocked: the screen just shows every time, as before.
    }
    this.resolveDone?.();
  }

  private frame = (now: number): void => {
    const { ctx, canvas, root } = this;
    if (!ctx || !canvas || !root) return;

    this.startedAt ??= now;
    const t = (now - this.startedAt) / 1000;
    const dt = this.lastFrame === null ? 0 : Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // Fill toward the target, never faster than a pen could write it.
    if (t > LAMP_SECONDS * 0.3) {
      this.shown = Math.min(this.target, this.shown + dt * MAX_FILL_PER_SECOND);
    }
    const full = this.finishing && this.shown >= 1;
    if (full && this.filledAt === null) this.filledAt = t;

    this.draw(t, now / 1000, dt);

    if (this.filledAt !== null && t - this.filledAt > HOLD_SECONDS) {
      if (!root.classList.contains('leaving')) {
        root.classList.add('leaving');
        root.style.transitionDuration = `${FADE_SECONDS}s`;
        setTimeout(() => this.remove(), FADE_SECONDS * 1000);
      }
    }
    if (root.isConnected) requestAnimationFrame(this.frame);
  };

  private draw(t: number, time: number, dt: number): void {
    const ctx = this.ctx!;
    const canvas = this.canvas!;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * pixelRatio) || canvas.height !== Math.round(h * pixelRatio)) {
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.desk.resize(w, h, pixelRatio);

    // Everything is sized off one unit, so it holds together from a phone to a monitor.
    const u = clamp(Math.min(w / 420, h / 620), 0.8, 1.6);
    const cx = w / 2;
    const cy = h / 2;

    const lamp = easeOutCubic(clamp(t / LAMP_SECONDS));
    this.desk.draw(ctx, lamp, time, dt, cx, cy - 140 * u);

    // The name, rising into place, with one shine across it.
    const appear = clamp((t - 0.05) / 0.35);
    const logoY = cy - 70 * u + 8 * u * (1 - easeOutCubic(appear));
    this.drawLogo(cx, logoY, 58 * u, (t - 0.2) / 0.8, appear, pixelRatio);
    text(ctx, 'THE LAST PEN STANDING', cx, cy - 22 * u, `500 ${10 * u}px ${FONT_SANS}`, INK.caption, 5 * u, appear);

    // The line the pen writes.
    const lineWidth = Math.min(280 * u, w * 0.7);
    const x0 = cx - lineWidth / 2;
    const x1 = cx + lineWidth / 2;
    const y = cy + 64 * u;
    const nib = x0 + (x1 - x0) * this.shown;

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    if (this.shown > 0) {
      ctx.strokeStyle = champagneGradient(ctx, x0, y - 2, x1, y + 2);
      ctx.lineWidth = 2.4;
      ctx.shadowColor = 'rgba(205, 184, 148, 0.45)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(nib, y);
      ctx.stroke();
    }
    ctx.restore();

    const writing = this.shown > 0 && this.shown < 1;
    if (writing && !this.calm && Math.random() < 0.5) this.sparks.fleck(nib, y, '#e9dcc0');

    // The pen, held as if writing: tip on the line, end up and to the right.
    const penLength = 100 * u;
    const angle = 2.25;
    const wobble = writing && !this.calm ? Math.sin(time * 24) * 0.8 : 0;
    drawPen(
      ctx,
      nib - (Math.cos(angle) * penLength) / 2 + wobble,
      y - (Math.sin(angle) * penLength) / 2 - 1,
      angle,
      penLength,
      PLAYER_COLOURS[0],
      0,
      appear,
    );

    if (this.filledAt === t && !this.calm) {
      this.sparks.ring(nib, y, 'rgba(239, 228, 205, 0.8)', 46 * u);
      this.sparks.burst(nib, y, 26, '#e9dcc0', 150 * u);
    }
    this.sparks.draw(ctx, dt);

    text(
      ctx,
      `LOADING   ${Math.round(this.shown * 100)}%`,
      cx,
      y + 30 * u,
      `500 ${10 * u}px ${FONT_SANS}`,
      INK.caption,
      3 * u,
      appear,
    );

    // A tip, fading in and out if loading takes a while.
    const tipIndex = (this.firstTip + Math.floor(t / TIP_SECONDS)) % TIPS.length;
    const phase = (t % TIP_SECONDS) / TIP_SECONDS;
    const tipAlpha = appear * clamp(Math.min(phase, 1 - phase) * 8);
    ctx.save();
    ctx.font = `italic 400 ${15 * u}px ${FONT_SERIF}`;
    const fits = ctx.measureText(TIPS[tipIndex]).width < w - 32;
    ctx.restore();
    text(
      ctx,
      TIPS[tipIndex],
      cx,
      y + 82 * u,
      `italic 400 ${(fits ? 15 : 13) * u}px ${FONT_SERIF}`,
      INK.tip,
      0,
      tipAlpha,
    );
  }

  /** The name in warm pearl, with a soft shine passing over it once. */
  private drawLogo(x: number, y: number, size: number, shine: number, alpha: number, pixelRatio: number): void {
    const ctx = this.ctx!;
    const font = `500 ${size}px ${FONT_SERIF}`;
    const spacing = size * 0.08;
    if (shine <= 0 || shine >= 1) {
      text(ctx, 'PEN FIGHT', x, y, font, INK.title, spacing, alpha, true);
      return;
    }
    const w = size * 7;
    const h = size * 1.8;
    const off = this.logo;
    off.width = Math.round(w * pixelRatio);
    off.height = Math.round(h * pixelRatio);
    const g = off.getContext('2d');
    if (!g) return;
    g.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    text(g, 'PEN FIGHT', w / 2, h / 2, font, INK.title, spacing, 1);
    g.globalCompositeOperation = 'source-atop';
    const sx = -size + shine * (w + 2 * size);
    const band = g.createLinearGradient(sx - size * 0.8, 0, sx + size * 0.8, 0);
    band.addColorStop(0, 'rgba(255, 255, 255, 0)');
    band.addColorStop(0.5, 'rgba(255, 252, 245, 0.55)');
    band.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = band;
    g.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 20 * pixelRatio;
    ctx.shadowOffsetY = 8 * pixelRatio;
    ctx.drawImage(off, x - w / 2, y - h / 2, w, h);
    ctx.restore();
  }
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  font: string,
  colour: string,
  spacing: number,
  alpha: number,
  shadow = false,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${spacing}px`;
  if (shadow) {
    const scale = ctx.getTransform().a;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 20 * scale;
    ctx.shadowOffsetY = 8 * scale;
  }
  ctx.fillText(value, x, y);
  ctx.restore();
}

async function waitForFonts(): Promise<void> {
  if (!document.fonts) return;
  const loads = Promise.all([
    document.fonts.load(`500 20px ${FONT_SERIF}`),
    document.fonts.load(`italic 400 20px ${FONT_SERIF}`),
    document.fonts.load(`500 12px ${FONT_SANS}`),
  ]);
  await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS))]).catch(
    () => undefined,
  );
}

export const boot = new BootScreen(document.getElementById('boot'));

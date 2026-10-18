/**
 * The desk behind the menus: the same lamp-lit walnut as the boot screen, so
 * the boot screen lifts away onto a room that is already there.
 *
 * Also the little scenes on the lobby's cards — pens lying under the lamp —
 * drawn once into their own canvases and redrawn only when they change size.
 */

import {
  Desk,
  clamp,
  drawPen,
  makeWoodTexture,
} from '../render/premium';
import { PLAYER_COLOURS, type PlayerColour } from '../render/theme';

/** A full-screen desk that animates only while it is being shown. */
export class DeskBackdrop {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d');
  private readonly desk = new Desk(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  private running = false;
  private lastFrame: number | null = null;

  constructor(parent: HTMLElement) {
    this.canvas.className = 'desk-backdrop';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.prepend(this.canvas);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = null;
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  private frame = (now: number): void => {
    const { ctx, canvas } = this;
    if (!this.running || !ctx) return;
    const dt = this.lastFrame === null ? 0 : Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * pixelRatio) || canvas.height !== Math.round(h * pixelRatio)) {
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.desk.resize(w, h, pixelRatio);
    // The lamp hangs over the top of the page, where the name is.
    this.desk.draw(ctx, 1, now / 1000, dt, w / 2, h * 0.16, 0.12);
    requestAnimationFrame(this.frame);
  };
}

export type CardScene = 'solo' | 'online';

/**
 * A small still life for a lobby card. Solo is your pen with three bots'
 * around it; online is a fan of pens, a table's worth of people.
 */
export class CardArt {
  readonly canvas = document.createElement('canvas');
  private readonly scene: CardScene;
  private colour: PlayerColour;
  private drawnFor = '';

  constructor(scene: CardScene, colour: PlayerColour) {
    this.scene = scene;
    this.colour = colour;
    this.canvas.className = 'mode-art';
    this.canvas.setAttribute('aria-hidden', 'true');
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** Your own pen takes your colour, so the solo card is recognisably yours. */
  setColour(colour: PlayerColour): void {
    if (colour === this.colour) return;
    this.colour = colour;
    this.drawnFor = '';
    this.draw();
  }

  draw(): void {
    const { canvas } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const key = `${w}x${h}@${pixelRatio}`;
    if (key === this.drawnFor) return;
    this.drawnFor = key;

    canvas.width = Math.round(w * pixelRatio);
    canvas.height = Math.round(h * pixelRatio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    ctx.drawImage(makeWoodTexture(w, h * 1.4, pixelRatio), 0, 0, w, h * 1.4);
    const light = ctx.createRadialGradient(w / 2, h * 0.25, 5, w / 2, h * 0.6, Math.max(w, h) * 0.75);
    light.addColorStop(0, 'rgba(255, 190, 120, 0.22)');
    light.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, w, h);

    const u = clamp(Math.min(w / 240, h / 110), 0.6, 2);
    if (this.scene === 'solo') {
      const others = PLAYER_COLOURS.filter((c) => c !== this.colour);
      drawPen(ctx, w * 0.24, h * 0.36, 0.9, 70 * u, others[0]);
      drawPen(ctx, w * 0.78, h * 0.32, 2.6, 70 * u, others[1]);
      drawPen(ctx, w * 0.76, h * 0.8, -2.8, 70 * u, others[2]);
      drawPen(ctx, w * 0.48, h * 0.6, -0.5, 96 * u, this.colour);
    } else {
      const pivotX = w / 2;
      const pivotY = h * 0.98;
      const length = 92 * u;
      for (let i = 0; i < 6; i++) {
        const angle = -Math.PI / 2 + (i - 2.5) * 0.33;
        drawPen(
          ctx,
          pivotX + Math.cos(angle) * length * 0.62,
          pivotY + Math.sin(angle) * length * 0.62,
          angle,
          length,
          PLAYER_COLOURS[i],
        );
      }
    }
  }
}

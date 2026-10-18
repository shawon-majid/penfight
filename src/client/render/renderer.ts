/**
 * Drawing the table.
 *
 * The renderer reads game state and paints it. It never changes anything, so
 * it can be replaced wholesale — with WebGL, with an isometric view, with
 * nothing at all for a headless test — without the game noticing.
 */

import type { Pen } from '../../shared/physics/pen';
import { localToWorld } from '../../shared/physics/pen';
import { tableBounds } from '../../shared/physics/table';
import type { Vec2 } from '../../shared/physics/vec2';
import { vec } from '../../shared/physics/vec2';
import type { Match } from '../../shared/game/match';
import { currentPlayer } from '../../shared/game/match';
import { previewStrike, type Strike } from '../../shared/game/strike';
import type { AimSnapshot } from '../input/aim';
import {
  NO_INSETS,
  THEME,
  colourFor,
  fitViewport,
  toScreen,
  toScreenDirection,
  type Viewport,
  type ViewportInsets,
} from './theme';
import { previewPath } from './trajectory';
import type { IntroTimeline } from './intro';
import {
  Desk,
  FONT_SERIF,
  INK,
  Sparks,
  clamp,
  drawPen as drawLacqueredPen,
  drawTable as drawBrassTable,
  easeOutCubic,
  makeWoodTexture,
} from './premium';

/** The turn clock as the display shows it. */
export interface TurnClock {
  secondsLeft: number;
  /** 1 with the full time left, 0 at the deadline. */
  fraction: number;
  /** The last few seconds: everything turns red. */
  warning: boolean;
}

export interface RenderInput {
  match: Match;
  aim: AimSnapshot;
  /** The local player's id, or null when spectating. */
  youAre: string | null;
  /** Seconds since the page loaded. Drives the pulsing highlights. */
  time: number;
  /** Screen space the heads-up display has already taken. */
  insets?: ViewportInsets;
  /** The opening of the game, while it plays: its timeline and seconds into it. */
  intro?: { timeline: IntroTimeline; t: number } | null;
  /** Online: how much of the current turn is left. Null where there is no clock. */
  turnClock?: TurnClock | null;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private viewport: Viewport = { scale: 1, centreX: 0, centreY: 0, rotated: false };
  /** Canvas size in CSS pixels, kept from the last resize. */
  private cssWidth = 1;
  private cssHeight = 1;
  /**
   * Fingers are blunt and phone screens are small, so the aim guides are drawn
   * heavier on touch devices — otherwise a two-pixel line under a thumb is
   * invisible exactly when you need to read it.
   */
  private readonly guideWeight: number;
  private readonly desk = new Desk(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  private readonly sparks = new Sparks();
  /** Grain for the table top, remade only when the table changes size on screen. */
  private tableWood: HTMLCanvasElement | null = null;
  private tableWoodKey = '';
  private lastTime: number | null = null;
  /** Which intro beats have already thrown their sparks, for the intro they belong to. */
  private introSparks = new Set<string>();
  private introSeen: IntroTimeline | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw on a canvas.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.guideWeight = window.matchMedia?.('(pointer: coarse)').matches ? 1.6 : 1;
  }

  /** Current metres-to-pixels mapping. The aim controller needs this too. */
  currentViewport(): Viewport {
    return this.viewport;
  }

  /**
   * Match the canvas to its CSS box at the device's pixel density, so the pens
   * are crisp on a retina screen.
   *
   * Density is capped at 2. Phones ship 3x screens, and drawing nine times the
   * pixels for a difference nobody can see is the quickest way to drop frames
   * on the device least able to spare them.
   */
  resize(table: { width: number; height: number }, insets: ViewportInsets = NO_INSETS): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
      this.canvas.width = width * ratio;
      this.canvas.height = height * ratio;
    }
    this.desk.resize(width, height, ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.cssWidth = width;
    this.cssHeight = height;
    this.viewport = fitViewport(width, height, table, insets);
  }

  draw(input: RenderInput): void {
    const { match, intro } = input;
    const dt = this.lastTime === null ? 0 : clamp(input.time - this.lastTime, 0, 0.05);
    this.lastTime = input.time;
    this.resize(match.world.table, input.insets);

    if ((intro?.timeline ?? null) !== this.introSeen) {
      this.introSeen = intro?.timeline ?? null;
      this.introSparks.clear();
    }

    const table = this.tableRect(match);
    const { ctx } = this;
    this.desk.draw(
      ctx,
      1,
      input.time,
      dt,
      table.left + table.width / 2,
      table.top - table.height * 0.15,
      0.3,
    );

    ctx.save();
    if (intro) {
      // The camera settling: everything on the table eases in from slightly closer.
      const zoom = intro.timeline.zoom(intro.t);
      const cx = table.left + table.width / 2;
      const cy = table.top + table.height / 2;
      ctx.translate(cx, cy);
      ctx.scale(zoom, zoom);
      ctx.translate(-cx, -cy);
    }
    this.drawTable(table);

    // Pens that have fallen draw underneath the ones still in play.
    const ordered = [...match.world.pens].sort(
      (a, b) => rankForDepth(a) - rankForDepth(b),
    );
    for (const pen of ordered) {
      if (pen.state === 'out') continue;
      const drop = intro ? intro.timeline.pen(match.world.pens.indexOf(pen), intro.t) : null;
      this.drawPen(pen, match, input.time, drop);
    }
    ctx.restore();

    if (!intro || intro.t >= intro.timeline.flickAt) {
      this.drawTurnMarker(input);
      this.drawAim(input);
    }
    if (intro) this.drawIntro(intro.timeline, intro.t, match);
    this.sparks.draw(ctx, dt);
  }

  // -- table --------------------------------------------------------------

  /**
   * The table's box on screen. All four corners are converted, because which
   * one lands top-left depends on whether the view is turned.
   */
  private tableRect(match: Match): { left: number; top: number; width: number; height: number } {
    const bounds = tableBounds(match.world.table);
    const corners = [
      toScreen(this.viewport, vec(bounds.minX, bounds.minY)),
      toScreen(this.viewport, vec(bounds.minX, bounds.maxY)),
      toScreen(this.viewport, vec(bounds.maxX, bounds.minY)),
      toScreen(this.viewport, vec(bounds.maxX, bounds.maxY)),
    ];
    const left = Math.min(...corners.map((corner) => corner.x));
    const right = Math.max(...corners.map((corner) => corner.x));
    const top = Math.min(...corners.map((corner) => corner.y));
    const bottom = Math.max(...corners.map((corner) => corner.y));
    return { left, top, width: right - left, height: bottom - top };
  }

  /**
   * Walnut under the lamp with a brass rim. The rim sits on the edge itself —
   * the thing that kills you — so it always reads clearly.
   */
  private drawTable(rect: { left: number; top: number; width: number; height: number }): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${Math.round(rect.width)}x${Math.round(rect.height)}@${ratio}`;
    if (key !== this.tableWoodKey) {
      this.tableWoodKey = key;
      this.tableWood = makeWoodTexture(rect.width, rect.height, ratio);
    }
    if (!this.tableWood) return;
    drawBrassTable(
      this.ctx,
      this.tableWood,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      rect.width,
      rect.height,
      Math.min(rect.width, rect.height) * 0.04,
    );
  }

  // -- pens -----------------------------------------------------------------

  /**
   * A lacquered pen exactly where the physics has it — same centre, length
   * and thickness — so what you aim at is what gets hit.
   *
   * @param drop during the intro, how high the pen still is and how visible.
   */
  private drawPen(
    pen: Pen,
    match: Match,
    time: number,
    drop: { lift: number; alpha: number } | null,
  ): void {
    const { ctx } = this;
    const owner = match.players.find((player) => player.id === pen.ownerId);
    const colour = colourFor(owner?.colourIndex ?? 0);
    const tail = toScreen(this.viewport, localToWorld(pen, { along: -1, across: 0 }));
    const tip = toScreen(this.viewport, localToWorld(pen, { along: 1, across: 0 }));
    const length = Math.hypot(tip.x - tail.x, tip.y - tail.y);
    const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
    const centre = vec((tail.x + tip.x) / 2, (tail.y + tip.y) / 2);
    const radius = Math.max(pen.radius * this.viewport.scale, length * 0.045);

    ctx.save();
    let alpha = drop ? drop.alpha : 1;
    // A falling pen shrinks and fades as it drops past the edge.
    if (pen.state === 'falling') {
      alpha *= 1 - pen.fallProgress;
      const shrink = 1 - pen.fallProgress * 0.45;
      ctx.translate(centre.x, centre.y);
      ctx.scale(shrink, shrink);
      ctx.translate(-centre.x, -centre.y);
    }
    drawLacqueredPen(ctx, centre.x, centre.y, angle, length, colour, drop?.lift ?? 0, alpha, radius);
    ctx.restore();

    if (pen.state === 'onTable' && owner && !drop) {
      this.drawEdgeWarning(pen, match, time);
    }
  }

  /**
   * A pen teetering near the edge gets a red glow. Losing to an edge you did
   * not notice is annoying; losing to one you did is the game.
   */
  private drawEdgeWarning(pen: Pen, match: Match, time: number): void {
    const bounds = tableBounds(match.world.table);
    const margin = Math.min(
      pen.x - bounds.minX,
      bounds.maxX - pen.x,
      pen.y - bounds.minY,
      bounds.maxY - pen.y,
    );
    const dangerZone = pen.length * 0.5;
    if (margin > dangerZone) return;

    const intensity = 1 - margin / dangerZone;
    const pulse = 0.55 + 0.45 * Math.sin(time * 7);
    const centre = toScreen(this.viewport, vec(pen.x, pen.y));

    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = intensity * pulse * 0.5;
    ctx.strokeStyle = THEME.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, pen.length * 0.62 * this.viewport.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // -- intro --------------------------------------------------------------

  /**
   * Over the table: the dark lifting, a puff of dust under each pen as it
   * lands, then the count in the middle of the screen.
   */
  private drawIntro(timeline: IntroTimeline, t: number, match: Match): void {
    const { ctx } = this;
    const width = this.cssWidth;
    const height = this.cssHeight;

    const fade = timeline.fadeIn(t);
    if (fade > 0) {
      ctx.fillStyle = `rgba(4, 5, 9, ${fade})`;
      ctx.fillRect(0, 0, width, height);
    }

    match.world.pens.forEach((pen, index) => {
      if (pen.state === 'out' || timeline.pen(index, t).lift > 0.02) return;
      this.onceInIntro(`pen-${index}`, () => {
        const centre = toScreen(this.viewport, vec(pen.x, pen.y));
        this.sparks.burst(centre.x, centre.y, 10, '#ffe2b0', 60);
        this.sparks.ring(centre.x, centre.y, 'rgba(255, 226, 176, 0.6)', 24, 8, 0.5);
      });
    });

    const caption = timeline.caption(t);
    if (!caption) return;
    const flick = caption.text === 'Flick!';
    const cx = width / 2;
    const cy = height / 2;
    const size = clamp(Math.min(width, height) * 0.24, 72, 150);

    // The scene dims behind the count, and lifts again as "Flick!" goes.
    ctx.fillStyle = `rgba(3, 4, 8, ${0.42 * (flick ? clamp(1 - caption.progress * 1.4) : 1)})`;
    ctx.fillRect(0, 0, width, height);

    this.onceInIntro(`beat-${caption.text}`, () => {
      this.sparks.ring(cx, cy, flick ? 'rgba(239, 228, 205, 0.9)' : 'rgba(205, 184, 148, 0.75)', flick ? size * 1.6 : size * 0.8, size * 0.25, 0.8);
      this.sparks.burst(cx, cy, flick ? 60 : 22, '#e9dcc0', flick ? 300 : 170);
    });

    // Each beat lands big and settles; numbers fade before the next one.
    const pop = 1 + 0.55 * (1 - easeOutCubic(clamp(caption.progress / 0.35)));
    const alpha = flick
      ? clamp(caption.progress / 0.1) * clamp((1 - caption.progress) / 0.35)
      : clamp(caption.progress / 0.12) * clamp((1 - caption.progress) / 0.25);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
    ctx.globalAlpha = alpha;
    ctx.font = flick ? `italic 400 ${size * 0.78}px ${FONT_SERIF}` : `500 ${size}px ${FONT_SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 24 * ratio;
    ctx.shadowOffsetY = 8 * ratio;
    ctx.fillStyle = flick ? '#e8dcc4' : INK.title;
    ctx.fillText(caption.text, 0, size * 0.04);
    ctx.restore();

    if (!flick) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = `500 ${Math.max(10, size * 0.085)}px "Inter Variable", system-ui, sans-serif`;
      ctx.letterSpacing = `${Math.max(4, size * 0.04)}px`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#d8c79c';
      ctx.fillText('GET READY', cx, cy - size * 0.72);
      ctx.restore();
    }
  }

  private onceInIntro(key: string, effect: () => void): void {
    if (this.introSparks.has(key)) return;
    this.introSparks.add(key);
    effect();
  }

  // -- turn and aim ---------------------------------------------------------

  /** Ring around whoever is on, so nobody has to hunt for their own pen. */
  private drawTurnMarker(input: RenderInput): void {
    const { match, time } = input;
    if (match.phase !== 'aiming') return;

    const player = currentPlayer(match);
    if (!player) return;
    const pen = match.world.pens.find((candidate) => candidate.id === player.penId);
    if (!pen || pen.state !== 'onTable') return;

    const colour = colourFor(player.colourIndex);
    const centre = toScreen(this.viewport, vec(pen.x, pen.y));
    const { ctx } = this;

    // Online the ring is the clock: it drains as the turn runs out, and goes
    // red for the last few seconds with the count above the pen.
    const clock = input.turnClock;
    if (clock) {
      const radius = pen.length * 0.72 * this.viewport.scale;
      const ink = clock.warning ? THEME.danger : colour.accent;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = ink;
      ctx.lineCap = 'round';
      ctx.shadowColor = ink;
      ctx.shadowBlur = (clock.warning ? 12 : 6) * ratio;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clock.fraction);
      ctx.stroke();
      ctx.restore();

      if (clock.warning && clock.secondsLeft > 0) {
        ctx.save();
        ctx.font = `500 ${Math.max(14, radius * 0.4)}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = THEME.danger;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        ctx.shadowBlur = 8 * ratio;
        ctx.fillText(String(Math.ceil(clock.secondsLeft)), centre.x, centre.y - radius - 14);
        ctx.restore();
      }
      return;
    }

    const pulse = 0.75 + 0.25 * Math.sin(time * 3);
    const radius = pen.length * 0.75 * this.viewport.scale * pulse;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = colour.accent;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 7]);
    ctx.lineDashOffset = -time * 30;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawAim(input: RenderInput): void {
    const { aim, match } = input;
    if (!aim.dragging || !aim.grab || !aim.pointer) return;

    const { ctx } = this;
    const grab = toScreen(this.viewport, aim.grab);
    const pointer = toScreen(this.viewport, aim.pointer);

    // The elastic being pulled back.
    ctx.save();
    ctx.strokeStyle = THEME.aimGuideFaint;
    ctx.lineWidth = 2 * this.guideWeight;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(grab.x, grab.y);
    ctx.lineTo(pointer.x, pointer.y);
    ctx.stroke();
    ctx.restore();

    // The exact spot on the barrel the flick will land on. On a phone this
    // ends up under a fingertip, so it is drawn as a ring rather than a dot —
    // the outline still reads around the edges of a finger.
    ctx.save();
    ctx.strokeStyle = THEME.aimGuide;
    ctx.fillStyle = THEME.aimGuide;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(grab.x, grab.y, 5 * this.guideWeight, 0, Math.PI * 2);
    if (this.guideWeight > 1) ctx.stroke();
    else ctx.fill();
    ctx.restore();

    if (!aim.strike) return;

    const pen = match.world.pens.find((candidate) => candidate.id === aim.strike!.penId);
    if (!pen) return;

    const preview = previewStrike(pen, aim.strike, match.world.tuning);
    this.drawPredictedPath(match, aim.strike);
    this.drawPowerAndSpin(grab, aim.strike, preview.spin, preview.spinShare);
  }

  private drawPredictedPath(match: Match, strike: Strike): void {
    const path = previewPath(match.world, strike);
    if (path.length < 2) return;

    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = THEME.aimGuide;
    ctx.lineWidth = 2 * this.guideWeight;
    ctx.setLineDash([3, 8]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    path.forEach((point, index) => {
      const screen = toScreen(this.viewport, point);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Power reads as the length of the arrow; spin reads as a curl around the
   * grab point. Grab a tip and the curl winds up while the arrow stays the
   * same — which is the whole lesson of the game in one picture.
   */
  private drawPowerAndSpin(
    grab: Vec2,
    strike: Strike,
    spin: number,
    spinShare: number,
  ): void {
    const { ctx } = this;
    const arrowLength = (30 + strike.power * 90) * this.guideWeight;
    const heading = toScreenDirection(this.viewport, strike.direction);
    const tip = vec(grab.x + heading.x * arrowLength, grab.y + heading.y * arrowLength);

    ctx.save();
    ctx.strokeStyle = strike.power > 0.85 ? THEME.danger : THEME.aimGuide;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3 * this.guideWeight;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(grab.x, grab.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    const arrowAngle = Math.atan2(heading.y, heading.x);
    const wing = 9 * this.guideWeight;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
      tip.x - Math.cos(arrowAngle - 0.4) * wing,
      tip.y - Math.sin(arrowAngle - 0.4) * wing,
    );
    ctx.lineTo(
      tip.x - Math.cos(arrowAngle + 0.4) * wing,
      tip.y - Math.sin(arrowAngle + 0.4) * wing,
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (spinShare < 0.05) return;

    // Curl showing how hard, and which way, the pen will turn.
    const radius = (16 + spinShare * 16) * this.guideWeight;
    const sweep = Math.PI * 0.4 + spinShare * Math.PI * 1.2;
    // World spin is counter-clockwise positive; on screen y is flipped.
    const clockwiseOnScreen = spin > 0;

    ctx.save();
    ctx.globalAlpha = 0.55 + spinShare * 0.45;
    ctx.strokeStyle = THEME.aimGuide;
    ctx.lineWidth = 2.5 * this.guideWeight;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(grab.x, grab.y, radius, -sweep / 2, sweep / 2, clockwiseOnScreen);
    ctx.stroke();
    ctx.restore();
  }
}

/** Falling pens draw first so live pens stay on top of them. */
function rankForDepth(pen: Pen): number {
  return pen.state === 'falling' ? 0 : 1;
}

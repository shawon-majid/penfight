/**
 * Drawing the table.
 *
 * The renderer reads game state and paints it. It never changes anything, so
 * it can be replaced wholesale — with WebGL, with an isometric view, with
 * nothing at all for a headless test — without the game noticing.
 */

import type { Pen } from '../../shared/physics/pen';
import { localToWorld, penEndpoints } from '../../shared/physics/pen';
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

export interface RenderInput {
  match: Match;
  aim: AimSnapshot;
  /** The local player's id, or null when spectating. */
  youAre: string | null;
  /** Seconds since the page loaded. Drives the pulsing highlights. */
  time: number;
  /** Screen space the heads-up display has already taken. */
  insets?: ViewportInsets;
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
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.cssWidth = width;
    this.cssHeight = height;
    this.viewport = fitViewport(width, height, table, insets);
  }

  draw(input: RenderInput): void {
    const { match } = input;
    this.resize(match.world.table, input.insets);

    this.drawRoom(this.cssWidth, this.cssHeight);
    this.drawTable(match);

    // Pens that have fallen draw underneath the ones still in play.
    const ordered = [...match.world.pens].sort(
      (a, b) => rankForDepth(a) - rankForDepth(b),
    );
    for (const pen of ordered) {
      if (pen.state === 'out') continue;
      this.drawPenShadow(pen);
    }
    for (const pen of ordered) {
      if (pen.state === 'out') continue;
      this.drawPen(pen, match, input.time);
    }

    this.drawTurnMarker(input);
    this.drawAim(input);
  }

  // -- background -----------------------------------------------------------

  private drawRoom(width: number, height: number): void {
    const { ctx } = this;
    const glow = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.1,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.75,
    );
    glow.addColorStop(0, THEME.room);
    glow.addColorStop(1, THEME.roomEdge);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }

  private drawTable(match: Match): void {
    const { ctx } = this;
    const bounds = tableBounds(match.world.table);

    // All four corners, because which one lands top-left depends on whether
    // the view is turned.
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

    const topLeft = vec(left, top);
    const width = right - left;
    const height = bottom - top;
    const radius = Math.min(width, height) * 0.03;

    // The table sits above the floor, so it casts a shadow.
    ctx.save();
    ctx.shadowColor = THEME.tableShadow;
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 18;

    const grain = ctx.createLinearGradient(left, top, right, bottom);
    grain.addColorStop(0, THEME.tableTopLight);
    grain.addColorStop(0.45, THEME.tableTop);
    grain.addColorStop(1, THEME.tableTopLight);
    ctx.fillStyle = grain;
    ctx.beginPath();
    ctx.roundRect(topLeft.x, topLeft.y, width, height, radius);
    ctx.fill();
    ctx.restore();

    // A rim, so the edge — the thing that kills you — reads clearly.
    ctx.strokeStyle = THEME.tableRim;
    ctx.lineWidth = Math.max(2, this.viewport.scale * 0.012);
    ctx.beginPath();
    ctx.roundRect(topLeft.x, topLeft.y, width, height, radius);
    ctx.stroke();
  }

  // -- pens -----------------------------------------------------------------

  private drawPenShadow(pen: Pen): void {
    const { ctx } = this;
    const [tail, tip] = penEndpoints(pen).map((point) => toScreen(this.viewport, point));
    const lift = pen.state === 'falling' ? 1 + pen.fallProgress * 3 : 1;

    ctx.save();
    ctx.globalAlpha = 0.32 * (1 - pen.fallProgress * 0.7);
    ctx.strokeStyle = THEME.penShadow;
    ctx.lineCap = 'round';
    ctx.lineWidth = pen.radius * 2 * this.viewport.scale;
    ctx.translate(4 * lift, 7 * lift);
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawPen(pen: Pen, match: Match, time: number): void {
    const { ctx } = this;
    const owner = match.players.find((player) => player.id === pen.ownerId);
    const colour = colourFor(owner?.colourIndex ?? 0);
    const barrelWidth = pen.radius * 2 * this.viewport.scale;

    ctx.save();

    // A falling pen shrinks and fades as it drops past the edge.
    if (pen.state === 'falling') {
      const centre = toScreen(this.viewport, vec(pen.x, pen.y));
      ctx.globalAlpha = 1 - pen.fallProgress;
      ctx.translate(centre.x, centre.y);
      ctx.scale(1 - pen.fallProgress * 0.45, 1 - pen.fallProgress * 0.45);
      ctx.translate(-centre.x, -centre.y);
    }

    const segment = (fromAlong: number, toAlong: number, width: number, colourValue: string) => {
      const from = toScreen(this.viewport, localToWorld(pen, { along: fromAlong, across: 0 }));
      const to = toScreen(this.viewport, localToWorld(pen, { along: toAlong, across: 0 }));
      ctx.strokeStyle = colourValue;
      ctx.lineCap = 'round';
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    };

    // Barrel, then the cap at the tail, then a tapered nib at the tip.
    segment(-0.92, 0.92, barrelWidth, colour.body);
    segment(-0.92, -0.45, barrelWidth, colour.cap);
    segment(0.72, 0.9, barrelWidth * 0.72, colour.cap);
    segment(0.9, 0.99, barrelWidth * 0.35, colour.cap);

    // A highlight down the length so the barrel looks round rather than flat.
    ctx.save();
    ctx.globalAlpha = 0.35;
    const highlightFrom = toScreen(this.viewport, localToWorld(pen, { along: -0.8, across: -0.45 }));
    const highlightTo = toScreen(this.viewport, localToWorld(pen, { along: 0.7, across: -0.45 }));
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = barrelWidth * 0.22;
    ctx.beginPath();
    ctx.moveTo(highlightFrom.x, highlightFrom.y);
    ctx.lineTo(highlightTo.x, highlightTo.y);
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    if (pen.state === 'onTable' && owner) {
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
    const pulse = 0.75 + 0.25 * Math.sin(time * 3);
    const radius = pen.length * 0.75 * this.viewport.scale * pulse;

    const { ctx } = this;
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

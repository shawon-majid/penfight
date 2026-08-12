/**
 * The flick gesture.
 *
 * Press on your own pen, drag away from where you want it to go, release.
 * Where you pressed is kept in pen-local coordinates, so if the pen is at an
 * angle the grab point stays on the same part of the barrel.
 *
 * This module only turns pointer events into a `Strike`. It does not decide
 * whether the strike is legal — the match does that, and the server does it
 * again.
 */

import { closestPointOnSegment } from '../../shared/physics/geometry';
import type { Pen } from '../../shared/physics/pen';
import { penEndpoints, worldToLocal } from '../../shared/physics/pen';
import type { Tuning } from '../../shared/physics/tuning';
import { distance, type Vec2 } from '../../shared/physics/vec2';
import type { Strike } from '../../shared/game/strike';
import { strikeFromDrag } from '../../shared/game/strike';
import { toWorld, type Viewport } from '../render/theme';

/**
 * How far off the barrel a grab can land and still count, in screen pixels.
 *
 * Measured in pixels rather than metres because the thing being missed by is a
 * pointing device, not a pen: a mouse is precise at any zoom level, a fingertip
 * covers roughly a centimetre of glass whatever the table is scaled to.
 */
const GRAB_TOLERANCE_PX = 14;
const GRAB_TOLERANCE_TOUCH_PX = 26;

/** A pen barrel is thin; never let the grab area collapse below this. m */
const MIN_GRAB_TOLERANCE_METRES = 0.014;

/** Shorter drags than this are a misclick or a wobble, not a feeble tap. */
const MIN_DRAG_PX = 10;
const MIN_DRAG_METRES = 0.012;

const COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export interface AimSnapshot {
  /** True while the player is mid-drag. */
  dragging: boolean;
  /** Where they grabbed the pen, in world space. */
  grab: Vec2 | null;
  /** Where the pointer is now, in world space. */
  pointer: Vec2 | null;
  /** The shot as it currently stands, or null if it is not a valid one yet. */
  strike: Strike | null;
}

export interface AimOptions {
  canvas: HTMLCanvasElement;
  tuning: Tuning;
  /** Current metres-to-pixels mapping. Read fresh, because the canvas resizes. */
  viewport: () => Viewport;
  /** The pen this player is allowed to strike right now, or null if it is not their turn. */
  strikeablePen: () => Pen | null;
  /** Called on release with a legal-looking strike. */
  onStrike: (strike: Strike) => void;
  /** Called whenever the aim overlay needs redrawing. */
  onChange?: (aim: AimSnapshot) => void;
}

export class AimController {
  private readonly options: AimOptions;
  private pen: Pen | null = null;
  private grab: Vec2 | null = null;
  private pointer: Vec2 | null = null;
  private pointerId: number | null = null;

  constructor(options: AimOptions) {
    this.options = options;
    const { canvas } = options;
    canvas.addEventListener('pointerdown', this.handleDown);
    canvas.addEventListener('pointermove', this.handleMove);
    canvas.addEventListener('pointerup', this.handleUp);
    canvas.addEventListener('pointercancel', this.handleCancel);
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKey);
  }

  destroy(): void {
    const { canvas } = this.options;
    canvas.removeEventListener('pointerdown', this.handleDown);
    canvas.removeEventListener('pointermove', this.handleMove);
    canvas.removeEventListener('pointerup', this.handleUp);
    canvas.removeEventListener('pointercancel', this.handleCancel);
    canvas.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKey);
  }

  snapshot(): AimSnapshot {
    return {
      dragging: this.grab !== null,
      grab: this.grab,
      pointer: this.pointer,
      strike: this.currentStrike(),
    };
  }

  /** Abandon the current drag without firing. */
  cancel(): void {
    if (this.grab === null) return;
    this.reset();
    this.options.onChange?.(this.snapshot());
  }

  private currentStrike(): Strike | null {
    if (!this.pen || !this.grab || !this.pointer) return null;
    const scale = this.options.viewport().scale;
    const minimumDrag = Math.max(MIN_DRAG_METRES, MIN_DRAG_PX / scale);
    if (distance(this.grab, this.pointer) < minimumDrag) return null;
    return strikeFromDrag(this.pen, this.grab, this.pointer, this.options.tuning);
  }

  /** How generous the grab area is right now, in table metres. */
  private grabTolerance(): number {
    const pixels = COARSE_POINTER ? GRAB_TOLERANCE_TOUCH_PX : GRAB_TOLERANCE_PX;
    return Math.max(MIN_GRAB_TOLERANCE_METRES, pixels / this.options.viewport().scale);
  }

  private pointerToWorld(event: PointerEvent): Vec2 {
    const rect = this.options.canvas.getBoundingClientRect();
    return toWorld(
      this.options.viewport(),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }

  private handleDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;

    const pen = this.options.strikeablePen();
    if (!pen) return;

    const worldPoint = this.pointerToWorld(event);
    if (!isOnPen(pen, worldPoint, this.grabTolerance())) return;

    // Snap the grab onto the barrel so the contact point is always on the pen,
    // even when the press landed a few pixels off it.
    const [tail, tip] = penEndpoints(pen);
    const onBarrel = closestPointOnSegment(worldPoint, tail, tip);

    this.pen = pen;
    this.grab = onBarrel;
    this.pointer = worldPoint;
    this.pointerId = event.pointerId;
    this.options.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.options.onChange?.(this.snapshot());
  };

  private handleMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId || !this.grab) return;
    this.pointer = this.pointerToWorld(event);
    this.options.onChange?.(this.snapshot());
  };

  private handleUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;

    const strike = this.currentStrike();
    this.releaseCapture(event.pointerId);
    this.reset();
    this.options.onChange?.(this.snapshot());

    if (strike) this.options.onStrike(strike);
  };

  private handleCancel = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.releaseCapture(event.pointerId);
    this.cancel();
  };

  // Right-clicking mid-drag should back out, not open a menu.
  private handleContextMenu = (event: MouseEvent): void => {
    if (this.grab) event.preventDefault();
  };

  private handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.cancel();
  };

  private releaseCapture(pointerId: number): void {
    if (this.options.canvas.hasPointerCapture(pointerId)) {
      this.options.canvas.releasePointerCapture(pointerId);
    }
  }

  private reset(): void {
    this.pen = null;
    this.grab = null;
    this.pointer = null;
    this.pointerId = null;
  }
}

/**
 * Is this world point close enough to the pen's barrel to count as a grab?
 *
 * @param tolerance Extra reach beyond the barrel, in metres. Callers scale this
 *   to the pointing device — see `grabTolerance`.
 */
export function isOnPen(pen: Pen, point: Vec2, tolerance = MIN_GRAB_TOLERANCE_METRES): boolean {
  const [tail, tip] = penEndpoints(pen);
  const nearest = closestPointOnSegment(point, tail, tip);
  return distance(nearest, point) <= pen.radius + tolerance;
}

/** Where along the barrel a world point sits. Used by the overlay for labels. */
export function grabDescription(pen: Pen, point: Vec2): 'tip' | 'middle' | 'tail' {
  const { along } = worldToLocal(pen, point);
  if (along > 0.45) return 'tip';
  if (along < -0.45) return 'tail';
  return 'middle';
}

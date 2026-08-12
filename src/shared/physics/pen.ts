/**
 * A pen: a rigid capsule sliding flat on a table.
 *
 * The barrel is modelled as a line segment of length `length` with a rounded
 * cap of `radius` at each end. That shape is what makes the game interesting —
 * it has a real orientation, so *where* you hit it decides how much it spins.
 *
 * Bodies are mutable. The solver rewrites them in place many times per frame,
 * and allocating fresh objects per sub-step would dominate the frame budget.
 * Everything that reads a body treats it as read-only.
 */

import type { Tuning } from './tuning';
import type { Vec2 } from './vec2';
import { clamp, cross, fromAngle, vec } from './vec2';

export type PenState =
  /** Resting or moving on the table, still in play. */
  | 'onTable'
  /** Past the edge, mid-fall. Animated out, no longer collides. */
  | 'falling'
  /** Gone. Its owner is eliminated. */
  | 'out';

export interface Pen {
  readonly id: string;
  /** Which player owns this pen. Only they may strike it. */
  readonly ownerId: string;

  // --- Pose: centre of mass and heading ---
  x: number;
  y: number;
  angle: number;

  // --- Motion ---
  vx: number;
  vy: number;
  /** Angular velocity, radians per second, counter-clockwise positive. */
  omega: number;

  // --- Shape and mass (fixed once built) ---
  readonly length: number;
  readonly radius: number;
  readonly mass: number;
  readonly inertia: number;
  readonly invMass: number;
  readonly invInertia: number;

  // --- Lifecycle ---
  state: PenState;
  /** 0 to 1 while `state === 'falling'`, for the drop animation. */
  fallProgress: number;
}

export interface PenSpawn {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  angle: number;
}

/**
 * Moment of inertia of a flat rectangle about its centre. A capsule is not
 * quite a rectangle, but the barrel dominates and the difference is far below
 * the level anyone can feel.
 */
function momentOfInertia(mass: number, length: number, radius: number): number {
  const width = radius * 2;
  return (mass * (length * length + width * width)) / 12;
}

export function createPen(spawn: PenSpawn, tuning: Tuning): Pen {
  const { penLength: length, penRadius: radius, penMass: mass } = tuning;
  const inertia = momentOfInertia(mass, length, radius);
  return {
    id: spawn.id,
    ownerId: spawn.ownerId,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    vx: 0,
    vy: 0,
    omega: 0,
    length,
    radius,
    mass,
    inertia,
    invMass: 1 / mass,
    invInertia: 1 / inertia,
    state: 'onTable',
    fallProgress: 0,
  };
}

export function clonePen(pen: Pen): Pen {
  return { ...pen };
}

/** Unit vector pointing from the tail of the pen towards its tip. */
export function penAxis(pen: Pen): Vec2 {
  return fromAngle(pen.angle);
}

export function penCentre(pen: Pen): Vec2 {
  return vec(pen.x, pen.y);
}

/** The two ends of the capsule's core segment: `[tail, tip]`. */
export function penEndpoints(pen: Pen): [Vec2, Vec2] {
  const axis = penAxis(pen);
  const half = pen.length / 2 - pen.radius;
  return [
    vec(pen.x - axis.x * half, pen.y - axis.y * half),
    vec(pen.x + axis.x * half, pen.y + axis.y * half),
  ];
}

/**
 * Local pen coordinates.
 *
 * `along` runs -1 (tail) to +1 (tip); `across` runs -1 to +1 over the barrel's
 * thickness. This is the coordinate system the strike UI speaks in, so a
 * player picking a spot on the pen maps onto it directly.
 */
export interface PenLocalPoint {
  along: number;
  across: number;
}

export function localToWorld(pen: Pen, local: PenLocalPoint): Vec2 {
  const axis = penAxis(pen);
  const alongMetres = clamp(local.along, -1, 1) * (pen.length / 2);
  const acrossMetres = clamp(local.across, -1, 1) * pen.radius;
  return vec(
    pen.x + axis.x * alongMetres - axis.y * acrossMetres,
    pen.y + axis.y * alongMetres + axis.x * acrossMetres,
  );
}

export function worldToLocal(pen: Pen, point: Vec2): PenLocalPoint {
  const axis = penAxis(pen);
  const dx = point.x - pen.x;
  const dy = point.y - pen.y;
  const alongMetres = dx * axis.x + dy * axis.y;
  const acrossMetres = -dx * axis.y + dy * axis.x;
  return {
    along: clamp(alongMetres / (pen.length / 2), -1, 1),
    across: clamp(acrossMetres / pen.radius, -1, 1),
  };
}

/**
 * Velocity of the material point of the pen currently at `point`.
 * This is the linear velocity plus the contribution of the spin — the term
 * that makes a spinning pen shove a neighbour sideways.
 */
export function velocityAt(pen: Pen, point: Vec2): Vec2 {
  const rx = point.x - pen.x;
  const ry = point.y - pen.y;
  return vec(pen.vx - pen.omega * ry, pen.vy + pen.omega * rx);
}

/**
 * Apply an impulse at a world point.
 *
 * `spinScale` lets a caller damp only the rotational half of the response.
 * The solver always passes 1 (real physics); the strike code passes
 * `tuning.strikeSpinFactor` so a flick to the tip is lively but readable.
 */
export function applyImpulseAt(
  pen: Pen,
  impulse: Vec2,
  point: Vec2,
  spinScale = 1,
): void {
  pen.vx += impulse.x * pen.invMass;
  pen.vy += impulse.y * pen.invMass;
  const lever = vec(point.x - pen.x, point.y - pen.y);
  pen.omega += cross(lever, impulse) * pen.invInertia * spinScale;
}

/** Keep motion inside the bounds the solver and the eye can both cope with. */
export function clampMotion(pen: Pen, tuning: Tuning): void {
  const speed = Math.hypot(pen.vx, pen.vy);
  if (speed > tuning.maxLinearVelocity) {
    const k = tuning.maxLinearVelocity / speed;
    pen.vx *= k;
    pen.vy *= k;
  }
  pen.omega = clamp(pen.omega, -tuning.maxAngularVelocity, tuning.maxAngularVelocity);
}

export function isAtRest(pen: Pen, tuning: Tuning): boolean {
  if (pen.state !== 'onTable') return pen.state === 'out';
  return (
    Math.hypot(pen.vx, pen.vy) < tuning.restLinearSpeed &&
    Math.abs(pen.omega) < tuning.restAngularSpeed
  );
}

export function stopPen(pen: Pen): void {
  pen.vx = 0;
  pen.vy = 0;
  pen.omega = 0;
}

/** Fastest a point on this pen is currently moving — used for sub-stepping. */
export function maxPointSpeed(pen: Pen): number {
  return Math.hypot(pen.vx, pen.vy) + Math.abs(pen.omega) * (pen.length / 2);
}

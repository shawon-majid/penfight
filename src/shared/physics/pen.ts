/**
 * A pen: a rigid barrel sliding flat on a table.
 *
 * This is the plain-data half of a pen — the part that is saved, sent over the
 * network and read by the renderer. The physics engine keeps its own body for
 * each pen (see `engine.ts`) and copies its results back here every step, so
 * nothing outside `physics/` ever needs to know the engine exists.
 *
 * `x`, `y` is the middle of the barrel, which is what you draw around. The
 * centre of mass sits `comOffset` along the barrel from there, and the
 * velocities are the velocities *of the centre of mass*, because that is what
 * momentum is measured at.
 *
 * Bodies are mutable. The solver rewrites them in place many times per frame,
 * and allocating fresh objects per step would dominate the frame budget.
 * Everything that reads a body treats it as read-only.
 */

import { resolvePenSpec } from './pens/catalogue';
import { inertiaOf } from './pens/spec';
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
  /** Which entry in the pen catalogue this is. */
  readonly specId: string;

  // --- Pose: middle of the barrel, and heading ---
  x: number;
  y: number;
  angle: number;

  // --- Motion of the centre of mass ---
  vx: number;
  vy: number;
  /** Angular velocity, radians per second, counter-clockwise positive. */
  omega: number;

  // --- Shape and mass (fixed once built, copied from the spec) ---
  readonly length: number;
  readonly radius: number;
  readonly mass: number;
  /** Distance from the middle of the barrel to the centre of mass, towards the tip. m */
  readonly comOffset: number;
  /** About the centre of mass. */
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
  /** Catalogue entry. Unknown or missing means the standard pen. */
  specId?: string;
  x: number;
  y: number;
  angle: number;
}

export function createPen(spawn: PenSpawn): Pen {
  const spec = resolvePenSpec(spawn.specId);
  const inertia = inertiaOf(spec);
  return {
    id: spawn.id,
    ownerId: spawn.ownerId,
    specId: spec.id,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    vx: 0,
    vy: 0,
    omega: 0,
    length: spec.length,
    radius: spec.radius,
    mass: spec.mass,
    comOffset: spec.comOffset,
    inertia,
    invMass: 1 / spec.mass,
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

/** The middle of the barrel. */
export function penCentre(pen: Pen): Vec2 {
  return vec(pen.x, pen.y);
}

/** Where the pen balances. This, not the middle, decides when it falls off. */
export function penCentreOfMass(pen: Pen): Vec2 {
  const axis = penAxis(pen);
  return vec(pen.x + axis.x * pen.comOffset, pen.y + axis.y * pen.comOffset);
}

/**
 * The two ends of the barrel's core segment: `[tail, tip]`.
 *
 * Together with `radius` this is a capsule around the pen, used for hit tests
 * and placement. The engine collides the real shape, pointed tip and all.
 */
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
  const com = penCentreOfMass(pen);
  const rx = point.x - com.x;
  const ry = point.y - com.y;
  return vec(pen.vx - pen.omega * ry, pen.vy + pen.omega * rx);
}

/**
 * Apply an impulse at a world point. The lever arm from the centre of mass
 * decides how much of it becomes spin.
 */
export function applyImpulseAt(pen: Pen, impulse: Vec2, point: Vec2): void {
  const com = penCentreOfMass(pen);
  pen.vx += impulse.x * pen.invMass;
  pen.vy += impulse.y * pen.invMass;
  pen.omega += cross(vec(point.x - com.x, point.y - com.y), impulse) * pen.invInertia;
}

/**
 * Mass a push along `direction` at `point` meets.
 *
 * At the centre of mass this is the pen's mass. Further out more of the push
 * goes into turning the pen, so it feels lighter: at the very tip of a uniform
 * rod, a quarter of its mass.
 */
export function effectiveMassAt(pen: Pen, point: Vec2, direction: Vec2): number {
  const com = penCentreOfMass(pen);
  const lever = cross(vec(point.x - com.x, point.y - com.y), direction);
  return 1 / (pen.invMass + lever * lever * pen.invInertia);
}

export function isAtRest(pen: Pen, tuning: { restLinearSpeed: number; restAngularSpeed: number }): boolean {
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

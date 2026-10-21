/**
 * Friction between a pen and the table.
 *
 * Three effects, each of which you can see in play:
 *
 *   1. **Grip is shared between sliding and spinning.** A pen does not touch
 *      the table at one point — it lies along it — so we sample the barrel at
 *      several places and apply Coulomb friction to each one separately. A pen
 *      that is spinning spends part of its grip stopping the spin, leaving less
 *      to stop the travel, so a spinning pen slides further.
 *
 *   2. **A round barrel rolls.** Pushed sideways it rolls rather than slides,
 *      so friction and drag across the barrel are only `rollFactor` of what
 *      they are along it. Side-on flicks are the long ones; end-on flicks skid
 *      to a halt.
 *
 *   3. **A lopsided pen curves.** The table carries more of the weight near
 *      the centre of mass, so the heavy end grips harder. A pen sliding and
 *      spinning at once gets pulled round by its heavy end. A perfectly
 *      balanced pen does not curve, which is also true of real ones.
 *
 * On top of that, a speed-proportional drag (`damping`) bleeds off fast shots
 * quickly while leaving slow ones to Coulomb friction, which stops them
 * crisply. Range then grows close to linearly with launch speed instead of
 * with its square, so a half-power shot is a real shot and a full-power one is
 * not wildly longer.
 *
 * This runs on the plain pen data, before each engine step.
 */

import type { Pen } from './pen';
import { applyImpulseAt, penAxis, penCentreOfMass, stopPen } from './pen';
import { resolvePenSpec } from './pens/catalogue';
import type { PenSpec } from './pens/spec';
import { loadShares, samplePositions } from './pens/spec';
import type { Tuning } from './tuning';
import { cross, vec } from './vec2';

/** Sample layout per spec. Specs are immutable, so this never goes stale. */
const layoutCache = new Map<string, { positions: number[]; shares: number[] }>();

function layoutFor(spec: PenSpec, count: number) {
  const key = `${spec.id}:${count}`;
  let layout = layoutCache.get(key);
  if (!layout) {
    layout = { positions: samplePositions(spec, count), shares: loadShares(spec, count) };
    layoutCache.set(key, layout);
  }
  return layout;
}

/**
 * Apply one step's worth of table friction and drag.
 *
 * Friction goes in as an impulse per sample, and each impulse is capped at
 * whatever would bring that sample to a standstill. That cap is what stops a
 * pen at the end of its travel from jittering backwards and forwards across
 * zero.
 */
export function applyTableFriction(pen: Pen, dt: number, tuning: Tuning): void {
  if (pen.state !== 'onTable') return;

  const spec = resolvePenSpec(pen.specId);
  const count = tuning.frictionSamples;
  const { positions, shares } = layoutFor(spec, count);

  const axis = penAxis(pen);
  const across = vec(-axis.y, axis.x);
  const weightImpulse = pen.mass * tuning.gravity * dt;
  const gripAlong = spec.slideFriction;
  const gripAcross = spec.slideFriction * spec.rollFactor;
  const com = penCentreOfMass(pen);

  for (let i = 0; i < count; i++) {
    const point = vec(pen.x + axis.x * positions[i], pen.y + axis.y * positions[i]);
    const rx = point.x - com.x;
    const ry = point.y - com.y;

    // How this bit of barrel is moving over the table.
    const slideX = pen.vx - pen.omega * ry;
    const slideY = pen.vy + pen.omega * rx;
    const speed = Math.hypot(slideX, slideY);
    if (speed < 1e-9) continue;

    // Anisotropic Coulomb friction: each component of the slip meets its own
    // coefficient, so a sideways slip is resisted less than an end-on one.
    const slipAlong = (slideX * axis.x + slideY * axis.y) / speed;
    const slipAcross = (slideX * across.x + slideY * across.y) / speed;
    const load = weightImpulse * shares[i];
    const jx = -(gripAlong * slipAlong * axis.x + gripAcross * slipAcross * across.x) * load;
    const jy = -(gripAlong * slipAlong * axis.y + gripAcross * slipAcross * across.y) * load;
    const wanted = Math.hypot(jx, jy);
    if (wanted < 1e-15) continue;

    const dx = jx / wanted;
    const dy = jy / wanted;
    // Friction can only ever slow this point down, never push it back.
    const closing = -(slideX * dx + slideY * dy);
    if (closing <= 0) continue;
    const lever = cross(vec(rx, ry), vec(dx, dy));
    const stopping = closing / (pen.invMass + lever * lever * pen.invInertia);
    const magnitude = Math.min(wanted, stopping);

    applyImpulseAt(pen, vec(dx * magnitude, dy * magnitude), point);
  }

  // Drag, split the same way: a rolling barrel loses less than a skidding
  // one. Implicit form, so it can never overshoot however big the step.
  const alongSpeed = pen.vx * axis.x + pen.vy * axis.y;
  const acrossSpeed = pen.vx * across.x + pen.vy * across.y;
  const keptAlong = alongSpeed / (1 + spec.damping * dt);
  const keptAcross = acrossSpeed / (1 + spec.damping * spec.rollFactor * dt);
  pen.vx = keptAlong * axis.x + keptAcross * across.x;
  pen.vy = keptAlong * axis.y + keptAcross * across.y;
  pen.omega /= 1 + spec.spinDamping * dt;
}

/**
 * Static friction, in effect: once a pen is barely crawling, let it stop.
 *
 * Without this a pen can drift for a very long time at a speed nobody can see,
 * holding up the end of a turn.
 */
export function arrestIfCreeping(pen: Pen, tuning: Tuning): void {
  if (pen.state !== 'onTable') return;
  const crawling =
    Math.hypot(pen.vx, pen.vy) < tuning.restLinearSpeed &&
    Math.abs(pen.omega) < tuning.restAngularSpeed;
  if (crawling) stopPen(pen);
}

/**
 * How far something coasts from `speed` under constant deceleration `friction`
 * plus drag `damping` (dv/dt = -friction - damping * v). m
 *
 * The closed form the friction model above follows for a pen sliding without
 * spin, used to reason about reach without running the simulation.
 */
export function coastDistance(speed: number, friction: number, damping: number): number {
  if (speed <= 0) return 0;
  if (damping === 0) return friction > 0 ? (speed * speed) / (2 * friction) : Infinity;
  if (friction === 0) return speed / damping;
  return speed / damping - (friction / (damping * damping)) * Math.log(1 + (damping * speed) / friction);
}

/** How far a pen coasts from `speed` moving sideways (rolling), without spin. m */
export function rollingRange(spec: PenSpec, speed: number, gravity: number): number {
  return coastDistance(
    speed,
    spec.slideFriction * spec.rollFactor * gravity,
    spec.damping * spec.rollFactor,
  );
}

/** How far a pen coasts from `speed` moving end-on (skidding), without spin. m */
export function skiddingRange(spec: PenSpec, speed: number, gravity: number): number {
  return coastDistance(speed, spec.slideFriction * gravity, spec.damping);
}

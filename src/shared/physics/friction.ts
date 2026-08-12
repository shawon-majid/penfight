/**
 * Friction between a pen and the table.
 *
 * A pen does not touch the table at one point — it lies along it. Different
 * parts of the barrel can be sliding in different directions at once, so we
 * sample the barrel at several places, work out how fast each one is moving
 * over the table, and apply friction to each separately.
 *
 * That is more work than a pair of damping constants, and it buys one specific
 * thing: sliding and spinning have to *share* the grip available. The table
 * can only ever apply so much friction, and a pen that is spinning spends part
 * of that on stopping the spin, leaving less to stop the travel. So a pen
 * flicked with spin slides noticeably further than the same pen flicked flat —
 * around 40% further at high spin, with our numbers. Players feel this
 * immediately: a tip-flick is the long shot.
 *
 * What this does *not* produce is a curve. A symmetric rod cannot generate a
 * sideways friction force no matter how it spins — the contributions from the
 * two halves cancel exactly. Real pens curve because they are lopsided (a
 * heavy cap, a clip on one side), which is a thing to model later if the game
 * ever wants it, not something to fake here.
 */

import type { Pen } from './pen';
import { applyImpulseAt, penAxis, stopPen, velocityAt } from './pen';
import type { Tuning } from './tuning';
import { cross, vec } from './vec2';

/**
 * Apply one step's worth of table friction.
 *
 * Friction is applied as an impulse per sample rather than a force, and each
 * impulse is capped at whatever would bring that sample to a standstill. That
 * cap is what stops a pen at the end of its travel from jittering backwards
 * and forwards across zero.
 */
export function applyTableFriction(pen: Pen, dt: number, tuning: Tuning): void {
  if (pen.state !== 'onTable') return;

  const sampleCount = tuning.frictionSamples;
  // The table holds the pen's whole weight, shared out along the barrel.
  const gripPerSample =
    (tuning.tableFriction * pen.mass * tuning.gravity * dt) / sampleCount;
  if (gripPerSample <= 0) return;

  const axis = penAxis(pen);
  const half = pen.length / 2;

  for (let i = 0; i < sampleCount; i++) {
    // Sample centres, evenly spread from tail to tip.
    const along = -half + pen.length * ((i + 0.5) / sampleCount);
    const point = vec(pen.x + axis.x * along, pen.y + axis.y * along);

    const slide = velocityAt(pen, point);
    const speed = Math.hypot(slide.x, slide.y);
    if (speed < 1e-9) continue;

    const direction = vec(slide.x / speed, slide.y / speed);

    // How much impulse it would take to arrest this point outright.
    const lever = cross(vec(point.x - pen.x, point.y - pen.y), direction);
    const effectiveMass = pen.invMass + lever * lever * pen.invInertia;
    const stoppingImpulse = speed / effectiveMass;

    // Friction can only ever slow things down, never push them back.
    const magnitude = Math.min(gripPerSample, stoppingImpulse);
    applyImpulseAt(
      pen,
      vec(-direction.x * magnitude, -direction.y * magnitude),
      point,
    );
  }
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

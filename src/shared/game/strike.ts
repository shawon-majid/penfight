/**
 * Turning a player's flick into an impulse.
 *
 * A strike is three things, and all three come out of one drag gesture:
 *
 *   - **where** you grabbed the pen  -> `contact`, in pen-local coordinates
 *   - **which way** you flicked it   -> `direction`
 *   - **how hard**                   -> `power`, 0 to 1
 *
 * Grab the middle and pull straight back and the pen leaves in a straight
 * line. Grab a tip and the same pull puts most of its energy into spin, so the
 * pen wheels away and sweeps a much wider path. Nothing special-cases that —
 * it is what `applyImpulseAt` does with a lever arm.
 *
 * A strike is also the only thing that travels over the network, which is why
 * it is a small plain object: four numbers and an id.
 */

import type { PenLocalPoint } from '../physics/pen';
import { clampMotion, localToWorld, worldToLocal } from '../physics/pen';
import type { Pen } from '../physics/pen';
import { applyImpulseAt } from '../physics/pen';
import type { Tuning } from '../physics/tuning';
import type { Vec2 } from '../physics/vec2';
import { clamp, cross, normalize, sub, vec } from '../physics/vec2';
import type { World } from '../physics/world';
import { beginTurn, findPen } from '../physics/world';

export interface Strike {
  penId: string;
  /** Where on the pen the flick lands. `along` -1..1, `across` -1..1. */
  contact: PenLocalPoint;
  /** Unit vector the pen is flicked along. */
  direction: Vec2;
  /** 0 for a tap, 1 for everything you have. */
  power: number;
}

export type StrikeRejection =
  | 'no-such-pen'
  | 'pen-not-in-play'
  | 'not-your-pen'
  | 'no-direction'
  | 'no-power';

export type StrikeCheck = { ok: true } | { ok: false; reason: StrikeRejection };

/**
 * Is this strike allowed right now?
 *
 * The server runs this before touching the world, so a doctored client cannot
 * flick somebody else's pen or a pen that has already fallen. Whose turn it is
 * is checked one layer up, in `match.ts`.
 */
export function checkStrike(
  world: World,
  playerId: string,
  strike: Strike,
): StrikeCheck {
  const pen = findPen(world, strike.penId);
  if (!pen) return { ok: false, reason: 'no-such-pen' };
  if (pen.state !== 'onTable') return { ok: false, reason: 'pen-not-in-play' };
  if (pen.ownerId !== playerId) return { ok: false, reason: 'not-your-pen' };

  const direction = normalize(strike.direction);
  if (direction.x === 0 && direction.y === 0) {
    return { ok: false, reason: 'no-direction' };
  }
  if (!(strike.power > 0)) return { ok: false, reason: 'no-power' };

  return { ok: true };
}

/**
 * Clean up a strike that arrived over the wire.
 *
 * Everything is clamped into range, so a client sending `power: 9999` gets a
 * full-power shot and nothing worse.
 */
export function sanitiseStrike(strike: Strike): Strike {
  return {
    penId: strike.penId,
    contact: {
      along: clamp(strike.contact.along, -1, 1),
      across: clamp(strike.contact.across, -1, 1),
    },
    direction: normalize(strike.direction),
    power: clamp(strike.power, 0, 1),
  };
}

/**
 * Put a strike into the world.
 *
 * The impulse goes in at the contact point, so the lever arm between that
 * point and the pen's centre of mass decides the split between travel and
 * spin. `strikeSpinFactor` trims the rotational half — see `tuning.ts`.
 */
export function applyStrike(world: World, strike: Strike): void {
  const pen = findPen(world, strike.penId);
  if (!pen) return;

  const clean = sanitiseStrike(strike);
  const impulseMagnitude = clean.power * world.tuning.maxStrikeImpulse;
  const impulse = vec(
    clean.direction.x * impulseMagnitude,
    clean.direction.y * impulseMagnitude,
  );

  applyImpulseAt(
    pen,
    impulse,
    localToWorld(pen, clean.contact),
    world.tuning.strikeSpinFactor,
  );
  clampMotion(pen, world.tuning);
  beginTurn(world);
}

/**
 * Build a strike from a drag gesture.
 *
 * The gesture is a catapult: press on the pen, pull *away* from where you want
 * it to go, release. The pen leaves along the reverse of the pull, and the
 * length of the pull sets the power. One motion carries all three inputs.
 */
export function strikeFromDrag(
  pen: Pen,
  grabPoint: Vec2,
  releasePoint: Vec2,
  tuning: Tuning,
): Strike | null {
  const pull = sub(grabPoint, releasePoint);
  const distance = Math.hypot(pull.x, pull.y);
  if (distance < 1e-6) return null;

  return {
    penId: pen.id,
    contact: worldToLocal(pen, grabPoint),
    direction: vec(pull.x / distance, pull.y / distance),
    power: clamp(distance / tuning.fullPowerDragDistance, 0, 1),
  };
}

export interface StrikePreview {
  /** Speed the pen will leave at. m/s */
  speed: number;
  /** Spin it will leave with. rad/s, counter-clockwise positive. */
  spin: number;
  /** 0 = pure push, 1 = as much spin as this pen can be given. */
  spinShare: number;
  /** Where the flick lands, in world space. */
  contactPoint: Vec2;
}

/**
 * What a strike would do, without doing it.
 *
 * The aim overlay uses this to show the player the trade-off live: pull the
 * grab point towards a tip and watch the spin indicator wind up while the
 * straight-line speed stays the same.
 */
export function previewStrike(pen: Pen, strike: Strike, tuning: Tuning): StrikePreview {
  const clean = sanitiseStrike(strike);
  const magnitude = clean.power * tuning.maxStrikeImpulse;
  const contactPoint = localToWorld(pen, clean.contact);
  const impulse = vec(clean.direction.x * magnitude, clean.direction.y * magnitude);
  const lever = sub(contactPoint, vec(pen.x, pen.y));

  const spin = clamp(
    cross(lever, impulse) * pen.invInertia * tuning.strikeSpinFactor,
    -tuning.maxAngularVelocity,
    tuning.maxAngularVelocity,
  );

  // The most spin a full-power flick could produce: all of it at a tip, square on.
  const maxLever = pen.length / 2;
  const maxSpin =
    tuning.maxStrikeImpulse * maxLever * pen.invInertia * tuning.strikeSpinFactor;

  return {
    speed: magnitude * pen.invMass,
    spin,
    spinShare: maxSpin > 0 ? Math.min(1, Math.abs(spin) / maxSpin) : 0,
    contactPoint,
  };
}

/**
 * Pen-on-pen contact: finding hits and resolving them.
 *
 * This is where "it matters where you hit it" gets its second half. The strike
 * decides how your own pen leaves; this decides what happens to everything it
 * runs into. A hit near another pen's tip spins that pen; a hit through its
 * middle shoves it flat. Both fall out of the same impulse equation, because
 * the lever arm from each pen's centre of mass to the contact point is part of
 * it.
 */

import type { Pen } from './pen';
import { applyImpulseAt, penEndpoints, velocityAt } from './pen';
import type { Tuning } from './tuning';
import type { Vec2 } from './vec2';
import { cross, normalize, perp, sub, vec } from './vec2';
import { closestPointsBetweenSegments } from './geometry';

export interface Contact {
  a: Pen;
  b: Pen;
  /** Where the two pens touch, in world space. */
  point: Vec2;
  /** Unit vector pointing from `b` towards `a`. */
  normal: Vec2;
  /** How deeply the two capsules overlap. m */
  penetration: number;
}

/** A resolved hit, surfaced so the client can spark and clack at the right spot. */
export interface CollisionEvent {
  penA: string;
  penB: string;
  point: Vec2;
  /** Strength of the hit along the normal. kg*m/s */
  impulse: number;
}

/**
 * Test two pens for overlap.
 *
 * Both are capsules, so they touch exactly when their core segments are closer
 * than the sum of their radii.
 */
export function findContact(a: Pen, b: Pen): Contact | null {
  if (a.state !== 'onTable' || b.state !== 'onTable') return null;

  const [aTail, aTip] = penEndpoints(a);
  const [bTail, bTip] = penEndpoints(b);
  const closest = closestPointsBetweenSegments(aTail, aTip, bTail, bTip);

  const touchDistance = a.radius + b.radius;
  if (closest.distance >= touchDistance) return null;

  // Degenerate case: the two core segments are exactly coincident, so there is
  // no direction to push apart along. Fall back to separating the centres, and
  // failing that, an arbitrary but stable axis.
  let normal = normalize(sub(closest.c1, closest.c2));
  if (normal.x === 0 && normal.y === 0) {
    normal = normalize(sub(vec(a.x, a.y), vec(b.x, b.y)));
    if (normal.x === 0 && normal.y === 0) normal = vec(1, 0);
  }

  return {
    a,
    b,
    // Midway between the two surfaces, which is where the barrels meet.
    point: vec((closest.c1.x + closest.c2.x) / 2, (closest.c1.y + closest.c2.y) / 2),
    normal,
    penetration: touchDistance - closest.distance,
  };
}

/** Collect every overlapping pair. Ten pens is 45 pairs — brute force is fine. */
export function findContacts(pens: readonly Pen[]): Contact[] {
  const contacts: Contact[] = [];
  for (let i = 0; i < pens.length; i++) {
    for (let j = i + 1; j < pens.length; j++) {
      const contact = findContact(pens[i], pens[j]);
      if (contact) contacts.push(contact);
    }
  }
  return contacts;
}

/**
 * Effective mass along `direction` for a pair of bodies touching at `point`.
 *
 * The lever-arm terms are what let an off-centre hit turn into spin: the
 * further the contact is from a pen's centre, the more of the impulse goes
 * into rotation rather than translation.
 */
function effectiveMass(contact: Contact, direction: Vec2): number {
  const { a, b, point } = contact;
  const leverA = cross(sub(point, vec(a.x, a.y)), direction);
  const leverB = cross(sub(point, vec(b.x, b.y)), direction);
  return (
    a.invMass +
    b.invMass +
    leverA * leverA * a.invInertia +
    leverB * leverB * b.invInertia
  );
}

/** Closing speed of the two pens at the contact, along `direction`. */
function relativeSpeedAlong(contact: Contact, direction: Vec2): number {
  const va = velocityAt(contact.a, contact.point);
  const vb = velocityAt(contact.b, contact.point);
  return (va.x - vb.x) * direction.x + (va.y - vb.y) * direction.y;
}

/**
 * Resolve one contact: bounce along the normal, then rub along the tangent.
 *
 * Returns the hit's normal impulse, or `null` if the pens were already moving
 * apart and nothing needed doing.
 */
export function resolveContact(contact: Contact, tuning: Tuning): CollisionEvent | null {
  const { a, b, normal, point } = contact;

  const approachSpeed = relativeSpeedAlong(contact, normal);
  // Positive means they are already separating; leave them alone.
  if (approachSpeed > 0) return null;

  // Barely-touching pens get no bounce, otherwise resting contacts buzz.
  const restitution =
    -approachSpeed > tuning.restLinearSpeed * 4 ? tuning.penRestitution : 0;

  const normalMass = effectiveMass(contact, normal);
  if (normalMass <= 0) return null;

  const normalImpulse = (-(1 + restitution) * approachSpeed) / normalMass;
  const impulseVector = vec(normal.x * normalImpulse, normal.y * normalImpulse);
  applyImpulseAt(a, impulseVector, point);
  applyImpulseAt(b, vec(-impulseVector.x, -impulseVector.y), point);

  applyContactFriction(contact, normalImpulse, tuning);
  separate(contact, tuning);

  return { penA: a.id, penB: b.id, point, impulse: normalImpulse };
}

/**
 * Coulomb friction across the contact.
 *
 * This is what makes glancing blows interesting: two barrels scraping past
 * each other trade spin, so a shot that clips the side of a pen sends it
 * skidding *and* turning.
 */
function applyContactFriction(contact: Contact, normalImpulse: number, tuning: Tuning): void {
  const tangent = perp(contact.normal);
  const slipSpeed = relativeSpeedAlong(contact, tangent);
  if (Math.abs(slipSpeed) < 1e-9) return;

  const tangentMass = effectiveMass(contact, tangent);
  if (tangentMass <= 0) return;

  // Impulse that would stop the slipping outright...
  const wanted = -slipSpeed / tangentMass;
  // ...capped by how much grip the normal force actually provides.
  const limit = tuning.penFriction * normalImpulse;
  const frictionImpulse = Math.max(-limit, Math.min(limit, wanted));

  const impulseVector = vec(tangent.x * frictionImpulse, tangent.y * frictionImpulse);
  applyImpulseAt(contact.a, impulseVector, contact.point);
  applyImpulseAt(contact.b, vec(-impulseVector.x, -impulseVector.y), contact.point);
}

/**
 * Nudge overlapping pens apart.
 *
 * Impulses fix velocities, not positions, so without this pens slowly sink
 * into one another. A slop margin and a partial correction keep it from
 * turning into a jitter source.
 */
function separate(contact: Contact, tuning: Tuning): void {
  const overshoot = contact.penetration - tuning.penetrationSlop;
  if (overshoot <= 0) return;

  const { a, b, normal } = contact;
  const totalInvMass = a.invMass + b.invMass;
  if (totalInvMass <= 0) return;

  const push = (overshoot * tuning.penetrationCorrection) / totalInvMass;
  a.x += normal.x * push * a.invMass;
  a.y += normal.y * push * a.invMass;
  b.x -= normal.x * push * b.invMass;
  b.y -= normal.y * push * b.invMass;
}

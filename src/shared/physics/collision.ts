/**
 * Pen-on-pen hits: the rules the engine is told to follow, and what it reports.
 *
 * The contact solving itself — finding where barrels touch, stopping them
 * overlapping, bouncing and rubbing — is done by the physics engine (Planck, a
 * port of Box2D), which handles crowds and fast pens far better than a
 * hand-written solver. What stays here is the game's say in it: how two pens'
 * bounciness combines, and what counts as a hit worth hearing.
 */

import type { Vec2 } from './vec2';
import type { Tuning } from './tuning';

/** A resolved hit, surfaced so the client can spark and clack at the right spot. */
export interface CollisionEvent {
  penA: string;
  penB: string;
  point: Vec2;
  /** Strength of the hit along the normal, summed over the frame. kg*m/s */
  impulse: number;
}

/**
 * How bouncy a hit between two pens is.
 *
 * The average of the two, so a lively metal pen against a dead marker is in
 * between, plus the world's `bounceBoost`: hard plastic barely deforms, and a
 * hit should snap.
 */
export function mixRestitution(bounceA: number, bounceB: number, tuning: Tuning): number {
  return Math.min(tuning.maxRestitution, (bounceA + bounceB) / 2 + tuning.bounceBoost);
}

/**
 * How grippy a rub between two pens is. The geometric mean, so a frictionless
 * pen stays frictionless against anything.
 */
export function mixFriction(frictionA: number, frictionB: number): number {
  return Math.sqrt(frictionA * frictionB);
}

/**
 * Every pen in the game.
 *
 * Adding a pen is adding an entry here. `tests/pens.test.ts` validates every
 * entry and `tests/balance.test.ts` checks each one's reach, so a pen that is
 * broken or overpowered fails the build rather than a match.
 *
 * The rough personalities, so new entries can find a gap:
 *
 *   - standard     the all-rounder everyone starts with
 *   - ballpoint    light and thin: rolls furthest, hits softest
 *   - gel          rubber grip: takes a flick well, stops sooner
 *   - marker       heavy cap, fat barrel: hard to shift, turns towards its cap
 *   - metal        heavy and slick: hits hardest, bounces most, travels least
 */

import type { PenSpec } from './spec';

export const DEFAULT_PEN_SPEC_ID = 'standard';

const PENS: readonly PenSpec[] = [
  {
    id: 'standard',
    name: 'Standard',
    length: 0.14,
    radius: 0.006,
    tip: 'pointed',
    tail: 'round',
    mass: 0.01,
    comOffset: 0.003,
    slideFriction: 0.2,
    rollFactor: 0.7,
    damping: 3,
    spinDamping: 1.5,
    bounce: 0.32,
    contactFriction: 0.15,
    flickPower: 1,
    axialEfficiency: 0.65,
  },
  {
    id: 'ballpoint',
    name: 'Ballpoint',
    length: 0.145,
    radius: 0.0045,
    tip: 'pointed',
    tail: 'round',
    mass: 0.0075,
    comOffset: 0.004,
    slideFriction: 0.18,
    rollFactor: 0.62,
    damping: 3.2,
    spinDamping: 1.3,
    bounce: 0.28,
    contactFriction: 0.14,
    flickPower: 0.97,
    axialEfficiency: 0.6,
  },
  {
    id: 'gel',
    name: 'Gel',
    length: 0.14,
    radius: 0.0058,
    tip: 'pointed',
    tail: 'round',
    mass: 0.0105,
    comOffset: 0.002,
    slideFriction: 0.24,
    rollFactor: 0.72,
    damping: 3,
    spinDamping: 1.9,
    bounce: 0.34,
    contactFriction: 0.2,
    flickPower: 1.05,
    axialEfficiency: 0.7,
  },
  {
    id: 'marker',
    name: 'Marker',
    length: 0.13,
    radius: 0.0085,
    tip: 'round',
    tail: 'flat',
    mass: 0.0125,
    comOffset: -0.006,
    slideFriction: 0.2,
    rollFactor: 0.8,
    damping: 2.3,
    spinDamping: 2.1,
    bounce: 0.25,
    contactFriction: 0.18,
    flickPower: 1,
    axialEfficiency: 0.65,
  },
  {
    id: 'metal',
    name: 'Metal',
    length: 0.14,
    radius: 0.005,
    tip: 'pointed',
    tail: 'flat',
    mass: 0.016,
    comOffset: 0.001,
    slideFriction: 0.14,
    rollFactor: 0.78,
    damping: 2.4,
    spinDamping: 1.2,
    bounce: 0.4,
    contactFriction: 0.1,
    flickPower: 1,
    axialEfficiency: 0.55,
  },
];

const BY_ID = new Map(PENS.map((spec) => [spec.id, spec]));

/** Every pen, in the order a picker should show them. */
export const PEN_CATALOGUE: readonly PenSpec[] = PENS;

export function isPenSpecId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * The spec for `id`, or the standard pen if there is no such pen.
 *
 * Falling back rather than throwing means a snapshot saved before a pen was
 * retired, or a doctored client asking for a pen that does not exist, still
 * produces a playable table.
 */
export function resolvePenSpec(id: string | undefined): PenSpec {
  return (id !== undefined && BY_ID.get(id)) || BY_ID.get(DEFAULT_PEN_SPEC_ID)!;
}

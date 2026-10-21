/**
 * What makes one pen different from another.
 *
 * Every number the physics needs to know about a *particular* pen lives here,
 * in real units, so a new pen is one entry in `catalogue.ts` and nothing else.
 * World-wide numbers (timestep, rest thresholds, how hard a finger can flick)
 * stay in `tuning.ts`.
 *
 * Mass properties are deliberately not hand-entered. Inertia and the way the
 * table carries the pen's weight are derived from `mass`, `length` and
 * `comOffset`, so a new pen cannot be given a moment of inertia that does not
 * match its shape.
 */

/** How the writing end is shaped. A point lets a glancing hit slide off. */
export type TipShape = 'round' | 'pointed';
/** How the back end is shaped. A flat cap hits square. */
export type TailShape = 'round' | 'flat';

export interface PenSpec {
  readonly id: string;
  /** What players see it called. */
  readonly name: string;

  // ---- Shape ----------------------------------------------------------
  /** Tip to tail. m */
  readonly length: number;
  /** Half the barrel's thickness. m */
  readonly radius: number;
  readonly tip: TipShape;
  readonly tail: TailShape;

  // ---- Mass -----------------------------------------------------------
  /** kg */
  readonly mass: number;
  /**
   * How far the centre of mass sits from the middle of the barrel, towards the
   * tip (negative: towards the tail). m
   *
   * This is what makes a spinning pen curve. The table carries more of the
   * pen's weight near its centre of mass, so that end grips harder, and a pen
   * that is sliding and spinning at once is pulled round by its heavy end.
   */
  readonly comOffset: number;

  // ---- Against the table ---------------------------------------------
  /** Coulomb friction coefficient for sliding along the barrel. */
  readonly slideFriction: number;
  /**
   * Friction and drag across the barrel, as a fraction of what they are along
   * it.
   *
   * A round barrel pushed sideways rolls rather than slides, so it meets far
   * less resistance. Low values roll freely; 1 means it does not roll at all.
   */
  readonly rollFactor: number;
  /** Speed-proportional drag on travel along the barrel. 1/s */
  readonly damping: number;
  /** Speed-proportional drag on spin. 1/s */
  readonly spinDamping: number;

  // ---- Against other pens ---------------------------------------------
  /** Bounciness, 0 to 1. Mixed with the other pen's at each hit. */
  readonly bounce: number;
  /** Friction where two barrels rub. Drives spin on glancing hits. */
  readonly contactFriction: number;

  // ---- Being flicked ---------------------------------------------------
  /** Multiplier on finger speed. A grippy barrel takes a flick better. */
  readonly flickPower: number;
  /**
   * How much of a push along the barrel actually lands, 0 to 1.
   *
   * A finger pushing a pen end-on slides off the rounded end; a finger pushing
   * it sideways meets the full barrel. 1 means both are the same.
   */
  readonly axialEfficiency: number;
}

/**
 * Moment of inertia about the centre of mass.
 *
 * A pen is close enough to a uniform rod plus its thickness that this is
 * honest; the centre-of-mass offset is small enough not to change it.
 */
export function inertiaOf(spec: PenSpec): number {
  const width = spec.radius * 2;
  return (spec.mass * (spec.length * spec.length + width * width)) / 12;
}

/**
 * How the pen's weight is shared between `count` evenly spaced points along
 * the barrel, tail first. Sums to 1.
 *
 * The share grows linearly towards the centre of mass, with the slope chosen
 * so the weighted average position is exactly `comOffset` — which is what it
 * has to be for the table's push to balance the pen's weight.
 */
export function loadShares(spec: PenSpec, count: number): number[] {
  const positions = samplePositions(spec, count);
  const variance = positions.reduce((sum, s) => sum + s * s, 0) / count;
  const slope = variance > 0 ? spec.comOffset / variance : 0;
  return positions.map((s) => (1 + slope * s) / count);
}

/** Distance of each friction sample from the middle of the barrel, tail first. m */
export function samplePositions(spec: PenSpec, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => -spec.length / 2 + spec.length * ((i + 0.5) / count),
  );
}

/**
 * Everything wrong with a spec, or an empty list if it is usable.
 *
 * The ranges are wide enough for any pen anyone would make, and narrow enough
 * that the solver and the balance tests stay meaningful.
 */
export function validateSpec(spec: PenSpec): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(`${spec.id}: ${message}`);
  };

  const numbers: Array<[string, number]> = [
    ['length', spec.length],
    ['radius', spec.radius],
    ['mass', spec.mass],
    ['comOffset', spec.comOffset],
    ['slideFriction', spec.slideFriction],
    ['rollFactor', spec.rollFactor],
    ['damping', spec.damping],
    ['spinDamping', spec.spinDamping],
    ['bounce', spec.bounce],
    ['contactFriction', spec.contactFriction],
    ['flickPower', spec.flickPower],
    ['axialEfficiency', spec.axialEfficiency],
  ];
  for (const [name, value] of numbers) check(Number.isFinite(value), `${name} is not a number`);
  if (problems.length > 0) return problems;

  check(spec.id.length > 0, 'id is empty');
  check(spec.length >= 0.05 && spec.length <= 0.3, 'length should be 5-30 cm');
  check(spec.radius >= 0.002 && spec.radius <= 0.02, 'radius should be 2-20 mm');
  check(spec.length >= spec.radius * 8, 'pen is too stubby for its thickness');
  check(spec.mass > 0 && spec.mass <= 0.1, 'mass should be up to 100 g');
  // Past L/6 the load share at the light end would go negative.
  check(Math.abs(spec.comOffset) <= spec.length / 8, 'centre of mass is too far off-centre');
  check(spec.slideFriction > 0 && spec.slideFriction <= 1.5, 'slideFriction should be 0-1.5');
  check(spec.rollFactor > 0 && spec.rollFactor <= 1, 'rollFactor should be 0-1');
  check(spec.damping >= 0 && spec.damping <= 8, 'damping should be 0-8');
  check(spec.spinDamping >= 0 && spec.spinDamping <= 5, 'spinDamping should be 0-5');
  check(spec.bounce >= 0 && spec.bounce <= 1, 'bounce should be 0-1');
  check(spec.contactFriction >= 0 && spec.contactFriction <= 1.5, 'contactFriction should be 0-1.5');
  check(spec.flickPower > 0 && spec.flickPower <= 1.5, 'flickPower should be 0-1.5');
  check(spec.axialEfficiency > 0 && spec.axialEfficiency <= 1, 'axialEfficiency should be 0-1');
  return problems;
}

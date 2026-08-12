/**
 * Every number that decides how the game *feels*, in one place.
 *
 * The simulation runs in real SI units — metres, kilograms, seconds — so these
 * values can be reasoned about against a real desk and a real pen. Rendering
 * converts metres to pixels at draw time; nothing in `physics/` knows about
 * pixels.
 *
 * Two of these are deliberately *not* physical (`strikeSpinFactor` and
 * `maxAngularVelocity`). A real finger-flick delivers force through a sliding,
 * finite-width contact, which bleeds off spin in a way a point impulse does
 * not. Rather than model a fingernail, we scale the strike's torque. They are
 * marked FEEL below.
 */

export interface Tuning {
  // ---- World ----------------------------------------------------------
  /** Gravity, used only to work out how hard the table presses back. m/s^2 */
  gravity: number;
  /** Longest simulation sub-step. Smaller is more stable, more expensive. */
  maxSubStep: number;
  /**
   * A pen may not travel further than `penRadius * this` in one sub-step.
   * Keeps fast pens from passing straight through each other.
   */
  maxTravelPerStepInRadii: number;
  /** Hard ceiling on sub-steps per frame, so a bad frame cannot stall us. */
  maxSubStepsPerFrame: number;

  // ---- Pen body -------------------------------------------------------
  /** Tip-to-tip length of a pen. m */
  penLength: number;
  /** Half-thickness of the barrel; also the capsule's cap radius. m */
  penRadius: number;
  /** Mass of one pen. kg */
  penMass: number;

  // ---- Pen against the table -----------------------------------------
  /** Sliding friction between a pen barrel and the table surface. */
  tableFriction: number;
  /**
   * How many points along the barrel we sample when applying table friction.
   * More samples give a smoother coupling between sliding and spinning; 8 is
   * plenty. This is *why* a spinning pen curves as it slides.
   */
  frictionSamples: number;

  // ---- Pen against pen ------------------------------------------------
  /** Bounciness of a pen-on-pen hit. 0 = dead thud, 1 = perfect bounce. */
  penRestitution: number;
  /** Friction at a pen-on-pen contact. Drives spin transfer on glancing hits. */
  penFriction: number;
  /** Fraction of overlap corrected per step. Stops pens sinking into each other. */
  penetrationCorrection: number;
  /** Overlap we tolerate without correcting, to avoid contact jitter. m */
  penetrationSlop: number;

  // ---- Striking -------------------------------------------------------
  /**
   * Impulse delivered by a full-power flick. kg*m/s
   *
   * This is the single most important number in the game, because it sets two
   * distances at once. A pen coasts `v^2 / (2 * tableFriction * gravity)`
   * before stopping, and a pen it hits square leaves with about 72% of that
   * speed, so it coasts roughly half as far.
   *
   * With the table below that works out at: a full-power miss carries your own
   * pen off the far edge, and a full-power hit carries your opponent about
   * half the table. So you cannot kill from anywhere — you have to work
   * somebody towards an edge first, and going for a big shot is a real risk.
   * `tests/balance.test.ts` keeps that relationship honest.
   */
  maxStrikeImpulse: number;
  /** Drag distance (in metres of table) that counts as full power. */
  fullPowerDragDistance: number;
  /** FEEL: how much of the off-centre torque a strike actually imparts. */
  strikeSpinFactor: number;
  /** FEEL: ceiling on spin rate so a tip-hit stays readable. rad/s */
  maxAngularVelocity: number;
  /** Ceiling on speed, so nothing outruns the collision sub-stepping. m/s */
  maxLinearVelocity: number;

  // ---- Coming to rest -------------------------------------------------
  /** Below this speed a pen counts as still. m/s */
  restLinearSpeed: number;
  /** Below this spin rate a pen counts as still. rad/s */
  restAngularSpeed: number;
  /** Consecutive still steps before the table is declared settled. */
  restStepsRequired: number;
  /** Safety valve: force the turn to end after this long. seconds */
  maxTurnDuration: number;

  // ---- Falling off ----------------------------------------------------
  /** How long a pen's fall off the edge is animated before it is gone. seconds */
  fallDuration: number;
}

export const DEFAULT_TUNING: Tuning = {
  gravity: 9.81,
  maxSubStep: 1 / 480,
  maxTravelPerStepInRadii: 0.5,
  maxSubStepsPerFrame: 240,

  penLength: 0.14,
  penRadius: 0.006,
  penMass: 0.01,

  tableFriction: 0.28,
  frictionSamples: 8,

  penRestitution: 0.45,
  penFriction: 0.2,
  penetrationCorrection: 0.8,
  penetrationSlop: 0.0002,

  maxStrikeImpulse: 0.028,
  fullPowerDragDistance: 0.28,
  strikeSpinFactor: 0.35,
  maxAngularVelocity: 45,
  maxLinearVelocity: 4.5,

  restLinearSpeed: 0.012,
  restAngularSpeed: 0.15,
  restStepsRequired: 12,
  maxTurnDuration: 12,

  fallDuration: 0.45,
};

/** Build a tuning set with a few values overridden. Handy for tests and mods. */
export function tuningWith(overrides: Partial<Tuning>): Tuning {
  return { ...DEFAULT_TUNING, ...overrides };
}

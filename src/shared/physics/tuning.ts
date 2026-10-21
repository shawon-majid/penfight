/**
 * The world-wide numbers that decide how the game *feels*, in one place.
 *
 * Anything that belongs to a particular pen — its mass, grip, bounce — lives in
 * its `PenSpec` (`physics/pens/`). What is left here is the same for every pen
 * on the table: the timestep, how hard a finger can flick, when the table
 * counts as settled.
 *
 * The simulation runs in real SI units — metres, kilograms, seconds. The
 * physics engine underneath works at a larger scale internally (see
 * `engine.ts`), and rendering converts to pixels at draw time; nothing in here
 * knows about either.
 */

export interface Tuning {
  // ---- World ----------------------------------------------------------
  /** Gravity, used only to work out how hard the table presses back. m/s^2 */
  gravity: number;
  /**
   * Engine steps per game frame. The game advances at a fixed 60 frames a
   * second; 2 here runs the solver at 120 Hz underneath.
   */
  engineStepsPerFrame: number;
  /** Solver passes over velocities per engine step. More resolves crowds better. */
  velocityIterations: number;
  /** Solver passes over overlaps per engine step. */
  positionIterations: number;
  /**
   * Points along the barrel where table friction is applied. More gives a
   * smoother coupling between sliding and spinning; 8 is plenty.
   */
  frictionSamples: number;

  // ---- Flicking -------------------------------------------------------
  /**
   * How fast a full-power finger is moving when it meets the pen. m/s
   *
   * A flick sets the speed of the point it lands on, not a fixed shove. Hit
   * the middle and the pen leaves at this speed; hit the tip and the tip
   * leaves at this speed, which means the pen as a whole travels about a
   * quarter as fast and spins hard. That trade is the heart of the game.
   */
  maxFlickSpeed: number;
  /**
   * The most impulse a finger can deliver. kg*m/s
   *
   * Above this a heavier pen simply leaves slower: it hits harder when it gets
   * there, but it does not get as far. That is the trade every heavy pen in
   * the catalogue makes.
   */
  maxFlickImpulse: number;
  /**
   * Power curve. Finger speed is `power ^ this`, so the low end of the drag is
   * finely controllable and only the last stretch is a big shot.
   */
  powerCurve: number;
  /** Drag distance (in metres of table) that counts as full power. */
  fullPowerDragDistance: number;

  // ---- Pen against pen --------------------------------------------------
  /**
   * Added to the average of two pens' `bounce` at every hit. Real pens are
   * lively — hard plastic barely deforms — and this is what makes a hit snap.
   */
  bounceBoost: number;
  /** Ceiling on the mixed bounce. 1 would be a perfect, lossless bounce. */
  maxRestitution: number;
  /** Hits softer than this are resting contact, not a hit. kg*m/s */
  minHitImpulse: number;

  // ---- Coming to rest -------------------------------------------------
  /** Below this speed a pen counts as still. m/s */
  restLinearSpeed: number;
  /** Below this spin rate a pen counts as still. rad/s */
  restAngularSpeed: number;
  /** Consecutive still frames before the table is declared settled. */
  restStepsRequired: number;
  /** Safety valve: force the turn to end after this long. seconds */
  maxTurnDuration: number;

  // ---- Falling off ----------------------------------------------------
  /** How long a pen's fall off the edge is animated before it is gone. seconds */
  fallDuration: number;
}

export const DEFAULT_TUNING: Tuning = {
  gravity: 9.81,
  engineStepsPerFrame: 2,
  velocityIterations: 8,
  positionIterations: 3,
  frictionSamples: 8,

  maxFlickSpeed: 3.9,
  maxFlickImpulse: 0.04,
  powerCurve: 1.25,
  fullPowerDragDistance: 0.28,

  bounceBoost: 0.38,
  maxRestitution: 0.95,
  minHitImpulse: 0.0002,

  restLinearSpeed: 0.01,
  restAngularSpeed: 0.05,
  restStepsRequired: 15,
  maxTurnDuration: 12,

  fallDuration: 0.45,
};

/** Build a tuning set with a few values overridden. Handy for tests and mods. */
export function tuningWith(overrides: Partial<Tuning>): Tuning {
  return { ...DEFAULT_TUNING, ...overrides };
}

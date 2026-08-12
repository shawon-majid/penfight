/**
 * The simulation loop: advance every pen, resolve what they run into, and
 * notice when the table has come to rest.
 *
 * `step` is deterministic. Feed two copies of a world the same sequence of
 * `step(dt)` calls and they stay in lockstep, which is what lets the browser
 * animate a shot locally while the server independently confirms it.
 *
 * Nothing in here knows about players, turns or winning — that lives in
 * `game/match.ts`. This module only knows about pens on a rectangle.
 */

import type { CollisionEvent } from './collision';
import { findContacts, resolveContact } from './collision';
import { applyTableFriction, arrestIfCreeping } from './friction';
import type { Pen, PenSpawn } from './pen';
import { clampMotion, clonePen, createPen, maxPointSpeed, stopPen } from './pen';
import type { Table } from './table';
import { DEFAULT_TABLE, isOverEdge } from './table';
import { DEFAULT_TUNING, type Tuning } from './tuning';

/** How many times per second the physics advances. Fixed, on every machine. */
export const SIM_HZ = 60;
export const SIM_STEP = 1 / SIM_HZ;

/**
 * Contacts are resolved more than once per sub-step. One pass is enough for an
 * isolated hit, but in a crowd resolving A-B can push A back into C, and the
 * extra passes let that settle out.
 */
const CONTACT_ITERATIONS = 3;

export interface World {
  table: Table;
  tuning: Tuning;
  pens: Pen[];
  /** Seconds simulated since the last strike. Used for the turn timeout. */
  elapsed: number;
  /** Consecutive still sub-steps, counting towards "the table has settled". */
  restSteps: number;
}

export interface StepResult {
  /** True once nothing is moving and no pen is mid-fall. */
  settled: boolean;
  /** Hits resolved this step, for sound and sparks. */
  collisions: CollisionEvent[];
  /** Pens that went over the edge this step. */
  startedFalling: string[];
  /** Pens whose fall finished this step — these are now out of the game. */
  finishedFalling: string[];
}

export function createWorld(
  spawns: readonly PenSpawn[],
  table: Table = DEFAULT_TABLE,
  tuning: Tuning = DEFAULT_TUNING,
): World {
  return {
    table,
    tuning,
    pens: spawns.map((spawn) => createPen(spawn, tuning)),
    elapsed: 0,
    restSteps: 0,
  };
}

export function cloneWorld(world: World): World {
  return {
    table: { ...world.table },
    tuning: { ...world.tuning },
    pens: world.pens.map(clonePen),
    elapsed: world.elapsed,
    restSteps: world.restSteps,
  };
}

export function findPen(world: World, penId: string): Pen | undefined {
  return world.pens.find((pen) => pen.id === penId);
}

export function livePens(world: World): Pen[] {
  return world.pens.filter((pen) => pen.state === 'onTable');
}

/** Reset the settle bookkeeping. Call this whenever a new strike goes in. */
export function beginTurn(world: World): void {
  world.elapsed = 0;
  world.restSteps = 0;
}

/**
 * Advance the world by one fixed frame.
 *
 * A frame is broken into sub-steps small enough that no pen travels further
 * than a fraction of its own thickness, otherwise a fast pen could pass clean
 * through another between two samples.
 */
export function step(world: World): StepResult {
  const result: StepResult = {
    settled: false,
    collisions: [],
    startedFalling: [],
    finishedFalling: [],
  };

  const subSteps = chooseSubStepCount(world);
  const dt = SIM_STEP / subSteps;

  for (let i = 0; i < subSteps; i++) {
    advance(world, dt, result);
  }

  world.elapsed += SIM_STEP;
  result.settled = isSettled(world, result);
  return result;
}

/**
 * Pick a sub-step count from the fastest thing on the table.
 *
 * Derived only from world state, so every machine picks the same number and
 * the simulation stays reproducible.
 */
function chooseSubStepCount(world: World): number {
  let fastest = 0;
  for (const pen of world.pens) {
    if (pen.state !== 'onTable') continue;
    const speed = maxPointSpeed(pen);
    if (speed > fastest) fastest = speed;
  }

  if (fastest <= 0) return 1;

  const { tuning } = world;
  const safeDistance = tuning.penRadius * tuning.maxTravelPerStepInRadii;
  const safeDt = Math.min(tuning.maxSubStep, safeDistance / fastest);
  const needed = Math.ceil(SIM_STEP / safeDt);
  return Math.max(1, Math.min(tuning.maxSubStepsPerFrame, needed));
}

function advance(world: World, dt: number, result: StepResult): void {
  const { tuning } = world;

  // 1. The table drags on everything touching it.
  for (const pen of world.pens) {
    applyTableFriction(pen, dt, tuning);
    clampMotion(pen, tuning);
  }

  // 2. Move.
  for (const pen of world.pens) {
    if (pen.state === 'onTable') {
      pen.x += pen.vx * dt;
      pen.y += pen.vy * dt;
      pen.angle += pen.omega * dt;
    } else if (pen.state === 'falling') {
      advanceFall(pen, dt, tuning, result);
    }
  }

  // 3. Sort out anything that now overlaps.
  for (let iteration = 0; iteration < CONTACT_ITERATIONS; iteration++) {
    const contacts = findContacts(world.pens);
    if (contacts.length === 0) break;
    for (const contact of contacts) {
      const event = resolveContact(contact, tuning);
      // Only report a hit the first time round, or one clack becomes three.
      if (event && iteration === 0) result.collisions.push(event);
    }
  }

  // 4. Anything past the edge starts to fall.
  for (const pen of world.pens) {
    if (pen.state === 'onTable' && isOverEdge(pen, world.table)) {
      pen.state = 'falling';
      pen.fallProgress = 0;
      result.startedFalling.push(pen.id);
    }
  }

  // 5. Let slow crawlers stop, so turns end promptly.
  for (const pen of world.pens) {
    arrestIfCreeping(pen, tuning);
  }
}

/**
 * A falling pen keeps its momentum and carries on off the edge, purely for the
 * look of it. It no longer collides — `findContact` ignores it.
 */
function advanceFall(pen: Pen, dt: number, tuning: Tuning, result: StepResult): void {
  pen.x += pen.vx * dt;
  pen.y += pen.vy * dt;
  pen.angle += pen.omega * dt;
  pen.fallProgress += dt / tuning.fallDuration;
  if (pen.fallProgress >= 1) {
    pen.fallProgress = 1;
    pen.state = 'out';
    stopPen(pen);
    result.finishedFalling.push(pen.id);
  }
}

/**
 * The table is settled when every surviving pen is still and no pen is mid-air.
 *
 * The turn also ends on a timeout, so a pathological shot — two pens grinding
 * against each other, say — can never wedge the game open.
 */
function isSettled(world: World, result: StepResult): boolean {
  if (world.elapsed >= world.tuning.maxTurnDuration) {
    for (const pen of world.pens) {
      if (pen.state === 'onTable') stopPen(pen);
    }
    return true;
  }

  const anyFalling = world.pens.some((pen) => pen.state === 'falling');
  const anyMoving = world.pens.some(
    (pen) =>
      pen.state === 'onTable' &&
      (Math.hypot(pen.vx, pen.vy) >= world.tuning.restLinearSpeed ||
        Math.abs(pen.omega) >= world.tuning.restAngularSpeed),
  );

  if (anyFalling || anyMoving || result.collisions.length > 0) {
    world.restSteps = 0;
    return false;
  }

  world.restSteps += 1;
  return world.restSteps >= world.tuning.restStepsRequired;
}

/** Run until the table settles. Used by the server and by the bots' lookahead. */
export function simulateUntilSettled(world: World, maxFrames = SIM_HZ * 20): StepResult[] {
  const results: StepResult[] = [];
  for (let frame = 0; frame < maxFrames; frame++) {
    const result = step(world);
    results.push(result);
    if (result.settled) break;
  }
  return results;
}

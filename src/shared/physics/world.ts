/**
 * The simulation loop: advance every pen, resolve what they run into, and
 * notice when the table has come to rest.
 *
 * `step` is deterministic. Feed two copies of a world the same sequence of
 * `step(dt)` calls and they stay in lockstep, which is what lets the browser
 * animate a shot locally while the server independently confirms it.
 *
 * Each frame is split into engine steps (`tuning.engineStepsPerFrame`). Every
 * engine step runs table friction on the plain pen data, hands the pens to the
 * physics engine to move and collide (`engine.ts`), and reads them back.
 *
 * Nothing in here knows about players, turns or winning — that lives in
 * `game/match.ts`. This module only knows about pens on a table.
 */

import type { CollisionEvent } from './collision';
import { pullFromEngine, pushToEngine, resetEngine, stepEngine, takeHits } from './engine';
import { applyTableFriction, arrestIfCreeping } from './friction';
import type { Pen, PenSpawn } from './pen';
import { clonePen, createPen, stopPen } from './pen';
import type { Table } from './table';
import { DEFAULT_TABLE, isOverEdge } from './table';
import { DEFAULT_TUNING, type Tuning } from './tuning';

/** How many times per second the game advances. Fixed, on every machine. */
export const SIM_HZ = 60;
export const SIM_STEP = 1 / SIM_HZ;

export interface World {
  table: Table;
  tuning: Tuning;
  pens: Pen[];
  /** Seconds simulated since the last strike. Used for the turn timeout. */
  elapsed: number;
  /** Consecutive still frames, counting towards "the table has settled". */
  restSteps: number;
}

export interface StepResult {
  /** True once nothing is moving and no pen is mid-fall. */
  settled: boolean;
  /** Hits this frame, for sound and sparks. */
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
    pens: spawns.map((spawn) => createPen(spawn)),
    elapsed: 0,
    restSteps: 0,
  };
}

/**
 * A copy that can be stepped on its own. The engine is not copied: the copy
 * builds a fresh one on its first step, from the pens' plain state.
 */
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

/**
 * Reset the settle bookkeeping and start the engine afresh. Call this whenever
 * a new strike goes in.
 *
 * The fresh engine is what makes a shot reproducible anywhere: its outcome
 * depends only on where the pens are, never on what the engine happened to
 * remember from the last shot.
 */
export function beginTurn(world: World): void {
  world.elapsed = 0;
  world.restSteps = 0;
  resetEngine(world);
}

/** Advance the world by one fixed frame. */
export function step(world: World): StepResult {
  const result: StepResult = {
    settled: false,
    collisions: [],
    startedFalling: [],
    finishedFalling: [],
  };

  const steps = Math.max(1, Math.round(world.tuning.engineStepsPerFrame));
  const dt = SIM_STEP / steps;
  for (let i = 0; i < steps; i++) advance(world, dt, result);

  result.collisions = takeHits(world, world.tuning.minHitImpulse);
  world.elapsed += SIM_STEP;
  result.settled = isSettled(world, result);
  return result;
}

function advance(world: World, dt: number, result: StepResult): void {
  const { tuning } = world;

  // 1. The table drags on everything touching it.
  for (const pen of world.pens) applyTableFriction(pen, dt, tuning);

  // 2. Move and collide.
  pushToEngine(world);
  stepEngine(world, dt);
  pullFromEngine(world);

  // 3. Pens already over the edge keep falling; anything newly past it starts.
  for (const pen of world.pens) {
    if (pen.state === 'falling') {
      advanceFall(pen, dt, tuning, result);
    } else if (pen.state === 'onTable' && isOverEdge(pen, world.table)) {
      pen.state = 'falling';
      pen.fallProgress = 0;
      result.startedFalling.push(pen.id);
    }
  }

  // 4. Let slow crawlers stop, so turns end promptly.
  for (const pen of world.pens) arrestIfCreeping(pen, tuning);
}

/**
 * A falling pen keeps its momentum and carries on off the edge, purely for the
 * look of it. It no longer collides: the engine drops its body.
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
  if (world.restSteps < world.tuning.restStepsRequired) return false;

  // Settled: make "still" exactly still, so the next shot starts clean.
  for (const pen of world.pens) {
    if (pen.state === 'onTable') stopPen(pen);
  }
  return true;
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

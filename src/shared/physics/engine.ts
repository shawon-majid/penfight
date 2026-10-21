/**
 * The bridge between the game's plain pen data and the physics engine.
 *
 * The engine is Planck, a JavaScript port of Box2D. It does the hard parts of
 * rigid-body physics — exact contact shapes, a solver that copes with a pile of
 * pens, continuous collision so a fast pen can never pass through another —
 * and this module keeps it out of everybody else's way:
 *
 *   - **The plain data is the truth.** Every step, pen state is pushed into the
 *     engine and read back out. Anything else may edit a pen between steps
 *     (put it back on its spot, overwrite it from a server snapshot) and the
 *     engine just follows.
 *   - **Each world gets its own engine, held privately.** Cloning or
 *     serialising a `World` never touches it; a world without one gets a fresh
 *     one built on its next step.
 *   - **Every turn starts on a fresh engine.** So the outcome of a shot depends
 *     only on the pens' plain state and the strike — the same in the browser,
 *     on the server and in a bot's imagination.
 *
 * **Scale.** Box2D's internal tolerances are tuned for objects between 0.1 and
 * 10 units across, and its contact slop alone (5 mm at one unit per metre) is
 * nearly a pen's thickness. So the engine runs at `ENGINE_SCALE` units per
 * metre, which puts a 14 cm pen at 1.4 units, and everything is converted at
 * this boundary.
 */

import { Circle, Polygon, Settings, World as PlanckWorld } from 'planck';
import type { Body, Contact, ContactImpulse, Shape } from 'planck';
import type { CollisionEvent } from './collision';
import { mixFriction, mixRestitution } from './collision';
import type { Pen } from './pen';
import { resolvePenSpec } from './pens/catalogue';
import type { PenSpec } from './pens/spec';
import type { World } from './world';

/** Engine length units per metre. */
export const ENGINE_SCALE = 10;
const S = ENGINE_SCALE;

interface BodyEntry {
  body: Body;
  /** The pen object this body mirrors. A different object means rebuild. */
  pen: Pen;
  /** Pose as last read back, to spot outside edits. */
  x: number;
  y: number;
  angle: number;
}

interface HitTally {
  penA: string;
  penB: string;
  impulse: number;
  /** Impulse-weighted sum of contact points, for a fair average. */
  px: number;
  py: number;
}

interface Engine {
  world: PlanckWorld;
  bodies: Map<string, BodyEntry>;
  /** Hits accumulated since the last `takeHits`, keyed by pen pair. */
  hits: Map<string, HitTally>;
}

const engines = new WeakMap<World, Engine>();

/** Throw away a world's engine, so its next step starts from a clean one. */
export function resetEngine(world: World): void {
  engines.delete(world);
}

function engineFor(world: World): Engine {
  let engine = engines.get(world);
  if (!engine) {
    engine = createEngine(world);
    engines.set(world, engine);
  }
  return engine;
}

function createEngine(world: World): Engine {
  const planck = new PlanckWorld({ gravity: { x: 0, y: 0 }, allowSleep: false });
  const engine: Engine = { world: planck, bodies: new Map(), hits: new Map() };

  planck.on('pre-solve', (contact: Contact) => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    contact.setRestitution(mixRestitution(a.getRestitution(), b.getRestitution(), world.tuning));
    contact.setFriction(mixFriction(a.getFriction(), b.getFriction()));
  });

  planck.on('post-solve', (contact: Contact, impulse: ContactImpulse) => {
    recordHit(engine, contact, impulse);
  });

  return engine;
}

function recordHit(engine: Engine, contact: Contact, impulse: ContactImpulse): void {
  const count = contact.getManifold().pointCount;
  if (count === 0) return;

  let total = 0;
  for (let i = 0; i < count; i++) total += impulse.normalImpulses[i];
  if (total <= 0) return;

  const manifold = contact.getWorldManifold(null);
  if (!manifold) return;
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += manifold.points[i].x;
    y += manifold.points[i].y;
  }

  const idA = contact.getFixtureA().getUserData() as string;
  const idB = contact.getFixtureB().getUserData() as string;
  const [penA, penB] = idA < idB ? [idA, idB] : [idB, idA];
  const key = `${penA}|${penB}`;
  // Engine impulse is kg * engine-units/s; the game speaks kg * m/s.
  const strength = total / S;
  const tally = engine.hits.get(key) ?? { penA, penB, impulse: 0, px: 0, py: 0 };
  tally.impulse += strength;
  tally.px += (x / count / S) * strength;
  tally.py += (y / count / S) * strength;
  engine.hits.set(key, tally);
}

/**
 * Collision shapes for a pen, in engine units, around the middle of the barrel.
 *
 * A polygon for the barrel — pointed at the tip if the pen is — plus a circle
 * for each rounded end. Box2D gives every polygon a thin skin
 * (`Settings.polygonRadius`), so the polygon is drawn that much smaller to
 * keep the pen its real size.
 */
function penShapes(spec: PenSpec): Shape[] {
  const half = (spec.length / 2) * S;
  const radius = spec.radius * S;
  const skin = Settings.polygonRadius;
  const halfWidth = Math.max(radius - skin, radius * 0.5);

  const tailX = spec.tail === 'round' ? -half + radius : -half + skin;
  const shapes: Shape[] = [];

  if (spec.tip === 'pointed') {
    const taper = Math.min(radius * 3, half * 0.3);
    shapes.push(
      new Polygon([
        { x: tailX, y: -halfWidth },
        { x: half - taper, y: -halfWidth },
        { x: half - skin, y: 0 },
        { x: half - taper, y: halfWidth },
        { x: tailX, y: halfWidth },
      ]),
    );
  } else {
    const tipX = half - radius;
    shapes.push(
      new Polygon([
        { x: tailX, y: -halfWidth },
        { x: tipX, y: -halfWidth },
        { x: tipX, y: halfWidth },
        { x: tailX, y: halfWidth },
      ]),
      new Circle({ x: tipX, y: 0 }, radius),
    );
  }

  if (spec.tail === 'round') shapes.push(new Circle({ x: tailX, y: 0 }, radius));
  return shapes;
}

function createBody(engine: Engine, pen: Pen): BodyEntry {
  const spec = resolvePenSpec(pen.specId);
  const body = engine.world.createBody({
    type: 'dynamic',
    position: { x: pen.x * S, y: pen.y * S },
    angle: pen.angle,
    // Continuous collision against other moving pens, not just the static world.
    bullet: true,
    allowSleep: false,
    // Drag is applied by the friction model, so the engine adds none of its own.
    linearDamping: 0,
    angularDamping: 0,
    userData: pen.id,
  });

  for (const shape of penShapes(spec)) {
    body.createFixture(shape, {
      density: 1,
      friction: spec.contactFriction,
      restitution: spec.bounce,
      userData: pen.id,
    });
  }

  // Mass comes from the spec, not from the shapes' area. Box2D takes inertia
  // about the body origin (the middle of the barrel), hence the offset term.
  const com = pen.comOffset * S;
  body.setMassData({
    mass: pen.mass,
    center: { x: com, y: 0 },
    I: (pen.inertia + pen.mass * pen.comOffset * pen.comOffset) * S * S,
  });

  return { body, pen, x: pen.x, y: pen.y, angle: pen.angle };
}

/**
 * Bring the engine in line with the pens.
 *
 * Bodies are created for pens on the table and destroyed for pens that have
 * left it. A pen whose pose was edited from outside is moved to match.
 * Velocities are always copied in, because table friction has just changed
 * them.
 */
export function pushToEngine(world: World): void {
  const engine = engineFor(world);
  const live = new Set<string>();

  for (const pen of world.pens) {
    if (pen.state !== 'onTable') continue;
    live.add(pen.id);

    let entry = engine.bodies.get(pen.id);
    if (entry && entry.pen !== pen) {
      engine.world.destroyBody(entry.body);
      entry = undefined;
    }
    if (!entry) {
      entry = createBody(engine, pen);
      engine.bodies.set(pen.id, entry);
    } else if (pen.x !== entry.x || pen.y !== entry.y || pen.angle !== entry.angle) {
      entry.body.setTransform({ x: pen.x * S, y: pen.y * S }, pen.angle);
      entry.x = pen.x;
      entry.y = pen.y;
      entry.angle = pen.angle;
    }

    entry.body.setLinearVelocity({ x: pen.vx * S, y: pen.vy * S });
    entry.body.setAngularVelocity(pen.omega);
  }

  for (const [id, entry] of engine.bodies) {
    if (live.has(id)) continue;
    engine.world.destroyBody(entry.body);
    engine.bodies.delete(id);
  }
}

/** Advance the engine by `dt` seconds. */
export function stepEngine(world: World, dt: number): void {
  const { tuning } = world;
  engineFor(world).world.step(dt, tuning.velocityIterations, tuning.positionIterations);
}

/** Copy the engine's results back into the pens. */
export function pullFromEngine(world: World): void {
  const engine = engineFor(world);
  for (const entry of engine.bodies.values()) {
    const { body, pen } = entry;
    const position = body.getPosition();
    const velocity = body.getLinearVelocity();
    pen.x = position.x / S;
    pen.y = position.y / S;
    pen.angle = body.getAngle();
    pen.vx = velocity.x / S;
    pen.vy = velocity.y / S;
    pen.omega = body.getAngularVelocity();
    entry.x = pen.x;
    entry.y = pen.y;
    entry.angle = pen.angle;
  }
}

/**
 * Hits since the last call, one per pair of pens, strongest first.
 * Anything below `minImpulse` is two pens leaning on each other, not a hit.
 */
export function takeHits(world: World, minImpulse: number): CollisionEvent[] {
  const engine = engines.get(world);
  if (!engine || engine.hits.size === 0) return [];

  const events: CollisionEvent[] = [];
  for (const tally of engine.hits.values()) {
    if (tally.impulse < minImpulse) continue;
    events.push({
      penA: tally.penA,
      penB: tally.penB,
      point: { x: tally.px / tally.impulse, y: tally.py / tally.impulse },
      impulse: tally.impulse,
    });
  }
  engine.hits.clear();
  return events.sort((a, b) => b.impulse - a.impulse);
}

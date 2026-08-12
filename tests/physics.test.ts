import { describe, expect, it } from 'vitest';
import { findContact, resolveContact } from '../src/shared/physics/collision';
import { createPen, velocityAt } from '../src/shared/physics/pen';
import { DEFAULT_TABLE } from '../src/shared/physics/table';
import { DEFAULT_TUNING, tuningWith } from '../src/shared/physics/tuning';
import { vec } from '../src/shared/physics/vec2';
import {
  SIM_HZ,
  cloneWorld,
  createWorld,
  findPen,
  simulateUntilSettled,
  step,
} from '../src/shared/physics/world';
import { applyStrike, type Strike } from '../src/shared/game/strike';

const HALF = DEFAULT_TUNING.penLength / 2;

function worldWithOnePen(x = 0, y = 0, angle = 0) {
  return createWorld([{ id: 'p1', ownerId: 'a', x, y, angle }]);
}

function straightStrike(power: number, along = 0): Strike {
  return {
    penId: 'p1',
    contact: { along, across: 0 },
    direction: vec(1, 0),
    power,
  };
}

describe('striking a pen', () => {
  it('sends it straight when the flick goes through the centre of mass', () => {
    // Pen lies across the direction of travel, so any stray torque would show.
    const world = worldWithOnePen(0, 0, Math.PI / 2);
    applyStrike(world, straightStrike(1, 0));
    const pen = findPen(world, 'p1')!;

    expect(pen.vx).toBeGreaterThan(0);
    expect(pen.vy).toBeCloseTo(0, 10);
    expect(pen.omega).toBeCloseTo(0, 10);
  });

  it('spins it when the flick lands off centre', () => {
    const world = worldWithOnePen(0, 0, Math.PI / 2);
    applyStrike(world, straightStrike(1, 1));
    const pen = findPen(world, 'p1')!;

    expect(Math.abs(pen.omega)).toBeGreaterThan(5);
  });

  it('gives the same forward speed wherever it lands — only the spin changes', () => {
    const centred = worldWithOnePen(0, 0, Math.PI / 2);
    const offCentre = worldWithOnePen(0, 0, Math.PI / 2);
    applyStrike(centred, straightStrike(1, 0));
    applyStrike(offCentre, straightStrike(1, 0.9));

    expect(findPen(offCentre, 'p1')!.vx).toBeCloseTo(findPen(centred, 'p1')!.vx, 10);
    expect(Math.abs(findPen(offCentre, 'p1')!.omega)).toBeGreaterThan(
      Math.abs(findPen(centred, 'p1')!.omega),
    );
  });

  it('scales speed with power', () => {
    const soft = worldWithOnePen();
    const hard = worldWithOnePen();
    applyStrike(soft, straightStrike(0.25));
    applyStrike(hard, straightStrike(1));

    expect(findPen(hard, 'p1')!.vx).toBeCloseTo(findPen(soft, 'p1')!.vx * 4, 8);
  });
});

describe('table friction', () => {
  it('slows a sliding pen at roughly the coefficient times gravity', () => {
    // Pen pointing along its direction of travel: a clean one-dimensional case.
    // Started well back from the edge so it is still on the table throughout.
    const world = worldWithOnePen(-0.5, 0, 0);
    applyStrike(world, straightStrike(0.5));
    const pen = findPen(world, 'p1')!;
    const startSpeed = pen.vx;

    for (let frame = 0; frame < SIM_HZ / 4; frame++) step(world);

    expect(pen.state).toBe('onTable');
    const expectedDrop = DEFAULT_TUNING.tableFriction * DEFAULT_TUNING.gravity * 0.25;
    expect(startSpeed - pen.vx).toBeCloseTo(expectedDrop, 3);
  });

  it('brings every pen to a complete stop', () => {
    const world = worldWithOnePen(0, 0, 0.7);
    applyStrike(world, straightStrike(1, 0.8));
    simulateUntilSettled(world);

    const pen = findPen(world, 'p1')!;
    expect(pen.vx).toBe(0);
    expect(pen.vy).toBe(0);
    expect(pen.omega).toBe(0);
  });

  it('bleeds off spin as well as speed', () => {
    const world = worldWithOnePen(0, 0, 0);
    const pen = findPen(world, 'p1')!;
    pen.omega = 20;

    for (let frame = 0; frame < SIM_HZ / 2; frame++) step(world);
    expect(Math.abs(pen.omega)).toBeLessThan(20);
  });

  it('lets a spinning pen slide further, because grip is shared', () => {
    // The table can only supply so much friction. A pen spending some of it on
    // killing its spin has less left to kill its travel, so it goes further.
    // This is the coupling the per-sample friction model exists for, and it is
    // why a tip-flick is the long shot.
    const travelWithSpin = (omega: number) => {
      const world = worldWithOnePen(-0.6, 0, Math.PI / 2);
      applyStrike(world, straightStrike(0.5, 0));
      const pen = findPen(world, 'p1')!;
      pen.omega = omega;
      simulateUntilSettled(world);
      return pen.x - -0.6;
    };

    const flat = travelWithSpin(0);
    const spun = travelWithSpin(30);

    // A flat slide should match the textbook coasting distance, v^2 / 2*mu*g.
    const speed = (0.5 * DEFAULT_TUNING.maxStrikeImpulse) / DEFAULT_TUNING.penMass;
    const expected =
      (speed * speed) / (2 * DEFAULT_TUNING.tableFriction * DEFAULT_TUNING.gravity);
    expect(flat).toBeCloseTo(expected, 2);

    // Spin steals grip from the slide, so the same flick goes further.
    expect(spun).toBeGreaterThan(flat * 1.2);
  });
});

describe('pen against pen', () => {
  /** Two pens side by side, one moving into the other. No friction, so the sums are exact. */
  function headOnPair() {
    const tuning = tuningWith({ tableFriction: 0, penFriction: 0 });
    const world = createWorld(
      [
        // Just touching: the gap is under the two radii combined.
        { id: 'a', ownerId: 'a', x: -0.005, y: 0, angle: Math.PI / 2 },
        { id: 'b', ownerId: 'b', x: 0.005, y: 0, angle: Math.PI / 2 },
      ],
      DEFAULT_TABLE,
      tuning,
    );
    return world;
  }

  it('conserves linear momentum through a hit', () => {
    const world = headOnPair();
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.vx = 2;

    const before = a.mass * a.vx + b.mass * b.vx;
    const contact = findContact(a, b);
    expect(contact).not.toBeNull();
    resolveContact(contact!, world.tuning);

    expect(a.mass * a.vx + b.mass * b.vx).toBeCloseTo(before, 10);
  });

  it('passes the hit on: the struck pen moves, the striker slows', () => {
    const world = headOnPair();
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.vx = 2;

    resolveContact(findContact(a, b)!, world.tuning);

    expect(b.vx).toBeGreaterThan(0);
    expect(a.vx).toBeLessThan(2);
  });

  it('spins the struck pen when the hit lands off its centre', () => {
    const tuning = tuningWith({ tableFriction: 0, penFriction: 0 });
    const world = createWorld(
      [
        // Striker aimed at the far end of the target rather than its middle.
        { id: 'a', ownerId: 'a', x: -0.005, y: HALF * 1.4, angle: Math.PI / 2 },
        { id: 'b', ownerId: 'b', x: 0.005, y: 0, angle: Math.PI / 2 },
      ],
      DEFAULT_TABLE,
      tuning,
    );
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.vx = 2;

    resolveContact(findContact(a, b)!, world.tuning);
    expect(Math.abs(b.omega)).toBeGreaterThan(1);
  });

  it('does not push pens that are already moving apart', () => {
    const world = headOnPair();
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.vx = -1;
    b.vx = 1;

    const event = resolveContact(findContact(a, b)!, world.tuning);
    expect(event).toBeNull();
  });

  it('separates pens that have sunk into each other', () => {
    const world = headOnPair();
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    const gapBefore = Math.abs(b.x - a.x);

    resolveContact(findContact(a, b)!, world.tuning);
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(gapBefore);
  });

  it('never lets a fast pen pass straight through another', () => {
    const world = createWorld([
      { id: 'a', ownerId: 'a', x: -0.3, y: 0, angle: Math.PI / 2 },
      { id: 'b', ownerId: 'b', x: 0, y: 0, angle: Math.PI / 2 },
    ]);
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.vx = DEFAULT_TUNING.maxLinearVelocity;

    simulateUntilSettled(world);
    // If it had tunnelled, b would still be sitting untouched at the origin.
    expect(Math.abs(b.x)).toBeGreaterThan(0.01);
  });
});

describe('falling off the table', () => {
  it('drops a pen once its centre passes the edge, and takes it out of play', () => {
    const world = createWorld([
      { id: 'p1', ownerId: 'a', x: DEFAULT_TABLE.width / 2 - 0.05, y: 0, angle: 0 },
    ]);
    applyStrike(world, straightStrike(1));

    simulateUntilSettled(world);
    expect(findPen(world, 'p1')!.state).toBe('out');
  });

  it('leaves a pen in play when it only overhangs the edge', () => {
    const world = createWorld([
      // Sitting just inside, pointing outwards, so the tip hangs over.
      { id: 'p1', ownerId: 'a', x: DEFAULT_TABLE.width / 2 - 0.02, y: 0, angle: 0 },
    ]);
    simulateUntilSettled(world);
    expect(findPen(world, 'p1')!.state).toBe('onTable');
  });

  it('stops a fallen pen colliding with anything', () => {
    const world = createWorld([
      { id: 'a', ownerId: 'a', x: 0, y: 0, angle: 0 },
      { id: 'b', ownerId: 'b', x: 0.005, y: 0, angle: 0 },
    ]);
    const a = findPen(world, 'a')!;
    a.state = 'falling';
    expect(findContact(a, findPen(world, 'b')!)).toBeNull();
  });
});

describe('determinism', () => {
  it('replays a shot identically from the same starting state', () => {
    const build = () =>
      createWorld([
        { id: 'p1', ownerId: 'a', x: -0.35, y: 0.05, angle: 0.3 },
        { id: 'p2', ownerId: 'b', x: 0.1, y: -0.02, angle: 1.1 },
        { id: 'p3', ownerId: 'c', x: 0.3, y: 0.2, angle: 2.4 },
      ]);

    const strike: Strike = {
      penId: 'p1',
      contact: { along: 0.6, across: 0 },
      direction: vec(0.92, 0.38),
      power: 0.9,
    };

    const first = build();
    applyStrike(first, strike);
    simulateUntilSettled(first);

    const second = build();
    applyStrike(second, strike);
    simulateUntilSettled(second);

    for (const [index, pen] of first.pens.entries()) {
      expect(pen.x).toBe(second.pens[index].x);
      expect(pen.y).toBe(second.pens[index].y);
      expect(pen.angle).toBe(second.pens[index].angle);
      expect(pen.state).toBe(second.pens[index].state);
    }
  });

  it('carries on identically from a cloned world', () => {
    const world = createWorld([
      { id: 'p1', ownerId: 'a', x: -0.2, y: 0, angle: 0.4 },
      { id: 'p2', ownerId: 'b', x: 0.15, y: 0.03, angle: 1.9 },
    ]);
    applyStrike(world, { ...straightStrike(0.8, 0.4), penId: 'p1' });

    for (let frame = 0; frame < 10; frame++) step(world);
    const copy = cloneWorld(world);

    simulateUntilSettled(world);
    simulateUntilSettled(copy);

    for (const [index, pen] of world.pens.entries()) {
      expect(pen.x).toBe(copy.pens[index].x);
      expect(pen.y).toBe(copy.pens[index].y);
    }
  });
});

describe('velocity at a point', () => {
  it('adds the contribution of the spin', () => {
    const pen = createPen({ id: 'p', ownerId: 'a', x: 0, y: 0, angle: 0 }, DEFAULT_TUNING);
    pen.omega = 2;

    // A point out along +x on a body turning counter-clockwise moves in +y.
    const velocity = velocityAt(pen, vec(HALF, 0));
    expect(velocity.y).toBeCloseTo(2 * HALF, 10);
    expect(velocity.x).toBeCloseTo(0, 10);
  });
});

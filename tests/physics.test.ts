import { describe, expect, it } from 'vitest';
import { mixRestitution } from '../src/shared/physics/collision';
import { coastDistance, rollingRange } from '../src/shared/physics/friction';
import {
  createPen,
  localToWorld,
  penCentreOfMass,
  velocityAt,
  worldToLocal,
  type Pen,
} from '../src/shared/physics/pen';
import { resolvePenSpec } from '../src/shared/physics/pens/catalogue';
import { DEFAULT_TABLE } from '../src/shared/physics/table';
import { DEFAULT_TUNING } from '../src/shared/physics/tuning';
import { vec } from '../src/shared/physics/vec2';
import {
  SIM_HZ,
  cloneWorld,
  createWorld,
  findPen,
  simulateUntilSettled,
  step,
  type World,
} from '../src/shared/physics/world';
import { applyStrike, type Strike } from '../src/shared/game/strike';

const STANDARD = resolvePenSpec('standard');
const HALF = STANDARD.length / 2;
/** Big enough that nothing falls off, for measuring travel. */
const OPEN_TABLE = { width: 20, height: 20 };

function worldWithOnePen(x = 0, y = 0, angle = 0, specId = 'standard', table = DEFAULT_TABLE) {
  return createWorld([{ id: 'p1', ownerId: 'a', specId, x, y, angle }], table);
}

function strike(power: number, along = 0, direction = vec(1, 0)): Strike {
  return { penId: 'p1', contact: { along, across: 0 }, direction, power };
}

/** Strike coordinates of a pen's centre of mass. */
function balancePoint(pen: Pen) {
  return worldToLocal(pen, penCentreOfMass(pen));
}

const speedOf = (pen: Pen) => Math.hypot(pen.vx, pen.vy);

describe('striking a pen', () => {
  it('sends it straight when the flick goes through the centre of mass', () => {
    // Pen lies across the direction of travel, so any stray torque would show.
    const world = worldWithOnePen(0, 0, Math.PI / 2);
    const pen = findPen(world, 'p1')!;
    applyStrike(world, { ...strike(1), contact: balancePoint(pen) });

    expect(pen.vx).toBeGreaterThan(0);
    expect(pen.vy).toBeCloseTo(0, 10);
    expect(pen.omega).toBeCloseTo(0, 10);
  });

  it('leaves at finger speed when hit square through the centre of mass', () => {
    const world = worldWithOnePen(0, 0, Math.PI / 2);
    const pen = findPen(world, 'p1')!;
    applyStrike(world, { ...strike(1), contact: balancePoint(pen) });

    expect(speedOf(pen)).toBeCloseTo(DEFAULT_TUNING.maxFlickSpeed * STANDARD.flickPower, 6);
  });

  it('trades travel for spin when the flick lands near a tip', () => {
    const centred = worldWithOnePen(0, 0, Math.PI / 2);
    const atTip = worldWithOnePen(0, 0, Math.PI / 2);
    applyStrike(centred, strike(1, 0));
    applyStrike(atTip, strike(1, 1));

    const c = findPen(centred, 'p1')!;
    const t = findPen(atTip, 'p1')!;
    // At the tip the finger meets about a quarter of the pen's mass...
    expect(speedOf(t)).toBeLessThan(speedOf(c) * 0.35);
    // ...and most of the flick goes into turning it.
    expect(Math.abs(t.omega)).toBeGreaterThan(20);
    expect(Math.abs(t.omega)).toBeGreaterThan(Math.abs(c.omega) * 4);
  });

  it('brings the struck point up to finger speed', () => {
    const world = worldWithOnePen(0, 0, Math.PI / 2);
    const pen = findPen(world, 'p1')!;
    applyStrike(world, strike(0.7, 0.8));

    // The point under the finger moves at finger speed along the flick.
    const contact = localToWorld(pen, { along: 0.8, across: 0 });
    const fingerSpeed = DEFAULT_TUNING.maxFlickSpeed * 0.7 ** DEFAULT_TUNING.powerCurve;
    expect(velocityAt(pen, contact).x).toBeCloseTo(fingerSpeed, 6);
  });

  it('follows the power curve', () => {
    const soft = worldWithOnePen(0, 0, Math.PI / 2);
    const hard = worldWithOnePen(0, 0, Math.PI / 2);
    applyStrike(soft, strike(0.25));
    applyStrike(hard, strike(1));

    const ratio = speedOf(findPen(soft, 'p1')!) / speedOf(findPen(hard, 'p1')!);
    expect(ratio).toBeCloseTo(0.25 ** DEFAULT_TUNING.powerCurve, 8);
  });

  it('loses punch when pushed end-on, because the finger slides off the end', () => {
    const sideOn = worldWithOnePen(0, 0, Math.PI / 2);
    const endOn = worldWithOnePen(0, 0, 0);
    applyStrike(sideOn, strike(1));
    applyStrike(endOn, strike(1));

    const ratio = speedOf(findPen(endOn, 'p1')!) / speedOf(findPen(sideOn, 'p1')!);
    expect(ratio).toBeCloseTo(STANDARD.axialEfficiency, 2);
  });

  it('caps a heavy pen at what a finger can deliver', () => {
    const metal = worldWithOnePen(0, 0, Math.PI / 2, 'metal');
    const pen = findPen(metal, 'p1')!;
    applyStrike(metal, { ...strike(1), contact: balancePoint(pen) });

    expect(pen.mass * speedOf(pen)).toBeCloseTo(DEFAULT_TUNING.maxFlickImpulse, 8);
    expect(speedOf(pen)).toBeLessThan(DEFAULT_TUNING.maxFlickSpeed);
  });
});

describe('table friction', () => {
  it('coasts as far as the closed form says, for a pen rolling sideways', () => {
    const world = worldWithOnePen(0, 0, Math.PI / 2, 'standard', OPEN_TABLE);
    const pen = findPen(world, 'p1')!;
    pen.vx = 2;

    simulateUntilSettled(world);
    const expected = rollingRange(STANDARD, 2, DEFAULT_TUNING.gravity);
    expect(pen.x).toBeGreaterThan(expected * 0.97);
    expect(pen.x).toBeLessThan(expected * 1.03);
  });

  it('lets a pen roll sideways much further than it skids end-on', () => {
    const travel = (angle: number) => {
      const world = worldWithOnePen(0, 0, angle, 'standard', OPEN_TABLE);
      const pen = findPen(world, 'p1')!;
      pen.vx = 2;
      simulateUntilSettled(world);
      return pen.x;
    };

    expect(travel(Math.PI / 2)).toBeGreaterThan(travel(0) * 1.3);
  });

  it('brings every pen to a complete stop', () => {
    const world = worldWithOnePen(0, 0, 0.7);
    applyStrike(world, strike(1, 0.8));
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
    // Pointed along its travel, so turning cannot make it roll instead.
    const travelWithSpin = (omega: number) => {
      const world = worldWithOnePen(0, 0, 0, 'standard', OPEN_TABLE);
      const pen = findPen(world, 'p1')!;
      pen.vx = 1.5;
      pen.omega = omega;
      simulateUntilSettled(world);
      return Math.hypot(pen.x, pen.y);
    };

    expect(travelWithSpin(30)).toBeGreaterThan(travelWithSpin(0) * 1.15);
  });

  it('curves a lopsided pen that is sliding and spinning, towards its heavy end', () => {
    // The marker's heavy cap grips harder than its tip, so the pen is pulled
    // round as it goes. Spin the other way and it curves the other way.
    const drift = (omega: number) => {
      const world = worldWithOnePen(0, 0, 0, 'marker', OPEN_TABLE);
      const pen = findPen(world, 'p1')!;
      pen.vx = 1.5;
      pen.omega = omega;
      simulateUntilSettled(world);
      return pen.y;
    };

    // Small, as it is with a real pen, but always the same way round.
    const left = drift(25);
    const right = drift(-25);
    expect(Math.abs(left)).toBeGreaterThan(0.001);
    expect(Math.sign(left)).toBe(-Math.sign(right));
    expect(left).toBeCloseTo(-right, 6);
  });

  it('matches the textbook coasting distance in the limits', () => {
    expect(coastDistance(2, 4, 0)).toBeCloseTo(0.5, 10);
    expect(coastDistance(2, 0, 4)).toBeCloseTo(0.5, 10);
    expect(coastDistance(0, 1, 1)).toBe(0);
  });
});

describe('pen against pen', () => {
  /** Two pens lying parallel, `a` a little way left of `b`, `a` already moving. */
  function approach(specId = 'standard', speed = 2, offsetY = 0): World {
    const world = createWorld(
      [
        { id: 'a', ownerId: 'a', specId, x: -0.1, y: offsetY, angle: Math.PI / 2 },
        { id: 'b', ownerId: 'b', specId, x: 0, y: 0, angle: Math.PI / 2 },
      ],
      OPEN_TABLE,
    );
    findPen(world, 'a')!.vx = speed;
    return world;
  }

  /** Step until the first hit, and return the frame's result. */
  function runToHit(world: World) {
    for (let frame = 0; frame < SIM_HZ; frame++) {
      const result = step(world);
      if (result.collisions.length > 0) return result;
    }
    throw new Error('the pens never met');
  }

  it('passes the hit on: the struck pen leaves faster than the striker follows', () => {
    const world = approach();
    runToHit(world);
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;

    // Equal pens, bounce around 0.7: most of the speed is handed over.
    expect(b.vx).toBeGreaterThan(1.3);
    expect(Math.abs(a.vx)).toBeLessThan(0.4);
    expect(b.vx).toBeGreaterThan(a.vx * 3);
  });

  it('conserves momentum through the hit, give or take a frame of friction', () => {
    const world = approach();
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    const momentum = () => a.mass * a.vx + b.mass * b.vx;

    // Measure across the one frame the hit happens in.
    let before = momentum();
    for (let frame = 0; frame < SIM_HZ; frame++) {
      before = momentum();
      if (step(world).collisions.length > 0) break;
    }
    const after = momentum();

    expect(b.vx).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    // Only the table's drag over that frame is lost.
    expect(after).toBeGreaterThan(before * 0.95);
  });

  it('reports the hit where the barrels met, with its strength', () => {
    const result = runToHit(approach());
    const hit = result.collisions[0];

    expect(hit.penA).toBe('a');
    expect(hit.penB).toBe('b');
    expect(hit.point.x).toBeGreaterThan(-0.02);
    expect(hit.point.x).toBeLessThan(0.01);
    expect(hit.impulse).toBeGreaterThan(0.01);
  });

  it('spins the struck pen when the hit lands off its centre', () => {
    const world = approach('standard', 2, HALF * 1.2);
    runToHit(world);
    expect(Math.abs(findPen(world, 'b')!.omega)).toBeGreaterThan(5);
  });

  it('hits a parallel pen square, without inventing spin', () => {
    // Barrels meeting along their whole length touch at two points; a single
    // arbitrary contact point would twist them.
    const world = createWorld(
      [
        { id: 'a', ownerId: 'a', specId: 'marker', x: -0.1, y: 0.006, angle: Math.PI / 2 },
        { id: 'b', ownerId: 'b', specId: 'marker', x: 0, y: 0.006, angle: Math.PI / 2 },
      ],
      OPEN_TABLE,
    );
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    // Both centred so their centres of mass line up exactly.
    a.vx = 2;
    runToHit(world);
    expect(Math.abs(b.omega)).toBeLessThan(0.5);
  });

  it('mixes bounciness from both pens', () => {
    const lively = mixRestitution(0.4, 0.4, DEFAULT_TUNING);
    const dead = mixRestitution(0.25, 0.25, DEFAULT_TUNING);
    expect(mixRestitution(0.4, 0.25, DEFAULT_TUNING)).toBeCloseTo((lively + dead) / 2, 10);
    expect(lively).toBeLessThanOrEqual(DEFAULT_TUNING.maxRestitution);

    // And it shows: two metal pens bounce apart harder than two markers.
    const rebound = (specId: string) => {
      const world = approach(specId);
      runToHit(world);
      return findPen(world, 'b')!.vx - findPen(world, 'a')!.vx;
    };
    expect(rebound('metal')).toBeGreaterThan(rebound('marker'));
  });

  it('never lets a fast pen pass straight through another', () => {
    const world = createWorld(
      [
        { id: 'a', ownerId: 'a', x: -0.3, y: 0, angle: Math.PI / 2 },
        { id: 'b', ownerId: 'b', x: 0, y: 0, angle: Math.PI / 2 },
      ],
      OPEN_TABLE,
    );
    // Far faster than any flick: one frame is 25 cm of travel, past the
    // target's whole thickness many times over.
    findPen(world, 'a')!.vx = 15;

    simulateUntilSettled(world);
    expect(findPen(world, 'a')!.x).toBeLessThan(findPen(world, 'b')!.x);
    expect(findPen(world, 'b')!.x).toBeGreaterThan(0.05);
  });

  it('never leaves two pens sunk into each other', () => {
    const world = createWorld([
      // Placed overlapping, as a bad respawn might.
      { id: 'a', ownerId: 'a', x: 0, y: 0, angle: 0 },
      { id: 'b', ownerId: 'b', x: 0.004, y: 0.004, angle: 0 },
    ]);
    for (let frame = 0; frame < SIM_HZ; frame++) step(world);

    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    expect(Math.abs(b.y - a.y)).toBeGreaterThan(a.radius + b.radius - 0.001);
  });
});

describe('falling off the table', () => {
  it('drops a pen once its centre of mass passes the edge, and takes it out of play', () => {
    const world = worldWithOnePen(DEFAULT_TABLE.width / 2 - 0.05, 0, Math.PI / 2);
    applyStrike(world, strike(1));

    simulateUntilSettled(world);
    expect(findPen(world, 'p1')!.state).toBe('out');
  });

  it('leaves a pen in play when it only overhangs the edge', () => {
    // Sitting just inside, pointing outwards, so the tip hangs over.
    const world = worldWithOnePen(DEFAULT_TABLE.width / 2 - 0.02, 0, 0);
    simulateUntilSettled(world);
    expect(findPen(world, 'p1')!.state).toBe('onTable');
  });

  it('lets a heavy-capped pen hang its middle over the edge', () => {
    // The marker's balance point is towards its cap, so with the cap inboard
    // the middle of the barrel can be past the edge without it falling.
    const world = worldWithOnePen(DEFAULT_TABLE.width / 2 + 0.003, 0, 0, 'marker');
    simulateUntilSettled(world);
    expect(findPen(world, 'p1')!.state).toBe('onTable');
  });

  it('stops a falling pen colliding with anything', () => {
    const world = createWorld([
      { id: 'a', ownerId: 'a', x: 0, y: 0, angle: 0 },
      { id: 'b', ownerId: 'b', x: 0.005, y: 0, angle: 0 },
    ]);
    const a = findPen(world, 'a')!;
    const b = findPen(world, 'b')!;
    a.state = 'falling';
    a.vx = 1;

    step(world);
    expect(b.x).toBe(0.005);
    expect(b.vx).toBe(0);
  });
});

describe('the engine follows the plain pen data', () => {
  it('honours a pen moved from outside between steps', () => {
    const world = worldWithOnePen(0, 0, 0);
    step(world);
    const pen = findPen(world, 'p1')!;
    pen.x = 0.3;
    pen.angle = 1;

    step(world);
    expect(pen.x).toBe(0.3);
    expect(pen.angle).toBe(1);
  });

  it('honours pens replaced wholesale, as a server snapshot does', () => {
    const world = worldWithOnePen(0, 0, 0);
    step(world);
    world.pens = [createPen({ id: 'p1', ownerId: 'a', x: -0.2, y: 0.1, angle: 0 })];

    step(world);
    expect(world.pens[0].x).toBe(-0.2);
    expect(world.pens[0].y).toBe(0.1);
  });
});

describe('determinism', () => {
  const build = () =>
    createWorld([
      { id: 'p1', ownerId: 'a', x: -0.35, y: 0.05, angle: 0.3 },
      { id: 'p2', ownerId: 'b', specId: 'metal', x: 0.1, y: -0.02, angle: 1.1 },
      { id: 'p3', ownerId: 'c', specId: 'marker', x: 0.3, y: 0.2, angle: 2.4 },
    ]);

  const shot: Strike = {
    penId: 'p1',
    contact: { along: 0.6, across: 0 },
    direction: vec(0.92, 0.38),
    power: 0.9,
  };

  const expectSame = (a: World, b: World) => {
    for (const [index, pen] of a.pens.entries()) {
      expect(pen.x).toBe(b.pens[index].x);
      expect(pen.y).toBe(b.pens[index].y);
      expect(pen.angle).toBe(b.pens[index].angle);
      expect(pen.state).toBe(b.pens[index].state);
    }
  };

  it('replays a shot identically from the same starting state', () => {
    const first = build();
    applyStrike(first, shot);
    simulateUntilSettled(first);

    const second = build();
    applyStrike(second, shot);
    simulateUntilSettled(second);

    expectSame(first, second);
  });

  it('plays a shot identically on a clone, which is what bots rely on', () => {
    const world = build();
    // A previous shot, so the original's engine has history the clone lacks.
    applyStrike(world, { ...shot, penId: 'p2', direction: vec(-1, 0), power: 0.3 });
    simulateUntilSettled(world);

    const copy = cloneWorld(world);
    applyStrike(world, shot);
    applyStrike(copy, shot);
    simulateUntilSettled(world);
    simulateUntilSettled(copy);

    expectSame(world, copy);
  });
});

describe('velocity at a point', () => {
  it('adds the contribution of the spin, about the centre of mass', () => {
    const pen = createPen({ id: 'p', ownerId: 'a', x: 0, y: 0, angle: 0 });
    pen.omega = 2;

    // A point out along +x on a body turning counter-clockwise moves in +y.
    const velocity = velocityAt(pen, vec(HALF, 0));
    expect(velocity.y).toBeCloseTo(2 * (HALF - pen.comOffset), 10);
    expect(velocity.x).toBeCloseTo(0, 10);
  });
});

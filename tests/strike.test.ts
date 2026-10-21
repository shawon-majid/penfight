import { describe, expect, it } from 'vitest';
import { createPen, penCentreOfMass, worldToLocal } from '../src/shared/physics/pen';
import { resolvePenSpec } from '../src/shared/physics/pens/catalogue';
import { DEFAULT_TUNING } from '../src/shared/physics/tuning';
import { vec } from '../src/shared/physics/vec2';
import { createWorld, findPen } from '../src/shared/physics/world';
import {
  applyStrike,
  checkStrike,
  previewStrike,
  sanitiseStrike,
  strikeFromDrag,
} from '../src/shared/game/strike';

const pen = () => createPen({ id: 'p', ownerId: 'me', x: 0, y: 0, angle: 0 });
/** The spot on the pen that is its centre of mass, in strike coordinates. */
const atBalance = () => worldToLocal(pen(), penCentreOfMass(pen()));

describe('strikeFromDrag', () => {
  it('sends the pen away from the direction of the pull', () => {
    // Grabbed at the origin, dragged to the right: the pen should go left.
    const strike = strikeFromDrag(pen(), vec(0, 0), vec(0.1, 0), DEFAULT_TUNING);
    expect(strike).not.toBeNull();
    expect(strike!.direction.x).toBeCloseTo(-1, 10);
    expect(strike!.direction.y).toBeCloseTo(0, 10);
  });

  it('reads power from how far the pull went', () => {
    const half = strikeFromDrag(
      pen(),
      vec(0, 0),
      vec(DEFAULT_TUNING.fullPowerDragDistance / 2, 0),
      DEFAULT_TUNING,
    );
    expect(half!.power).toBeCloseTo(0.5, 10);
  });

  it('caps power at a full pull, however far the pointer goes', () => {
    const overdrawn = strikeFromDrag(pen(), vec(0, 0), vec(10, 0), DEFAULT_TUNING);
    expect(overdrawn!.power).toBe(1);
  });

  it('records where along the pen the grab landed', () => {
    const atTip = strikeFromDrag(
      pen(),
      vec(resolvePenSpec(undefined).length / 2, 0),
      vec(0.1, 0),
      DEFAULT_TUNING,
    );
    expect(atTip!.contact.along).toBeCloseTo(1, 6);
  });

  it('ignores a drag of no length', () => {
    expect(strikeFromDrag(pen(), vec(0, 0), vec(0, 0), DEFAULT_TUNING)).toBeNull();
  });
});

describe('sanitiseStrike', () => {
  it('clamps everything a client could exaggerate', () => {
    const clean = sanitiseStrike({
      penId: 'p',
      contact: { along: 99, across: -99 },
      direction: vec(10, 0),
      power: 500,
    });

    expect(clean.contact.along).toBe(1);
    expect(clean.contact.across).toBe(-1);
    expect(clean.power).toBe(1);
    expect(Math.hypot(clean.direction.x, clean.direction.y)).toBeCloseTo(1, 10);
  });
});

describe('checkStrike', () => {
  const world = () =>
    createWorld([
      { id: 'mine', ownerId: 'me', x: 0, y: 0, angle: 0 },
      { id: 'theirs', ownerId: 'them', x: 0.4, y: 0, angle: 0 },
    ]);

  const shot = (penId: string) => ({
    penId,
    contact: { along: 0, across: 0 },
    direction: vec(1, 0),
    power: 0.5,
  });

  it('allows a player to strike their own pen', () => {
    expect(checkStrike(world(), 'me', shot('mine'))).toEqual({ ok: true });
  });

  it('refuses to let a player strike somebody else’s pen', () => {
    expect(checkStrike(world(), 'me', shot('theirs'))).toEqual({
      ok: false,
      reason: 'not-your-pen',
    });
  });

  it('refuses a pen that has already fallen', () => {
    const w = world();
    findPen(w, 'mine')!.state = 'out';
    expect(checkStrike(w, 'me', shot('mine'))).toEqual({
      ok: false,
      reason: 'pen-not-in-play',
    });
  });

  it('refuses a shot with no power behind it', () => {
    expect(checkStrike(world(), 'me', { ...shot('mine'), power: 0 })).toEqual({
      ok: false,
      reason: 'no-power',
    });
  });

  it('refuses a shot with no direction', () => {
    expect(checkStrike(world(), 'me', { ...shot('mine'), direction: vec(0, 0) })).toEqual({
      ok: false,
      reason: 'no-direction',
    });
  });
});

describe('previewStrike', () => {
  it('reports no spin for a flick through the centre of mass', () => {
    const preview = previewStrike(
      pen(),
      { penId: 'p', contact: atBalance(), direction: vec(0, 1), power: 1 },
      DEFAULT_TUNING,
    );
    expect(preview.spinShare).toBeCloseTo(0, 10);
  });

  it('reports heavy spin for a flick square on to the tip', () => {
    const preview = previewStrike(
      pen(),
      { penId: 'p', contact: { along: 1, across: 0 }, direction: vec(0, 1), power: 1 },
      DEFAULT_TUNING,
    );
    expect(preview.spinShare).toBeGreaterThan(0.9);
  });

  it('agrees with what the pen actually does', () => {
    const strike = { penId: 'p', contact: { along: 0.6, across: 0 }, direction: vec(0.6, 0.8), power: 0.5 };
    const preview = previewStrike(pen(), strike, DEFAULT_TUNING);

    const world = createWorld([{ id: 'p', ownerId: 'me', x: 0, y: 0, angle: 0 }]);
    applyStrike(world, strike);
    const struck = findPen(world, 'p')!;

    expect(preview.speed).toBeCloseTo(Math.hypot(struck.vx, struck.vy), 10);
    expect(preview.spin).toBeCloseTo(struck.omega, 10);
  });
});

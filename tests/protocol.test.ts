import { describe, expect, it } from 'vitest';
import { vec } from '../src/shared/physics/vec2';
import { findPen } from '../src/shared/physics/world';
import { createMatch, penIdFor, stepMatch, submitStrike } from '../src/shared/game/match';
import { generateCode, normaliseCode } from '../src/shared/game/codes';
import { createRng } from '../src/shared/game/rng';
import {
  applySnapshot,
  decodeClientMessage,
  encode,
  restoreMatch,
  snapshotMatch,
} from '../src/shared/net/protocol';

function midShotMatch() {
  const match = createMatch('TEST1', [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Ben' },
    { id: 'c', name: 'Cat' },
  ]);
  submitStrike(match, 'a', {
    penId: penIdFor('a'),
    contact: { along: 0.5, across: 0 },
    direction: vec(1, 0.2),
    power: 0.7,
  });
  for (let frame = 0; frame < 12; frame++) stepMatch(match);
  return match;
}

describe('snapshots', () => {
  it('survives a round trip through JSON with the state intact', () => {
    const match = midShotMatch();
    const wire = JSON.parse(JSON.stringify(snapshotMatch(match, 1234)));
    const restored = restoreMatch(wire);

    expect(restored.phase).toBe(match.phase);
    expect(restored.turnIndex).toBe(match.turnIndex);
    expect(restored.turnNumber).toBe(match.turnNumber);
    expect(restored.players).toEqual(match.players);

    for (const [index, pen] of match.world.pens.entries()) {
      const copy = restored.world.pens[index];
      expect(copy.x).toBe(pen.x);
      expect(copy.y).toBe(pen.y);
      expect(copy.angle).toBe(pen.angle);
      expect(copy.vx).toBe(pen.vx);
      expect(copy.omega).toBe(pen.omega);
      expect(copy.state).toBe(pen.state);
    }
  });

  it('rebuilds mass and inertia rather than trusting the wire', () => {
    const match = midShotMatch();
    const restored = restoreMatch(snapshotMatch(match));
    const original = match.world.pens[0];
    const copy = restored.world.pens[0];

    expect(copy.mass).toBe(original.mass);
    expect(copy.inertia).toBe(original.inertia);
    expect(copy.invInertia).toBe(original.invInertia);
  });

  it('carries on identically from a restored snapshot', () => {
    const match = midShotMatch();
    const restored = restoreMatch(snapshotMatch(match));
    restored.phase = 'resolving';

    for (let frame = 0; frame < 90; frame++) {
      stepMatch(match);
      stepMatch(restored);
    }

    for (const [index, pen] of match.world.pens.entries()) {
      expect(restored.world.pens[index].x).toBeCloseTo(pen.x, 9);
      expect(restored.world.pens[index].y).toBeCloseTo(pen.y, 9);
    }
  });

  it('overwrites a live match when the server disagrees', () => {
    const truth = midShotMatch();
    const drifted = createMatch('TEST1', [
      { id: 'a', name: 'Ann' },
      { id: 'b', name: 'Ben' },
      { id: 'c', name: 'Cat' },
    ]);
    findPen(drifted.world, penIdFor('a'))!.x = 99;

    applySnapshot(drifted, snapshotMatch(truth));

    expect(findPen(drifted.world, penIdFor('a'))!.x).toBe(
      findPen(truth.world, penIdFor('a'))!.x,
    );
    expect(drifted.turnNumber).toBe(truth.turnNumber);
  });
});

describe('message decoding', () => {
  it('reads back what it wrote', () => {
    const message = { type: 'strike' as const, strike: {
      penId: 'pen:a',
      contact: { along: 0.2, across: 0 },
      direction: vec(1, 0),
      power: 0.4,
    } };
    expect(decodeClientMessage(encode(message))).toEqual(message);
  });

  it('rejects rubbish instead of throwing', () => {
    expect(decodeClientMessage('not json at all')).toBeNull();
    expect(decodeClientMessage('42')).toBeNull();
    expect(decodeClientMessage('{"nope":true}')).toBeNull();
  });
});

describe('table codes', () => {
  it('makes codes of the right shape', () => {
    const rng = createRng(9);
    const code = generateCode((max) => Math.floor(rng.next() * max));
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    expect(normaliseCode(code)).toBe(code);
  });

  it('accepts a code however it was typed', () => {
    expect(normaliseCode(' 7qk2p ')).toBe('7QK2P');
    expect(normaliseCode('7QK-2P')).toBe('7QK2P');
  });

  it('turns down anything that could not be a code', () => {
    expect(normaliseCode('abc')).toBeNull();
    expect(normaliseCode('TOOLONGCODE')).toBeNull();
    // O, I and S are left out on purpose — they get misread aloud.
    expect(normaliseCode('QRSTU')).toBeNull();
  });
});

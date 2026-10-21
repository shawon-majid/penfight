import { describe, expect, it } from 'vitest';
import { createPen, penCentreOfMass } from '../src/shared/physics/pen';
import {
  DEFAULT_PEN_SPEC_ID,
  PEN_CATALOGUE,
  isPenSpecId,
  resolvePenSpec,
} from '../src/shared/physics/pens/catalogue';
import { inertiaOf, loadShares, samplePositions, validateSpec } from '../src/shared/physics/pens/spec';

/**
 * The pen catalogue. Every entry is checked here, so adding a pen with a typo
 * in it fails the build rather than a match. How far each pen can reach is
 * checked in `balance.test.ts`.
 */

describe('the catalogue', () => {
  it('has a valid spec for every pen', () => {
    for (const spec of PEN_CATALOGUE) expect(validateSpec(spec)).toEqual([]);
  });

  it('gives every pen its own id', () => {
    const ids = PEN_CATALOGUE.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains the default pen', () => {
    expect(isPenSpecId(DEFAULT_PEN_SPEC_ID)).toBe(true);
  });

  it('falls back to the default for an unknown pen', () => {
    expect(resolvePenSpec('a-pen-that-never-was').id).toBe(DEFAULT_PEN_SPEC_ID);
    expect(resolvePenSpec(undefined).id).toBe(DEFAULT_PEN_SPEC_ID);
    expect(isPenSpecId('a-pen-that-never-was')).toBe(false);
    expect(isPenSpecId(42)).toBe(false);
  });

  it('builds pens from their spec', () => {
    for (const spec of PEN_CATALOGUE) {
      const pen = createPen({ id: 'p', ownerId: 'a', specId: spec.id, x: 0, y: 0, angle: 0 });
      expect(pen.specId).toBe(spec.id);
      expect(pen.mass).toBe(spec.mass);
      expect(pen.length).toBe(spec.length);
      expect(pen.inertia).toBe(inertiaOf(spec));
      expect(penCentreOfMass(pen).x).toBeCloseTo(spec.comOffset, 12);
    }
  });
});

describe('derived mass properties', () => {
  it('works out inertia from the shape, never by hand', () => {
    const spec = resolvePenSpec('standard');
    const width = spec.radius * 2;
    expect(inertiaOf(spec)).toBeCloseTo((spec.mass * (spec.length ** 2 + width ** 2)) / 12, 15);
  });

  it('shares the weight so it balances on the centre of mass', () => {
    for (const spec of PEN_CATALOGUE) {
      const shares = loadShares(spec, 8);
      const positions = samplePositions(spec, 8);
      const total = shares.reduce((sum, share) => sum + share, 0);
      const balance = shares.reduce((sum, share, i) => sum + share * positions[i], 0);

      expect(total).toBeCloseTo(1, 12);
      expect(balance).toBeCloseTo(spec.comOffset, 12);
      for (const share of shares) expect(share).toBeGreaterThan(0);
    }
  });
});

describe('validateSpec', () => {
  const good = resolvePenSpec('standard');

  it('catches a pen nobody could have meant', () => {
    expect(validateSpec({ ...good, mass: 0 })).not.toEqual([]);
    expect(validateSpec({ ...good, mass: Number.NaN })).not.toEqual([]);
    expect(validateSpec({ ...good, length: 2 })).not.toEqual([]);
    expect(validateSpec({ ...good, rollFactor: 1.5 })).not.toEqual([]);
    expect(validateSpec({ ...good, bounce: -0.1 })).not.toEqual([]);
    expect(validateSpec({ ...good, axialEfficiency: 0 })).not.toEqual([]);
  });

  it('refuses a centre of mass so far off that the light end would float', () => {
    expect(validateSpec({ ...good, comOffset: good.length / 4 })).not.toEqual([]);
  });

  it('names the pen and the problem', () => {
    const [problem] = validateSpec({ ...good, id: 'wobbly', bounce: 3 });
    expect(problem).toContain('wobbly');
    expect(problem).toContain('bounce');
  });
});

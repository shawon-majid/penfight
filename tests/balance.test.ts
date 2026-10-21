import { describe, expect, it } from 'vitest';
import { chooseBotStrike } from '../src/shared/game/bots';
import { createMatch, stepMatch, submitStrike, type Match } from '../src/shared/game/match';
import { createRng } from '../src/shared/game/rng';
import { DEFAULT_TABLE } from '../src/shared/physics/table';
import { DEFAULT_TUNING, tuningWith } from '../src/shared/physics/tuning';
import { penCentreOfMass, worldToLocal } from '../src/shared/physics/pen';
import { PEN_CATALOGUE } from '../src/shared/physics/pens/catalogue';
import { vec } from '../src/shared/physics/vec2';
import { createWorld, findPen, simulateUntilSettled } from '../src/shared/physics/world';
import { applyStrike } from '../src/shared/game/strike';

/**
 * Balance, measured rather than guessed.
 *
 * Tuning numbers are easy to argue about and easy to check: play a few hundred
 * bot matches and look at how long they last. A game that ends in two turns is
 * not a game, and one that never ends is worse.
 *
 * These run the real solver, so they double as a soak test — several hundred
 * shots through the physics with no wedged tables and no matches that fail to
 * finish.
 */

const TURN_CAP = 200;

function playMatch(seed: number, playerCount: number): { turns: number; winner: string | null } {
  const match: Match = createMatch(
    'BENCH',
    Array.from({ length: playerCount }, (_, i) => ({
      id: `p${i}`,
      name: `Player ${i}`,
      isBot: true,
    })),
    DEFAULT_TABLE,
    DEFAULT_TUNING,
  );
  const rng = createRng(seed);

  for (let turn = 0; turn < TURN_CAP; turn++) {
    if (match.phase === 'finished') break;

    const player = match.players[match.turnIndex];
    const decision = chooseBotStrike(match, player.id, rng, 'normal');
    if (!decision) break;

    submitStrike(match, player.id, decision.strike);
    for (let frame = 0; frame < 60 * 20; frame++) {
      if (stepMatch(match).settled) break;
    }
  }

  return { turns: match.turnNumber, winner: match.winnerId };
}

describe('match length', () => {
  it('gives four-player games enough turns to be a game', () => {
    const lengths: number[] = [];
    let draws = 0;

    for (let seed = 1; seed <= 24; seed++) {
      const { turns, winner } = playMatch(seed, 4);
      lengths.push(turns);
      if (winner === null) draws++;
    }

    const average = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
    // eslint-disable-next-line no-console
    console.log(
      `4-player bot matches: average ${average.toFixed(1)} turns ` +
        `(min ${Math.min(...lengths)}, max ${Math.max(...lengths)}), ${draws} draws`,
    );

    // Long enough that position and aim matter, short enough to stay tense.
    expect(average).toBeGreaterThan(4);
    expect(average).toBeLessThan(40);
    // Everybody falling off together should be the exception, not the norm.
    expect(draws / lengths.length).toBeLessThan(0.35);
  });

  it('always reaches a conclusion, and never wedges the table', () => {
    for (let seed = 100; seed <= 110; seed++) {
      const { turns } = playMatch(seed, 4);
      expect(turns).toBeLessThan(TURN_CAP);
    }
  });

  it('keeps a full ten-pen table playable', () => {
    const { turns, winner } = playMatch(7, 10);
    expect(turns).toBeGreaterThan(4);
    expect(turns).toBeLessThan(TURN_CAP);
    expect(winner === null || typeof winner === 'string').toBe(true);
  });
});

/**
 * How far one flick goes, checked for every pen in the catalogue, by running
 * the real solver. A new pen that is too strong or too weak fails here.
 */
describe('shot range, for every pen', () => {
  /** Distance a pen travels from the middle of a table too big to fall off. */
  function flickRange(specId: string, power: number, direction = vec(1, 0)): number {
    const world = createWorld(
      [{ id: 'p', ownerId: 'a', specId, x: 0, y: 0, angle: Math.PI / 2 }],
      { width: 20, height: 20 },
    );
    const pen = findPen(world, 'p')!;
    applyStrike(world, {
      penId: 'p',
      contact: worldToLocal(pen, penCentreOfMass(pen)),
      direction,
      power,
    });
    simulateUntilSettled(world);
    return Math.hypot(pen.x, pen.y);
  }

  for (const spec of PEN_CATALOGUE) {
    describe(spec.name, () => {
      it('carries itself off the table on a full-power miss from the middle', () => {
        const range = flickRange(spec.id, 1);
        // Past the nearest edge...
        expect(range).toBeGreaterThan(DEFAULT_TABLE.height / 2);
        // ...but not clean across the long side, or every shot would be suicide.
        expect(range).toBeLessThan(DEFAULT_TABLE.width * 0.9);
      });

      it('still makes a real shot at half power', () => {
        expect(flickRange(spec.id, 0.5)).toBeGreaterThan(spec.length * 2);
      });

      it('rolls further side-on than it skids end-on', () => {
        // The pen lies along y, so a flick along y pushes it end-on.
        expect(flickRange(spec.id, 1)).toBeGreaterThan(flickRange(spec.id, 1, vec(0, 1)) * 1.5);
      });
    });
  }

  /** How far `target` ends up after `striker` hits it square from 25 cm away. */
  function hitTravel(strikerId: string, targetId: string, power: number): number {
    const world = createWorld(
      [
        { id: 's', ownerId: 's', specId: strikerId, x: -0.25, y: 0, angle: Math.PI / 2 },
        { id: 't', ownerId: 't', specId: targetId, x: 0, y: 0, angle: Math.PI / 2 },
      ],
      { width: 20, height: 20 },
    );
    const pen = findPen(world, 's')!;
    applyStrike(world, {
      penId: 's',
      contact: worldToLocal(pen, penCentreOfMass(pen)),
      direction: vec(1, 0),
      power,
    });
    simulateUntilSettled(world);
    return findPen(world, 't')!.x;
  }

  it('never kills from the middle with a half-power hit, whatever the pens', () => {
    // A perfect full-power hit can knock a pen off from anywhere, as in a real
    // pen fight. A moderate one cannot: you have to work somebody outwards.
    for (const striker of PEN_CATALOGUE) {
      for (const target of PEN_CATALOGUE) {
        expect(hitTravel(striker.id, target.id, 0.5), `${striker.id} into ${target.id}`).toBeLessThan(
          DEFAULT_TABLE.height / 2,
        );
      }
    }
  });

  it('never sends the target further than the striker would have gone alone', () => {
    // A hit can only hand on energy it had. If a target ever out-travelled the
    // striker's own free shot, the solver would be inventing energy.
    for (const striker of PEN_CATALOGUE) {
      const alone = flickRange(striker.id, 1);
      for (const target of PEN_CATALOGUE) {
        expect(hitTravel(striker.id, target.id, 1), `${striker.id} into ${target.id}`).toBeLessThan(
          alone,
        );
      }
    }
  });
});

describe('tuning overrides', () => {
  it('changes only what was asked for', () => {
    const gentle = tuningWith({ maxFlickSpeed: 1 });
    expect(gentle.maxFlickSpeed).toBe(1);
    expect(gentle.gravity).toBe(DEFAULT_TUNING.gravity);
  });
});

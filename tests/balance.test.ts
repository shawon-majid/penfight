import { describe, expect, it } from 'vitest';
import { chooseBotStrike } from '../src/shared/game/bots';
import { createMatch, stepMatch, submitStrike, type Match } from '../src/shared/game/match';
import { createRng } from '../src/shared/game/rng';
import { DEFAULT_TABLE } from '../src/shared/physics/table';
import { DEFAULT_TUNING, tuningWith } from '../src/shared/physics/tuning';

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

describe('shot range', () => {
  /** Distance a pen coasts to a stop from `speed`. */
  const coastingRange = (speed: number) =>
    (speed * speed) / (2 * DEFAULT_TUNING.tableFriction * DEFAULT_TUNING.gravity);

  const fullPowerSpeed = DEFAULT_TUNING.maxStrikeImpulse / DEFAULT_TUNING.penMass;

  it('carries your own pen off the table if a full-power shot misses', () => {
    // Measured from the middle, so half a table in any direction is the edge.
    const range = coastingRange(fullPowerSpeed);
    expect(range).toBeGreaterThan(DEFAULT_TABLE.width / 2);

    // But not so far that you can cross the whole table in one — that would
    // make every shot from your own edge suicide, and stall the game.
    expect(range / DEFAULT_TABLE.width).toBeLessThan(1.1);
  });

  it('cannot kill from anywhere: a square hit carries the target about half the table', () => {
    // A square hit between equal masses hands over (1 + restitution) / 2 of
    // the striker's speed.
    const handover = (1 + DEFAULT_TUNING.penRestitution) / 2;
    const targetRange = coastingRange(fullPowerSpeed * handover);

    // Less than centre-to-edge, so a pen in the middle survives a full hit and
    // has to be worked outwards first.
    expect(targetRange).toBeLessThan(DEFAULT_TABLE.width / 2);
    // Still a real shove — more than five pen lengths.
    expect(targetRange).toBeGreaterThan(DEFAULT_TUNING.penLength * 5);
  });

  it('is stated in the tuning as a real, checkable relationship', () => {
    // Guard against someone "just nudging" one number in isolation.
    const halfPowerRange =
      (0.5 * DEFAULT_TUNING.maxStrikeImpulse / DEFAULT_TUNING.penMass) ** 2 /
      (2 * DEFAULT_TUNING.tableFriction * DEFAULT_TUNING.gravity);
    expect(halfPowerRange).toBeGreaterThan(DEFAULT_TUNING.penLength * 2);
  });
});

describe('tuning overrides', () => {
  it('changes only what was asked for', () => {
    const slippery = tuningWith({ tableFriction: 0.05 });
    expect(slippery.tableFriction).toBe(0.05);
    expect(slippery.penMass).toBe(DEFAULT_TUNING.penMass);
  });
});

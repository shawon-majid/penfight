import { describe, expect, it } from 'vitest';
import { vec } from '../src/shared/physics/vec2';
import { findPen } from '../src/shared/physics/world';
import {
  createMatch,
  currentPlayer,
  penIdFor,
  setConnected,
  skipTurn,
  stepMatch,
  submitStrike,
} from '../src/shared/game/match';
import type { Strike } from '../src/shared/game/strike';

function fourPlayerMatch() {
  return createMatch('TEST1', [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Ben' },
    { id: 'c', name: 'Cat' },
    { id: 'd', name: 'Dev' },
  ]);
}

const gentle = (playerId: string): Strike => ({
  penId: penIdFor(playerId),
  contact: { along: 0, across: 0 },
  direction: vec(1, 0),
  power: 0.15,
});

/** Play a shot right through to the table settling. */
function playShot(match: ReturnType<typeof fourPlayerMatch>, playerId: string, strike?: Strike) {
  const result = submitStrike(match, playerId, strike ?? gentle(playerId));
  expect(result.ok).toBe(true);
  for (let frame = 0; frame < 60 * 20; frame++) {
    if (stepMatch(match).settled) break;
  }
}

describe('setting up a match', () => {
  it('gives every player one pen', () => {
    const match = fourPlayerMatch();
    expect(match.world.pens).toHaveLength(4);
    expect(new Set(match.world.pens.map((pen) => pen.ownerId)).size).toBe(4);
  });

  it('starts every pen on the table and clear of the others', () => {
    const match = createMatch('TEST1', Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      name: `Player ${i}`,
    })));

    expect(match.world.pens.every((pen) => pen.state === 'onTable')).toBe(true);

    for (let i = 0; i < match.world.pens.length; i++) {
      for (let j = i + 1; j < match.world.pens.length; j++) {
        const a = match.world.pens[i];
        const b = match.world.pens[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius + b.radius);
      }
    }
  });

  it('waits in the lobby until there are two players', () => {
    expect(createMatch('TEST1', [{ id: 'a', name: 'Ann' }]).phase).toBe('lobby');
  });
});

describe('taking turns', () => {
  it('passes the turn on once the table settles', () => {
    const match = fourPlayerMatch();
    expect(currentPlayer(match)!.id).toBe('a');

    playShot(match, 'a');
    expect(match.phase).toBe('aiming');
    expect(currentPlayer(match)!.id).toBe('b');
  });

  it('refuses a shot from somebody whose turn it is not', () => {
    const match = fourPlayerMatch();
    expect(submitStrike(match, 'c', gentle('c'))).toEqual({
      ok: false,
      reason: 'not-your-turn',
    });
  });

  it('refuses a second shot while the table is still moving', () => {
    const match = fourPlayerMatch();
    submitStrike(match, 'a', gentle('a'));
    expect(submitStrike(match, 'b', gentle('b'))).toEqual({ ok: false, reason: 'wrong-phase' });
  });

  it('skips players who have dropped out of the game', () => {
    const match = fourPlayerMatch();
    match.players[1].eliminated = true;

    playShot(match, 'a');
    expect(currentPlayer(match)!.id).toBe('c');
  });

  it('skips players who are disconnected', () => {
    const match = fourPlayerMatch();
    setConnected(match, 'b', false);

    playShot(match, 'a');
    expect(currentPlayer(match)!.id).toBe('c');
  });

  it('moves the game on if the player on the clock disconnects', () => {
    const match = fourPlayerMatch();
    expect(currentPlayer(match)!.id).toBe('a');

    setConnected(match, 'a', false);
    expect(currentPlayer(match)!.id).toBe('b');
  });
});

describe('knocking pens off', () => {
  it('takes a player out with their pen and hands the win to the survivor', () => {
    const match = createMatch('TEST1', [
      { id: 'a', name: 'Ann' },
      { id: 'b', name: 'Ben' },
    ]);
    // Past the opening round, where knock-outs count. (opening.test.ts covers it.)
    match.openingTurnsLeft = 0;

    // Put Ben's pen on the brink and shove it over.
    const bensPen = findPen(match.world, penIdFor('b'))!;
    bensPen.x = match.world.table.width / 2 - 0.01;
    bensPen.y = 0;

    // Ann shoots; then force Ben's pen off to keep the test independent of aim.
    submitStrike(match, 'a', gentle('a'));
    bensPen.vx = 3;
    for (let frame = 0; frame < 60 * 20; frame++) {
      if (stepMatch(match).settled) break;
    }

    expect(match.players.find((player) => player.id === 'b')!.eliminated).toBe(true);
    expect(match.phase).toBe('finished');
    expect(match.winnerId).toBe('a');
  });

  it('calls it a draw when the last two go off together', () => {
    const match = createMatch('TEST1', [
      { id: 'a', name: 'Ann' },
      { id: 'b', name: 'Ben' },
    ]);
    match.openingTurnsLeft = 0;

    submitStrike(match, 'a', gentle('a'));
    for (const pen of match.world.pens) {
      pen.x = match.world.table.width;
    }
    for (let frame = 0; frame < 60 * 20; frame++) {
      if (stepMatch(match).settled) break;
    }

    expect(match.phase).toBe('finished');
    expect(match.winnerId).toBeNull();
  });
});

describe('skipping a turn', () => {
  it('hands the turn to the next player without a shot', () => {
    const match = fourPlayerMatch();
    skipTurn(match);
    expect(currentPlayer(match)!.id).toBe('b');
    expect(match.phase).toBe('aiming');
  });

  it('does nothing while a shot is resolving', () => {
    const match = fourPlayerMatch();
    submitStrike(match, 'a', gentle('a'));
    skipTurn(match);
    expect(match.phase).toBe('resolving');
  });
});

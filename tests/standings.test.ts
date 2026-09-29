import { describe, expect, it } from 'vitest';
import { vec } from '../src/shared/physics/vec2';
import { findPen } from '../src/shared/physics/world';
import {
  createMatch,
  currentPlayer,
  penIdFor,
  standings,
  stepMatch,
  submitStrike,
  type Match,
} from '../src/shared/game/match';
import { restoreMatch, snapshotMatch } from '../src/shared/net/protocol';
import { SoloSession, YOU } from '../src/client/modes/solo';

function matchOf(ids: string[]): Match {
  const match = createMatch('TEST1', ids.map((id) => ({ id, name: id.toUpperCase() })));
  match.openingTurnsLeft = 0; // knock-outs count from the first shot
  return match;
}

/** Whoever is on turn takes a gentle shot while `victims` are shoved off. */
function knockOff(match: Match, victims: string[]): void {
  const shooter = currentPlayer(match)!.id;
  submitStrike(match, shooter, {
    penId: penIdFor(shooter),
    contact: { along: 0, across: 0 },
    direction: vec(0, 1),
    power: 0.1,
  });
  for (const id of victims) findPen(match.world, penIdFor(id))!.x = match.world.table.width;
  for (let frame = 0; frame < 60 * 20; frame++) {
    if (stepMatch(match).settled) return;
  }
}

const places = (match: Match) =>
  standings(match).map(({ player, place }) => [place, player.id]);

describe('standings', () => {
  it('rank the winner first, then whoever lasted longest', () => {
    const match = matchOf(['a', 'b', 'c', 'd']);
    knockOff(match, ['c']); // a shoots: c out on turn 0
    knockOff(match, ['d']); // b shoots: d out on turn 1
    knockOff(match, ['b']); // a shoots: b out on turn 2

    expect(match.phase).toBe('finished');
    expect(places(match)).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'd'],
      [4, 'c'],
    ]);
  });

  it('share a place between players who went out on the same shot', () => {
    const match = matchOf(['a', 'b', 'c', 'd']);
    knockOff(match, ['c', 'd']);
    knockOff(match, ['a']);

    expect(match.winnerId).toBe('b');
    expect(places(match)).toEqual([
      [1, 'b'],
      [2, 'a'],
      [3, 'c'],
      [3, 'd'],
    ]);
  });

  it('put everyone who went off on the last shot of a draw joint first', () => {
    const match = matchOf(['a', 'b', 'c']);
    knockOff(match, ['c']);
    knockOff(match, ['a', 'b']);

    expect(match.winnerId).toBeNull();
    expect(places(match)).toEqual([
      [1, 'a'],
      [1, 'b'],
      [3, 'c'],
    ]);
  });

  it('record the turn each player went out on', () => {
    const match = matchOf(['a', 'b', 'c']);
    knockOff(match, ['b']);
    expect(match.players.map((p) => p.outOnTurn)).toEqual([null, 0, null]);
  });

  it('survive a table saved before knock-out turns were recorded', () => {
    const match = matchOf(['a', 'b', 'c']);
    knockOff(match, ['b']);
    const old = JSON.parse(JSON.stringify(snapshotMatch(match)));
    for (const player of old.players) delete player.outOnTurn;

    const restored = restoreMatch(old);
    expect(restored.players.map((p) => p.outOnTurn)).toEqual([null, null, null]);
    expect(standings(restored).map(({ player }) => player.id)).toContain('b');
  });
});

describe('solo win tally', () => {
  it('counts each win once, and keeps counting across rematches', () => {
    const session = new SoloSession({ playerName: 'Me', botCount: 1, difficulty: 'easy', seed: 1 });
    try {
      const win = () => {
        const { match } = session;
        match.openingTurnsLeft = 0;
        // Line the match up with us to shoot and the bot's pen on its way off.
        match.turnIndex = match.players.findIndex((p) => p.id === YOU);
        session.submitStrike({
          penId: penIdFor(YOU),
          contact: { along: 0, across: 0 },
          direction: vec(0, 1),
          power: 0.1,
        });
        findPen(match.world, penIdFor('bot-0'))!.x = match.world.table.width;
        for (let frame = 0; frame < 60 * 20 && match.phase !== 'finished'; frame++) session.tick();
        expect(match.winnerId).toBe(YOU);
        // Ticking a finished match must not count the win again.
        for (let frame = 0; frame < 10; frame++) session.tick();
      };

      win();
      expect(session.wins).toEqual({ [YOU]: 1 });
      session.requestRematch();
      win();
      expect(session.wins).toEqual({ [YOU]: 2 });
    } finally {
      session.destroy();
    }
  });
});

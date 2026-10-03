import { describe, expect, it } from 'vitest';
import { vec } from '../src/shared/physics/vec2';
import { findPen } from '../src/shared/physics/world';
import {
  PEN_COLOUR_COUNT,
  assignColours,
  createMatch,
  currentPlayer,
  penIdFor,
  stepMatch,
  submitStrike,
  type Match,
} from '../src/shared/game/match';
import {
  RULESET,
  buildMatchRecord,
  createTally,
  recordEliminations,
  toDatabase,
  type MatchRecord,
} from '../src/shared/game/results';
import { SoloSession, YOU } from '../src/client/modes/solo';

describe('pen colours', () => {
  it('gives seat colours when nobody asks for one', () => {
    expect(assignColours([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]))
      .toEqual([0, 1, 2]);
  });

  it('honours a preference and fills in around it', () => {
    const colours = assignColours([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', colourIndex: 0 },
      { id: 'c', name: 'C' },
    ]);
    expect(colours).toEqual([1, 0, 2]);
  });

  it('gives a contested colour to whoever sat down first', () => {
    const colours = assignColours([
      { id: 'a', name: 'A', colourIndex: 4 },
      { id: 'b', name: 'B', colourIndex: 4 },
    ]);
    expect(colours[0]).toBe(4);
    expect(colours[1]).not.toBe(4);
  });

  it('ignores colours that do not exist', () => {
    const colours = assignColours([
      { id: 'a', name: 'A', colourIndex: -1 },
      { id: 'b', name: 'B', colourIndex: PEN_COLOUR_COUNT },
      { id: 'c', name: 'C', colourIndex: 1.5 },
    ]);
    expect(colours).toEqual([0, 1, 2]);
  });

  it('never repeats a colour at a full table of clashing preferences', () => {
    const specs = Array.from({ length: PEN_COLOUR_COUNT }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      colourIndex: 3,
    }));
    expect(new Set(assignColours(specs)).size).toBe(PEN_COLOUR_COUNT);
  });

  it('carries through to the match', () => {
    const match = createMatch('TEST1', [
      { id: 'a', name: 'A', colourIndex: 7 },
      { id: 'b', name: 'B' },
    ]);
    expect(match.players.map((player) => player.colourIndex)).toEqual([7, 0]);
  });
});

describe('knock-out tally', () => {
  it('credits other pens to the shooter and marks their own as a fall', () => {
    const tally = createTally();
    recordEliminations(tally, 'a', ['b', 'c']);
    recordEliminations(tally, 'b', ['b']);
    recordEliminations(tally, 'a', ['a']);
    expect(tally.knockouts).toEqual({ a: 2 });
    expect(tally.selfFell).toEqual(['b', 'a']);
  });
});

/** Whoever is on turn takes a gentle shot while `victims` are shoved off. */
function knockOff(match: Match, victims: string[]): string[] {
  const shooter = currentPlayer(match)!.id;
  submitStrike(match, shooter, {
    penId: penIdFor(shooter),
    contact: { along: 0, across: 0 },
    direction: vec(0, 1),
    power: 0.1,
  });
  for (const id of victims) findPen(match.world, penIdFor(id))!.x = match.world.table.width;
  const eliminated: string[] = [];
  for (let frame = 0; frame < 60 * 20; frame++) {
    const step = stepMatch(match);
    eliminated.push(...step.eliminated);
    if (step.settled) break;
  }
  return eliminated;
}

describe('match records', () => {
  function finishedMatch() {
    const match = createMatch(
      'TEST1',
      [
        { id: 'acct:ada', name: 'Ada', colourIndex: 4 },
        { id: 'guest:sam', name: '  Sam  ' },
        { id: 'acct:rafi', name: 'Rafi' },
      ],
    );
    match.openingTurnsLeft = 0;
    const tally = createTally();
    const shooter = currentPlayer(match)!.id;
    const victims = match.players.map((player) => player.id).filter((id) => id !== shooter);
    recordEliminations(tally, shooter, knockOff(match, victims));
    return { match, tally, shooter, victims };
  }

  const info = {
    id: 'm-1',
    mode: 'online' as const,
    tableCode: 'TEST1',
    startedAt: new Date('2026-10-01T10:00:00Z'),
    endedAt: new Date('2026-10-01T10:05:00Z'),
    accountIdOf: (id: string) => (id.startsWith('acct:') ? id.slice(5) : null),
  };

  it('records every seat in seating order, accounts and guests alike', () => {
    const { match, tally, shooter } = finishedMatch();
    expect(match.phase).toBe('finished');
    const record = buildMatchRecord(match, tally, info);

    expect(record).toMatchObject({
      id: 'm-1',
      mode: 'online',
      tableCode: 'TEST1',
      difficulty: null,
      ruleset: RULESET,
      startedAt: '2026-10-01T10:00:00.000Z',
      endedAt: '2026-10-01T10:05:00.000Z',
    });
    expect(record.players.map((seat) => [seat.seat, seat.kind, seat.accountId, seat.displayName])).toEqual([
      [0, 'account', 'ada', 'Ada'],
      [1, 'guest', null, 'Sam'],
      [2, 'account', 'rafi', 'Rafi'],
    ]);
    expect(record.players[0].penColour).toBe(4);

    for (const seat of record.players) {
      const isWinner = seat.playerId === shooter;
      expect(seat).toMatchObject({
        place: isWinner ? 1 : 2,
        won: isWinner,
        knockouts: isWinner ? 2 : 0,
        selfFell: false,
        stats: {},
      });
    }
  });

  it('marks bots as bots, never as accounts', () => {
    const match = createMatch('SOLO', [
      { id: 'you', name: 'Me' },
      { id: 'bot-0', name: 'Nib', isBot: true },
    ]);
    const record = buildMatchRecord(match, createTally(), {
      ...info,
      mode: 'solo',
      tableCode: null,
      difficulty: 'hard',
      accountIdOf: () => 'everyone-is-an-account',
    });
    expect(record.players.map((seat) => seat.kind)).toEqual(['account', 'bot']);
    expect(record.players[1].accountId).toBeNull();
  });

  it('turns into the column names the database functions expect', () => {
    const { match, tally } = finishedMatch();
    const row = toDatabase(buildMatchRecord(match, tally, info));
    expect(Object.keys(row).sort()).toEqual(
      ['details', 'difficulty', 'ended_at', 'id', 'players', 'ruleset', 'started_at', 'table_code', 'turns'],
    );
    expect(Object.keys(row.players[0]).sort()).toEqual(
      ['display_name', 'kind', 'knockouts', 'pen_colour', 'place', 'player_id', 'seat', 'self_fell', 'stats', 'won'],
    );
    expect(row.players[0].player_id).toBe('ada');
    expect(row.players[1].player_id).toBeNull();
  });
});

describe('solo records', () => {
  it('hands over the whole match once when it ends', () => {
    const finished: MatchRecord[] = [];
    const session = new SoloSession({
      playerName: 'Tester',
      botCount: 1,
      difficulty: 'easy',
      colourIndex: 5,
      seed: 1,
      onFinished: (record) => finished.push(record),
    });
    expect(session.match.players[0].colourIndex).toBe(5);

    const match = session.match;
    match.openingTurnsLeft = 0;
    match.turnIndex = match.players.findIndex((player) => player.id === YOU);
    session.submitStrike({
      penId: penIdFor(YOU),
      contact: { along: 0, across: 0 },
      direction: vec(0, 1),
      power: 0.1,
    });
    findPen(match.world, penIdFor('bot-0'))!.x = match.world.table.width;
    for (let frame = 0; frame < 60 * 20 && match.phase === 'resolving'; frame++) session.tick();
    session.tick();

    expect(finished).toHaveLength(1);
    const [record] = finished;
    expect(record).toMatchObject({ mode: 'solo', difficulty: 'easy', tableCode: null });
    expect(record.players).toHaveLength(2);
    expect(record.players[0]).toMatchObject({
      kind: 'guest',
      accountId: null,
      displayName: 'Tester',
      penColour: 5,
      place: 1,
      won: true,
      knockouts: 1,
    });
    expect(record.players[1]).toMatchObject({ kind: 'bot', displayName: 'Nib', place: 2, won: false });
    session.destroy();
  });
});

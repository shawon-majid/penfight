import { describe, expect, it } from 'vitest';
import { vec } from '../src/shared/physics/vec2';
import { cloneWorld, findPen, simulateUntilSettled, step } from '../src/shared/physics/world';
import { startingPoses } from '../src/shared/physics/table';
import { closestPointsBetweenSegments } from '../src/shared/physics/geometry';
import { penEndpoints } from '../src/shared/physics/pen';
import {
  createMatch,
  currentPlayer,
  inOpeningRound,
  penIdFor,
  playerById,
  randomFirstTurn,
  setConnected,
  skipTurn,
  stepMatch,
  submitStrike,
  type Match,
  type PlayerSpec,
} from '../src/shared/game/match';
import { applyStrike, type Strike } from '../src/shared/game/strike';
import { rateStrike } from '../src/shared/game/bots';
import { createRng, cryptoRandomInt } from '../src/shared/game/rng';
import { restoreMatch, snapshotMatch } from '../src/shared/net/protocol';
import { DEFAULT_TABLE } from '../src/shared/physics/table';
import { DEFAULT_TUNING } from '../src/shared/physics/tuning';

const SPECS: PlayerSpec[] = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Ben' },
  { id: 'c', name: 'Cat' },
  { id: 'd', name: 'Dev' },
];

function matchOf(count: number, firstTurnIndex?: number): Match {
  return createMatch('TEST1', SPECS.slice(0, count), DEFAULT_TABLE, DEFAULT_TUNING, {
    firstTurnIndex,
  });
}

const gentle = (playerId: string): Strike => ({
  penId: penIdFor(playerId),
  contact: { along: 0, across: 0 },
  direction: vec(1, 0),
  power: 0.15,
});

function settle(match: Match): void {
  for (let frame = 0; frame < 60 * 20; frame++) {
    if (stepMatch(match).settled) return;
  }
  throw new Error('table never settled');
}

/** The player on turn takes a gentle shot, and `victims` are shoved off the table. */
function shotThatKnocksOff(match: Match, victims: string[]): void {
  const shooter = currentPlayer(match)!.id;
  expect(submitStrike(match, shooter, gentle(shooter)).ok).toBe(true);
  for (const id of victims) {
    findPen(match.world, penIdFor(id))!.x = match.world.table.width;
  }
  settle(match);
}

const isOut = (match: Match, id: string) => playerById(match, id)!.eliminated;

describe('who goes first', () => {
  it('is the first seat unless told otherwise', () => {
    expect(currentPlayer(matchOf(4))!.id).toBe('a');
  });

  it('is whoever the caller picked, and play then goes round in seat order', () => {
    const match = matchOf(4, 2);
    const order: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      order.push(currentPlayer(match)!.id);
      skipTurn(match);
    }
    expect(order).toEqual(['c', 'd', 'a', 'b', 'c']);
  });

  it('wraps an out-of-range pick onto a real seat', () => {
    expect(currentPlayer(matchOf(4, 6))!.id).toBe('c');
    expect(currentPlayer(matchOf(4, -1))!.id).toBe('d');
    expect(currentPlayer(matchOf(4, 1.5))!.id).toBe('a');
  });

  it('gives every seat a fair chance', () => {
    const rng = createRng(42);
    const counts = [0, 0, 0, 0];
    for (let draw = 0; draw < 4000; draw++) {
      counts[randomFirstTurn(4, (n) => Math.floor(rng.next() * n))] += 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it('draws from the crypto generator within range, reaching every seat', () => {
    const seen = new Set<number>();
    for (let draw = 0; draw < 500; draw++) {
      const index = randomFirstTurn(10, cryptoRandomInt);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(10);
      seen.add(index);
    }
    expect(seen.size).toBe(10);
  });
});

describe('the opening round', () => {
  it('lasts one lap of the table, starting from whoever went first', () => {
    const match = matchOf(4, 2);
    expect(inOpeningRound(match)).toBe(true);

    for (const id of ['c', 'd', 'a', 'b']) {
      expect(inOpeningRound(match)).toBe(true);
      expect(currentPlayer(match)!.id).toBe(id);
      skipTurn(match);
    }

    expect(inOpeningRound(match)).toBe(false);
    expect(match.openingEndedOnTurn).toBe(4);
    expect(currentPlayer(match)!.id).toBe('c');
  });

  it('puts back a pen knocked off by someone else, on its starting spot', () => {
    const match = matchOf(4);
    const start = startingPoses(4, match.world.table)[1];

    shotThatKnocksOff(match, ['b']);

    expect(isOut(match, 'b')).toBe(false);
    const pen = findPen(match.world, penIdFor('b'))!;
    expect(pen.state).toBe('onTable');
    expect(pen.x).toBeCloseTo(start.position.x, 9);
    expect(pen.y).toBeCloseTo(start.position.y, 9);
    expect(pen.angle).toBeCloseTo(start.angle, 9);
    expect([pen.vx, pen.vy, pen.omega]).toEqual([0, 0, 0]);
    expect(match.returnedToStart).toEqual(['b']);
    expect(currentPlayer(match)!.id).toBe('b');
  });

  it('knocks out a player who sends their own pen off', () => {
    const match = matchOf(4);
    shotThatKnocksOff(match, ['a']);

    expect(isOut(match, 'a')).toBe(true);
    expect(findPen(match.world, penIdFor('a'))!.state).toBe('out');
    expect(match.returnedToStart).toEqual([]);
    expect(currentPlayer(match)!.id).toBe('b');
  });

  it('knocks out the shooter but spares everyone else when they all go off together', () => {
    const match = matchOf(4);
    shotThatKnocksOff(match, ['a', 'b', 'c']);

    expect(isOut(match, 'a')).toBe(true);
    expect(isOut(match, 'b')).toBe(false);
    expect(isOut(match, 'c')).toBe(false);
    expect(match.returnedToStart).toEqual(['b', 'c']);
  });

  it('in a two-player game, a first shot that goes off hands the other player the win', () => {
    const match = matchOf(2);
    shotThatKnocksOff(match, ['a']);
    expect(match.phase).toBe('finished');
    expect(match.winnerId).toBe('b');
  });

  it('in a two-player game, knocking the other pen off on the first shot does not end it', () => {
    const match = matchOf(2);
    shotThatKnocksOff(match, ['b']);
    expect(match.phase).toBe('aiming');
    expect(isOut(match, 'b')).toBe(false);
    expect(currentPlayer(match)!.id).toBe('b');
  });

  it('protects the last player of the lap, then knock-outs count', () => {
    const match = matchOf(3);
    shotThatKnocksOff(match, ['b']); // Ann
    shotThatKnocksOff(match, ['c']); // Ben
    shotThatKnocksOff(match, ['a']); // Cat: the last opening shot
    expect(isOut(match, 'a')).toBe(false);
    expect(inOpeningRound(match)).toBe(false);
    expect(match.openingEndedOnTurn).toBe(3);

    shotThatKnocksOff(match, ['b']); // Ann again, for real this time
    expect(isOut(match, 'b')).toBe(true);
    expect(match.returnedToStart).toEqual([]);
  });

  it('counts a seat skipped for being away as that seat having had its go', () => {
    const match = matchOf(4);
    setConnected(match, 'c', false);

    shotThatKnocksOff(match, []); // Ann
    shotThatKnocksOff(match, []); // Ben, and Cat is passed over
    expect(currentPlayer(match)!.id).toBe('d');
    expect(match.openingTurnsLeft).toBe(1);

    shotThatKnocksOff(match, []); // Dev
    expect(inOpeningRound(match)).toBe(false);
  });

  it('counts a turn lost to the clock as that seat having had its go', () => {
    const match = matchOf(3);
    skipTurn(match);
    skipTurn(match);
    expect(match.openingTurnsLeft).toBe(1);
    skipTurn(match);
    expect(inOpeningRound(match)).toBe(false);
  });

  it('moves a returned pen along until it is clear, if its spot is taken', () => {
    const match = matchOf(4);
    const start = startingPoses(4, match.world.table)[1];

    // Park Cat's pen right on Ben's starting spot.
    const catsPen = findPen(match.world, penIdFor('c'))!;
    catsPen.x = start.position.x;
    catsPen.y = start.position.y;
    catsPen.angle = start.angle;

    shotThatKnocksOff(match, ['b']);

    const bensPen = findPen(match.world, penIdFor('b'))!;
    expect(bensPen.state).toBe('onTable');
    expect(Math.hypot(bensPen.x, bensPen.y)).toBeLessThan(Math.hypot(start.position.x, start.position.y));

    for (const other of match.world.pens) {
      if (other === bensPen || other.state !== 'onTable') continue;
      const [a0, a1] = penEndpoints(bensPen);
      const [b0, b1] = penEndpoints(other);
      const gap = closestPointsBetweenSegments(a0, a1, b0, b1).distance;
      expect(gap).toBeGreaterThan(bensPen.radius + other.radius);
    }
  });

  it('leaves the physics of the shot itself untouched', () => {
    // The rules only step in once the table has settled. Until then the
    // match must move exactly as the bare solver does.
    const match = matchOf(4);
    const strike: Strike = {
      penId: penIdFor('a'),
      contact: { along: 0.6, across: 0 },
      direction: vec(0.3, 1),
      power: 0.9,
    };
    submitStrike(match, 'a', strike);

    const bare = cloneWorld(match.world);
    for (const world of [match.world, bare]) {
      const bensPen = findPen(world, penIdFor('b'))!;
      bensPen.vx = 4;
      bensPen.vy = 1;
    }

    let settled = false;
    for (let frame = 0; frame < 60 * 20 && !settled; frame++) {
      settled = stepMatch(match).settled;
      step(bare);
      for (const [index, pen] of match.world.pens.entries()) {
        const twin = bare.pens[index];
        // On the settling frame, only a returned pen may differ.
        if (settled && match.returnedToStart.includes(pen.ownerId)) continue;
        expect([pen.x, pen.y, pen.angle, pen.state]).toEqual([twin.x, twin.y, twin.angle, twin.state]);
      }
    }
    expect(settled).toBe(true);
    expect(match.returnedToStart).toContain('b');
  });
});

describe('snapshots of the opening round', () => {
  it('carry it across the wire', () => {
    const match = matchOf(4, 1);
    shotThatKnocksOff(match, ['c']);
    const restored = restoreMatch(JSON.parse(JSON.stringify(snapshotMatch(match))));

    expect(restored.turnIndex).toBe(match.turnIndex);
    expect(restored.openingTurnsLeft).toBe(3);
    expect(restored.openingEndedOnTurn).toBeNull();
    expect(restored.returnedToStart).toEqual(['c']);
  });

  it('treat a table saved before the opening round existed as already under way', () => {
    const match = matchOf(4);
    const old = JSON.parse(JSON.stringify(snapshotMatch(match)));
    delete old.openingTurnsLeft;
    delete old.openingEndedOnTurn;
    delete old.returnedToStart;

    const restored = restoreMatch(old);
    expect(restored.openingTurnsLeft).toBe(0);
    expect(restored.openingEndedOnTurn).toBeNull();
    expect(restored.returnedToStart).toEqual([]);
  });
});

describe('bots in the opening round', () => {
  it('give no credit for knocking someone off, and still fear going off themselves', () => {
    const match = matchOf(2);
    const half = match.world.table.width / 2;

    // Ben broadside on the brink; Ann lined up just behind, pushing gently.
    const annsPen = findPen(match.world, penIdFor('a'))!;
    const bensPen = findPen(match.world, penIdFor('b'))!;
    Object.assign(bensPen, { x: half - 0.03, y: 0, angle: Math.PI / 2 });
    Object.assign(annsPen, { x: half - 0.1, y: 0, angle: Math.PI / 2 });
    const push: Strike = {
      penId: annsPen.id,
      contact: { along: 0, across: 0 },
      direction: vec(1, 0),
      power: 0.5,
    };

    // Check the setup does what it claims: Ben off, Ann still on.
    const rehearsal = cloneWorld(match.world);
    applyStrike(rehearsal, push);
    simulateUntilSettled(rehearsal);
    expect(findPen(rehearsal, bensPen.id)!.state).not.toBe('onTable');
    expect(findPen(rehearsal, annsPen.id)!.state).toBe('onTable');

    const opening = rateStrike(match, 'a', push);
    match.openingTurnsLeft = 0;
    const later = rateStrike(match, 'a', push);
    expect(later - opening).toBeCloseTo(100, 6);

    // Going off yourself is just as bad in the opening round.
    const suicide: Strike = { ...push, direction: vec(-1, 0), power: 1 };
    Object.assign(annsPen, { x: -half + 0.1 });
    match.openingTurnsLeft = 2;
    expect(rateStrike(match, 'a', suicide)).toBeLessThan(-500);
  });
});

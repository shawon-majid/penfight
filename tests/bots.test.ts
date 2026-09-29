import { describe, expect, it } from 'vitest';
import { findPen, simulateUntilSettled, cloneWorld } from '../src/shared/physics/world';
import { chooseBotStrike, rateStrike } from '../src/shared/game/bots';
import { createMatch, penIdFor } from '../src/shared/game/match';
import { createRng } from '../src/shared/game/rng';
import { applyStrike, checkStrike } from '../src/shared/game/strike';
import { vec } from '../src/shared/physics/vec2';

function duel() {
  return createMatch('TEST1', [
    { id: 'bot', name: 'Nib', isBot: true },
    { id: 'human', name: 'You' },
  ]);
}

describe('bot shot selection', () => {
  it('produces a shot the rules will accept', () => {
    const match = duel();
    const decision = chooseBotStrike(match, 'bot', createRng(1), 'normal');

    expect(decision).not.toBeNull();
    expect(decision!.strike.penId).toBe(penIdFor('bot'));
    expect(checkStrike(match.world, 'bot', decision!.strike)).toEqual({ ok: true });
  });

  it('is repeatable for a given seed', () => {
    const a = chooseBotStrike(duel(), 'bot', createRng(42), 'normal')!;
    const b = chooseBotStrike(duel(), 'bot', createRng(42), 'normal')!;
    expect(a.strike).toEqual(b.strike);
  });

  it('rates an easy kill highly', () => {
    const match = duel();
    // A kill only counts once the opening round is over (see opening.test.ts).
    match.openingTurnsLeft = 0;
    // Park the human's pen right on the lip of the table, in front of the bot.
    const target = findPen(match.world, penIdFor('human'))!;
    const shooter = findPen(match.world, penIdFor('bot'))!;
    target.y = shooter.y;
    target.x = match.world.table.width / 2 - 0.02;
    shooter.x = target.x - 0.35;
    shooter.angle = 0;

    const decision = chooseBotStrike(match, 'bot', createRng(7), 'hard')!;
    expect(decision.expectedScore).toBeGreaterThan(0);
  });

  it('rates a shot that loses its own pen far below one that does not', () => {
    const match = duel();
    const shooter = findPen(match.world, penIdFor('bot'))!;
    shooter.x = -match.world.table.width / 2 + 0.05;
    shooter.y = 0;
    shooter.angle = 0;

    // Straight off the near edge, versus the same power the other way.
    const suicide = {
      penId: penIdFor('bot'),
      contact: { along: 0, across: 0 },
      direction: vec(-1, 0),
      power: 1,
    };
    const sensible = { ...suicide, direction: vec(1, 0), power: 0.4 };

    const suicideScore = rateStrike(match, 'bot', suicide, 'hard');
    expect(suicideScore).toBeLessThan(-500);
    expect(rateStrike(match, 'bot', sensible, 'hard')).toBeGreaterThan(suicideScore);
  });

  it('never picks a shot it expects to lose its own pen on', () => {
    const match = duel();
    const shooter = findPen(match.world, penIdFor('bot'))!;
    shooter.x = -match.world.table.width / 2 + 0.03;
    shooter.y = 0;
    shooter.angle = 0;

    const decision = chooseBotStrike(match, 'bot', createRng(3), 'hard')!;
    expect(decision.expectedScore).toBeGreaterThan(-500);

    // What it intended, before its hand wobbles, keeps its pen on the table.
    const rehearsal = cloneWorld(match.world);
    applyStrike(rehearsal, decision.strike);
    simulateUntilSettled(rehearsal);
    // A miss can still cost it the pen — that is the game, not a bug — so we
    // only assert the intent above, and that the shot was a real attempt.
    expect(findPen(rehearsal, penIdFor('bot'))!.x).toBeGreaterThan(shooter.x);
  });

  it('has nothing to say once every opponent is gone', () => {
    const match = duel();
    findPen(match.world, penIdFor('human'))!.state = 'out';
    expect(chooseBotStrike(match, 'bot', createRng(1), 'normal')).toBeNull();
  });

  it('has nothing to say when its own pen is gone', () => {
    const match = duel();
    findPen(match.world, penIdFor('bot'))!.state = 'out';
    expect(chooseBotStrike(match, 'bot', createRng(1), 'normal')).toBeNull();
  });
});

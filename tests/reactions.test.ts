import { describe, expect, it } from 'vitest';
import { createMatch } from '../src/shared/game/match';
import { AVATAR_COUNT, REACTION_COUNT, isReaction, parseAvatar } from '../src/shared/game/reactions';
import { restoreMatch, snapshotMatch } from '../src/shared/net/protocol';

/**
 * Reactions and avatars travel as bare numbers, so the only thing standing
 * between a doctored client and the other players is these checks.
 */

describe('reaction numbers', () => {
  it('accepts every reaction there is art for', () => {
    for (let i = 0; i < REACTION_COUNT; i++) expect(isReaction(i)).toBe(true);
  });

  it('turns away anything else', () => {
    for (const value of [-1, REACTION_COUNT, 1.5, '2', null, undefined, NaN, {}]) {
      expect(isReaction(value)).toBe(false);
    }
  });
});

describe('avatar numbers', () => {
  it('reads one from a query string', () => {
    expect(parseAvatar('0')).toBe(0);
    expect(parseAvatar(String(AVATAR_COUNT - 1))).toBe(AVATAR_COUNT - 1);
  });

  it('ignores one out of range or missing', () => {
    for (const raw of [String(AVATAR_COUNT), '-1', 'crown', '', null, undefined]) {
      expect(parseAvatar(raw)).toBeNull();
    }
  });

  it('survives the trip to another browser', () => {
    const match = createMatch('ABCD', [
      { id: 'a', name: 'Ann', avatar: 3 },
      { id: 'b', name: 'Ben' },
    ]);
    const restored = restoreMatch(JSON.parse(JSON.stringify(snapshotMatch(match))));
    expect(restored.players[0].avatar).toBe(3);
    // Someone who never picked one has none, rather than a made-up default.
    expect(restored.players[1].avatar).toBeUndefined();
  });
});

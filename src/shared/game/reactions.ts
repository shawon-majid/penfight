/**
 * Reactions and avatars, as numbers.
 *
 * Both are picked from fixed sets, so what travels over the wire is just an
 * index. The artwork lives in the client (`ui/glyphs.ts`); only the sizes of
 * the sets are shared, so the server can turn away a number nobody can draw.
 * There is deliberately no free text: nothing to moderate, nothing to abuse.
 */

/** How many reactions there are to pick from. */
export const REACTION_COUNT = 12;

/** How many avatars there are to pick from. */
export const AVATAR_COUNT = 12;

/**
 * The least time between two reactions from the same player. Enough to keep a
 * table readable; the server enforces it, the client just avoids tripping it.
 */
export const REACTION_COOLDOWN_MS = 1500;

export function isReaction(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < REACTION_COUNT;
}

export function parseAvatar(raw: string | number | null | undefined): number | null {
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  return Number.isInteger(value) && value >= 0 && value < AVATAR_COUNT ? value : null;
}

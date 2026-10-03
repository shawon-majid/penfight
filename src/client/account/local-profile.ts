/**
 * A guest's details, kept in this browser and nowhere else.
 *
 * Playing without signing in touches no server beyond the game itself, so
 * what a guest has — the name they play under and their games against the
 * bots — lives in local storage. Signing in copies it across once, the
 * first time (see `account.ts`).
 *
 * Storage can be missing or refuse writes (private windows, blocked site
 * data), so every access is guarded and the game plays on without it.
 */

import { PEN_COLOUR_COUNT } from '../../shared/game/match';
import type { MatchRecord } from '../../shared/game/results';

const NAME_KEY = 'penfight.name';
const SOLO_KEY = 'penfight.soloHistory';

/** Enough history for a meaningful record without letting storage grow forever. */
const SOLO_HISTORY_LIMIT = 200;

export function loadName(): string {
  return read(NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  write(NAME_KEY, name);
}

/** Finished games against the bots, oldest first, in the same shape the database takes. */
export function loadSoloHistory(): MatchRecord[] {
  try {
    const parsed: unknown = JSON.parse(read(SOLO_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    // Anything not shaped like a match record is from an older build; drop it.
    return parsed.filter(
      (entry): entry is MatchRecord =>
        typeof entry === 'object' && entry !== null && Array.isArray((entry as MatchRecord).players),
    );
  } catch {
    return [];
  }
}

export function appendSoloRecord(record: MatchRecord): void {
  const history = [...loadSoloHistory(), record].slice(-SOLO_HISTORY_LIMIT);
  write(SOLO_KEY, JSON.stringify(history));
}

export function clearSoloHistory(): void {
  try {
    localStorage.removeItem(SOLO_KEY);
  } catch {
    // Nothing stored, or storage unavailable. Either way it is gone.
  }
}

export function parseColour(raw: string | number | null | undefined): number | null {
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  return Number.isInteger(value) && value >= 0 && value < PEN_COLOUR_COUNT ? value : null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is full or blocked. The game works without it.
  }
}

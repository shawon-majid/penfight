/**
 * How a finished match went, seat by seat — what gets saved to a profile.
 *
 * Placings come straight from `standings`. Knock-outs need one more fact the
 * match does not keep: whose shot sent each pen off. That is always whoever
 * was on turn when it fell, so the caller reports each shot's eliminations as
 * they happen and this tallies them. The server does it for online tables and
 * the solo session for games against bots, which is why it lives here rather
 * than in either.
 */

import type { BotDifficulty } from './bots';
import type { Match } from './match';
import { standings } from './match';

/**
 * Which version of the rules a match was played under. Saved with every
 * match so a rule change never muddles the numbers. Bump it when the rules
 * change — not for physics tuning, which is a matter of feel, but for anything
 * that changes how a game is won or lost.
 *
 *   1  one pen each; opening round returns pens knocked off by others
 */
export const RULESET = 1;

export interface ShotTally {
  /** Pens each player has knocked off other people's, by player id. */
  knockouts: Record<string, number>;
  /** Players who went off the table on their own shot. */
  selfFell: string[];
}

export function createTally(): ShotTally {
  return { knockouts: {}, selfFell: [] };
}

/**
 * Credit a shot's eliminations to the shooter.
 *
 * Only real eliminations count. In the opening round a pen knocked off by
 * somebody else is put back rather than eliminated, so it never reaches here
 * and nobody is credited for it.
 */
export function recordEliminations(
  tally: ShotTally,
  shooterId: string,
  eliminated: readonly string[],
): void {
  for (const playerId of eliminated) {
    if (playerId === shooterId) {
      if (!tally.selfFell.includes(playerId)) tally.selfFell.push(playerId);
    } else {
      tally.knockouts[shooterId] = (tally.knockouts[shooterId] ?? 0) + 1;
    }
  }
}

export type SeatKind = 'account' | 'guest' | 'bot';

/** One seat at a finished match. */
export interface SeatRecord {
  /** Index into the match's players, in seating order. */
  seat: number;
  /** The player's id within the match, for finding yourself. Not saved. */
  playerId: string;
  kind: SeatKind;
  /** The Supabase account behind the seat, if there is one. */
  accountId: string | null;
  displayName: string;
  penColour: number;
  /** 1 for the winner. Players who went off on the same shot share a place. */
  place: number;
  won: boolean;
  knockouts: number;
  selfFell: boolean;
  /** Room for experimental per-player numbers. Promote a key to a column once it matters. */
  stats: Record<string, number>;
}

/** One finished match, every seat included. */
export interface MatchRecord {
  id: string;
  mode: 'online' | 'solo';
  tableCode: string | null;
  difficulty: BotDifficulty | null;
  ruleset: number;
  turns: number;
  /** ISO timestamps. */
  startedAt: string;
  endedAt: string;
  details: Record<string, unknown>;
  players: SeatRecord[];
}

export interface MatchRecordInfo {
  id: string;
  mode: 'online' | 'solo';
  tableCode?: string | null;
  difficulty?: BotDifficulty | null;
  startedAt: Date;
  endedAt: Date;
  /** The account behind a player id, or null for a guest. Bots are spotted from the match. */
  accountIdOf: (playerId: string) => string | null;
}

/** Everything worth keeping about a finished match. */
export function buildMatchRecord(match: Match, tally: ShotTally, info: MatchRecordInfo): MatchRecord {
  const placeOf = new Map(standings(match).map(({ player, place }) => [player.id, place]));

  return {
    id: info.id,
    mode: info.mode,
    tableCode: info.tableCode ?? null,
    difficulty: info.difficulty ?? null,
    ruleset: RULESET,
    turns: match.turnNumber,
    startedAt: info.startedAt.toISOString(),
    endedAt: info.endedAt.toISOString(),
    details: {},
    players: match.players.map((player, seat) => {
      const accountId = player.isBot ? null : info.accountIdOf(player.id);
      return {
        seat,
        playerId: player.id,
        kind: player.isBot ? 'bot' : accountId ? 'account' : 'guest',
        accountId,
        displayName: player.name.trim().slice(0, 24) || 'Player',
        penColour: player.colourIndex,
        place: placeOf.get(player.id) ?? match.players.length,
        won: match.winnerId === player.id,
        knockouts: tally.knockouts[player.id] ?? 0,
        selfFell: tally.selfFell.includes(player.id),
        stats: {},
      };
    }),
  };
}

/**
 * The record in the shape the database functions take (`record_online_match`,
 * `record_solo_matches`). The one place that knows the column names.
 */
export function toDatabase(record: MatchRecord) {
  return {
    id: record.id,
    table_code: record.tableCode,
    difficulty: record.difficulty,
    ruleset: record.ruleset,
    turns: record.turns,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    details: record.details,
    players: record.players.map((seat) => ({
      seat: seat.seat,
      player_id: seat.accountId,
      kind: seat.kind,
      display_name: seat.displayName,
      pen_colour: seat.penColour,
      place: seat.place,
      won: seat.won,
      knockouts: seat.knockouts,
      self_fell: seat.selfFell,
      stats: seat.stats,
    })),
  };
}

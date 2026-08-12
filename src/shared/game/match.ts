/**
 * The rules: who is playing, whose turn it is, who is out, who has won.
 *
 * This layer sits on top of the physics and knows nothing about how a pen
 * moves — only that pens belong to players and that a pen leaving the table
 * knocks its owner out. Keeping the two apart means the rules can be changed
 * (teams, lives, a shrinking table) without touching the solver, and the
 * solver can be tuned without touching the rules.
 *
 * A match runs the same way in the browser and on the server. The server's
 * copy is the one that counts.
 */

import type { Table } from '../physics/table';
import { DEFAULT_TABLE, startingPoses } from '../physics/table';
import { DEFAULT_TUNING, type Tuning } from '../physics/tuning';
import type { StepResult, World } from '../physics/world';
import { createWorld, findPen, step } from '../physics/world';
import type { Strike } from './strike';
import { applyStrike, checkStrike, sanitiseStrike } from './strike';

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;

export type MatchPhase =
  /** Waiting in the lobby for players. */
  | 'lobby'
  /** Waiting for the player whose turn it is to flick. */
  | 'aiming'
  /** A strike is in flight; the table is still moving. */
  | 'resolving'
  /** Somebody won, or everybody fell off. */
  | 'finished';

export interface Player {
  id: string;
  name: string;
  /** Index into the render palette. Stable for the whole match. */
  colourIndex: number;
  isBot: boolean;
  /** False while a human is disconnected. Their turns get skipped. */
  connected: boolean;
  eliminated: boolean;
  /** The one pen they own. */
  penId: string;
}

export interface Match {
  /** The code people type to join this table. */
  code: string;
  phase: MatchPhase;
  players: Player[];
  world: World;
  /** Index into `players` of whoever is on. */
  turnIndex: number;
  /** Increments every completed turn. Handy for logs and replays. */
  turnNumber: number;
  winnerId: string | null;
}

export interface PlayerSpec {
  id: string;
  name: string;
  isBot?: boolean;
}

export function penIdFor(playerId: string): string {
  return `pen:${playerId}`;
}

/**
 * Start a match.
 *
 * Everyone gets one pen, placed evenly around the table, so seating order
 * never confers an advantage.
 */
export function createMatch(
  code: string,
  specs: readonly PlayerSpec[],
  table: Table = DEFAULT_TABLE,
  tuning: Tuning = DEFAULT_TUNING,
): Match {
  const poses = startingPoses(specs.length, table);

  const players: Player[] = specs.map((spec, index) => ({
    id: spec.id,
    name: spec.name,
    colourIndex: index,
    isBot: spec.isBot ?? false,
    connected: true,
    eliminated: false,
    penId: penIdFor(spec.id),
  }));

  const world = createWorld(
    specs.map((spec, index) => ({
      id: penIdFor(spec.id),
      ownerId: spec.id,
      x: poses[index].position.x,
      y: poses[index].position.y,
      angle: poses[index].angle,
    })),
    table,
    tuning,
  );

  return {
    code,
    phase: specs.length >= MIN_PLAYERS ? 'aiming' : 'lobby',
    players,
    world,
    turnIndex: 0,
    turnNumber: 0,
    winnerId: null,
  };
}

export function playerById(match: Match, playerId: string): Player | undefined {
  return match.players.find((player) => player.id === playerId);
}

export function currentPlayer(match: Match): Player | undefined {
  return match.players[match.turnIndex];
}

/** Players still in the game, in seating order. */
export function activePlayers(match: Match): Player[] {
  return match.players.filter((player) => !player.eliminated);
}

/** Active players who could actually take a turn right now. */
function playablePlayers(match: Match): Player[] {
  return match.players.filter(
    (player) => !player.eliminated && (player.isBot || player.connected),
  );
}

export type StrikeResult =
  | { ok: true }
  | { ok: false; reason: 'not-your-turn' | 'wrong-phase' | 'unknown-player' | string };

/**
 * Take a player's shot.
 *
 * Everything is re-checked here rather than trusted, because this same call is
 * what the server runs when a message arrives off the network.
 */
export function submitStrike(
  match: Match,
  playerId: string,
  strike: Strike,
): StrikeResult {
  if (match.phase !== 'aiming') return { ok: false, reason: 'wrong-phase' };

  const player = playerById(match, playerId);
  if (!player) return { ok: false, reason: 'unknown-player' };

  const onTurn = currentPlayer(match);
  if (!onTurn || onTurn.id !== playerId) return { ok: false, reason: 'not-your-turn' };

  const clean = sanitiseStrike(strike);
  const check = checkStrike(match.world, playerId, clean);
  if (!check.ok) return { ok: false, reason: check.reason };

  applyStrike(match.world, clean);
  match.phase = 'resolving';
  return { ok: true };
}

export interface MatchStepResult extends StepResult {
  /** Players knocked out by this step. */
  eliminated: string[];
  /** True when the table settled and the turn changed hands. */
  turnEnded: boolean;
}

/**
 * Advance a match by one physics frame.
 *
 * Only does anything while a shot is resolving. When the table finally stops,
 * eliminations are counted and the turn passes.
 */
export function stepMatch(match: Match): MatchStepResult {
  if (match.phase !== 'resolving') {
    return {
      settled: true,
      collisions: [],
      startedFalling: [],
      finishedFalling: [],
      eliminated: [],
      turnEnded: false,
    };
  }

  const physics = step(match.world);
  const eliminated = applyEliminations(match, physics.finishedFalling);

  let turnEnded = false;
  if (physics.settled) {
    turnEnded = true;
    match.turnNumber += 1;
    concludeTurn(match);
  }

  return { ...physics, eliminated, turnEnded };
}

/** Any pen that finished falling takes its owner out with it. */
function applyEliminations(match: Match, fallenPenIds: readonly string[]): string[] {
  const eliminated: string[] = [];
  for (const penId of fallenPenIds) {
    const player = match.players.find((candidate) => candidate.penId === penId);
    if (player && !player.eliminated) {
      player.eliminated = true;
      eliminated.push(player.id);
    }
  }
  return eliminated;
}

/** Decide whether the match is over, and if not, hand the turn on. */
function concludeTurn(match: Match): void {
  const remaining = activePlayers(match);

  if (remaining.length <= 1) {
    match.phase = 'finished';
    // Nobody left means everyone went over the edge together: a draw.
    match.winnerId = remaining.length === 1 ? remaining[0].id : null;
    return;
  }

  const next = nextPlayerIndex(match);
  if (next === null) {
    // Everyone still alive is disconnected. Hold here; the server will resume
    // the match if somebody reconnects.
    match.phase = 'aiming';
    return;
  }

  match.turnIndex = next;
  match.phase = 'aiming';
}

/**
 * Whoever is next in seating order, skipping anyone out or disconnected.
 * Returns null when nobody can play.
 */
export function nextPlayerIndex(match: Match): number | null {
  if (playablePlayers(match).length === 0) return null;

  const count = match.players.length;
  for (let offset = 1; offset <= count; offset++) {
    const index = (match.turnIndex + offset) % count;
    const candidate = match.players[index];
    if (!candidate.eliminated && (candidate.isBot || candidate.connected)) {
      return index;
    }
  }
  return null;
}

/**
 * Pass the turn without a shot.
 *
 * Used when a player runs out of thinking time or drops mid-turn. Without it,
 * one person walking away would freeze the table for everyone else.
 */
export function skipTurn(match: Match): void {
  if (match.phase !== 'aiming') return;
  match.turnNumber += 1;
  concludeTurn(match);
}

/**
 * Mark a player connected or not.
 *
 * A player who drops keeps their pen on the table — it can still be knocked
 * off by everyone else, which is only fair — but their turns are skipped until
 * they come back.
 */
export function setConnected(match: Match, playerId: string, connected: boolean): void {
  const player = playerById(match, playerId);
  if (!player || player.connected === connected) return;
  player.connected = connected;

  // If they dropped while on the clock, move the game along.
  if (!connected && match.phase === 'aiming' && currentPlayer(match)?.id === playerId) {
    skipTurn(match);
  }
}

/** Convenience for the UI: the pen belonging to a player, if it still exists. */
export function penOf(match: Match, playerId: string) {
  const player = playerById(match, playerId);
  return player ? findPen(match.world, player.penId) : undefined;
}

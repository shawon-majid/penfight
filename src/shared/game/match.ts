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

import { closestPointsBetweenSegments } from '../physics/geometry';
import type { Pen } from '../physics/pen';
import { penEndpoints, stopPen } from '../physics/pen';
import type { Table } from '../physics/table';
import { DEFAULT_TABLE, startingPoses, tableBounds } from '../physics/table';
import { DEFAULT_TUNING, type Tuning } from '../physics/tuning';
import type { Vec2 } from '../physics/vec2';
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
  /** The turn number they were knocked out on, for the final standings. */
  outOnTurn: number | null;
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
  /**
   * Seats still to be passed before the opening round is over.
   *
   * The opening round is one lap of the table from whoever went first. While
   * it lasts, a pen knocked off by somebody else's shot is put back on its
   * starting spot instead of knocking its owner out, so everyone gets at least
   * one go before the real game begins. Knocking *yourself* off still counts.
   *
   * Counted in seats rather than shots, so a seat that is skipped (out, away,
   * timed out) still uses up its place and the lap always ends.
   */
  openingTurnsLeft: number;
  /** The turn number on which the opening round ended, for the HUD. */
  openingEndedOnTurn: number | null;
  /** Players whose pens were put back on their starting spot last turn. */
  returnedToStart: string[];
}

export interface MatchOptions {
  /**
   * Index into the players of whoever shoots first. The shared code keeps no
   * randomness of its own, so callers pick this: the server from
   * `crypto.getRandomValues`, solo play from its seeded generator.
   */
  firstTurnIndex?: number;
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
 * never confers an advantage. Who shoots first is `options.firstTurnIndex`;
 * after that the turn goes round in seating order.
 */
export function createMatch(
  code: string,
  specs: readonly PlayerSpec[],
  table: Table = DEFAULT_TABLE,
  tuning: Tuning = DEFAULT_TUNING,
  options: MatchOptions = {},
): Match {
  const poses = startingPoses(specs.length, table);

  const players: Player[] = specs.map((spec, index) => ({
    id: spec.id,
    name: spec.name,
    colourIndex: index,
    isBot: spec.isBot ?? false,
    connected: true,
    eliminated: false,
    outOnTurn: null,
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
    turnIndex: clampFirstTurn(options.firstTurnIndex, specs.length),
    turnNumber: 0,
    winnerId: null,
    openingTurnsLeft: specs.length,
    openingEndedOnTurn: null,
    returnedToStart: [],
  };
}

function clampFirstTurn(index: number | undefined, playerCount: number): number {
  if (index === undefined || !Number.isInteger(index) || playerCount === 0) return 0;
  return ((index % playerCount) + playerCount) % playerCount;
}

/** Pick a first player uniformly, given any source of random integers. */
export function randomFirstTurn(
  playerCount: number,
  randomInt: (maxExclusive: number) => number,
): number {
  return playerCount > 0 ? randomInt(playerCount) : 0;
}

/** True while pens knocked off by other players are still put back. */
export function inOpeningRound(match: Match): boolean {
  return match.openingTurnsLeft > 0;
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
    match.returnedToStart = inOpeningRound(match) ? returnSparedPens(match, eliminated) : [];
    match.turnNumber += 1;
    concludeTurn(match);
  }

  return { ...physics, eliminated, turnEnded };
}

/**
 * Any pen that finished falling takes its owner out with it.
 *
 * Except in the opening round, where only the shooter can be knocked out, and
 * only by their own shot. Anyone else's pen is left `out` for the rest of the
 * shot, so the physics plays out untouched, and `returnSparedPens` puts it
 * back once the table has settled.
 */
function applyEliminations(match: Match, fallenPenIds: readonly string[]): string[] {
  const shooterId = currentPlayer(match)?.id;
  const eliminated: string[] = [];
  for (const penId of fallenPenIds) {
    const player = match.players.find((candidate) => candidate.penId === penId);
    if (!player || player.eliminated) continue;
    if (inOpeningRound(match) && player.id !== shooterId) continue;
    knockOut(match, player);
    eliminated.push(player.id);
  }
  return eliminated;
}

function knockOut(match: Match, player: Player): void {
  player.eliminated = true;
  player.outOnTurn = match.turnNumber;
}

/**
 * Opening round only: put back every pen that went off the table this shot.
 *
 * Each goes to its owner's starting spot, pointing the way it started. If
 * another pen is sitting there, it moves towards the middle until it is clear.
 * The shooter's own pen is the exception: it is only still here if the shot
 * was cut short mid-fall, and going off on your own shot knocks you out.
 * Returns the owners whose pens were put back, in seating order.
 */
function returnSparedPens(match: Match, eliminated: string[]): string[] {
  const shooterId = currentPlayer(match)?.id;
  const poses = startingPoses(match.players.length, match.world.table);
  const returned: string[] = [];

  for (const [seat, player] of match.players.entries()) {
    if (player.eliminated) continue;
    const pen = findPen(match.world, player.penId);
    if (!pen || pen.state === 'onTable') continue;

    if (player.id === shooterId) {
      knockOut(match, player);
      eliminated.push(player.id);
      continue;
    }

    const pose = poses[seat];
    const spot = findClearSpot(match, pen, pose.position, pose.angle);
    pen.x = spot.x;
    pen.y = spot.y;
    pen.angle = pose.angle;
    pen.state = 'onTable';
    pen.fallProgress = 0;
    stopPen(pen);
    returned.push(player.id);
  }

  return returned;
}

/** Gap kept between a returned pen and its neighbours. m */
const RETURN_CLEARANCE = 0.01;
/** How far each try moves when the starting spot is taken. m */
const RETURN_STEP = 0.02;

/**
 * The first point on the line from `start` to the middle of the table where
 * `pen` would not touch any pen already there. Falls back to a scan of the
 * table, and finally to `start` itself, so it always has an answer.
 */
function findClearSpot(match: Match, pen: Pen, start: Vec2, angle: number): Vec2 {
  const steps = Math.ceil(Math.hypot(start.x, start.y) / RETURN_STEP);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const candidate = { x: start.x * (1 - t), y: start.y * (1 - t) };
    if (isClear(match, pen, candidate, angle)) return candidate;
  }

  // The whole line is crowded. Scan the table, keeping a pen length clear of
  // the edges so the spot it lands on is not a death sentence.
  const b = tableBounds(match.world.table);
  for (let y = b.minY + pen.length; y <= b.maxY - pen.length; y += RETURN_STEP) {
    for (let x = b.minX + pen.length; x <= b.maxX - pen.length; x += RETURN_STEP) {
      if (isClear(match, pen, { x, y }, angle)) return { x, y };
    }
  }
  return { x: start.x, y: start.y };
}

function isClear(match: Match, pen: Pen, at: Vec2, angle: number): boolean {
  const [a0, a1] = penEndpoints({ ...pen, x: at.x, y: at.y, angle });
  for (const other of match.world.pens) {
    if (other.id === pen.id || other.state !== 'onTable') continue;
    const [b0, b1] = penEndpoints(other);
    const gap = closestPointsBetweenSegments(a0, a1, b0, b1).distance;
    if (gap < pen.radius + other.radius + RETURN_CLEARANCE) return false;
  }
  return true;
}

/** Decide whether the match is over, and if not, hand the turn on. */
function concludeTurn(match: Match): void {
  const remaining = activePlayers(match);
  const seatBefore = match.turnIndex;

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
  countOpeningSeats(match, seatBefore, next);
}

/**
 * Use up the seats passed on the way to the next player: the one that just
 * played, plus any skipped over because they were out or away.
 */
function countOpeningSeats(match: Match, from: number, to: number): void {
  if (!inOpeningRound(match)) return;
  const count = match.players.length;
  const passed = ((to - from + count - 1) % count) + 1;
  match.openingTurnsLeft = Math.max(0, match.openingTurnsLeft - passed);
  if (match.openingTurnsLeft === 0) match.openingEndedOnTurn = match.turnNumber;
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

export interface Standing {
  player: Player;
  /** 1 for the winner. Players who went out on the same shot share a place. */
  place: number;
}

/**
 * Everyone in finishing order: the winner first, then whoever lasted longest.
 *
 * In a draw the players who went off together on the final shot share first.
 */
export function standings(match: Match): Standing[] {
  // Higher is better: still on the table beats every knock-out, and a later
  // knock-out beats an earlier one.
  const lasted = (player: Player): number =>
    !player.eliminated ? Number.POSITIVE_INFINITY : (player.outOnTurn ?? -1);

  // Compared rather than subtracted: Infinity - Infinity is NaN. Sort is
  // stable, so ties keep seating order.
  const ordered = [...match.players].sort((a, b) =>
    lasted(a) === lasted(b) ? 0 : lasted(a) > lasted(b) ? -1 : 1,
  );
  const result: Standing[] = [];
  for (const [index, player] of ordered.entries()) {
    const previous = result[index - 1];
    const tied = previous !== undefined && lasted(previous.player) === lasted(player);
    result.push({ player, place: tied ? previous.place : index + 1 });
  }
  return result;
}

/** Convenience for the UI: the pen belonging to a player, if it still exists. */
export function penOf(match: Match, playerId: string) {
  const player = playerById(match, playerId);
  return player ? findPen(match.world, player.penId) : undefined;
}

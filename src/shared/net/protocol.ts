/**
 * What travels between a browser and a table.
 *
 * The design is deliberately lopsided:
 *
 *   - Clients only ever send **intent** — "I flicked my pen like this". Four
 *     numbers. They never send pen positions, so a modified client cannot
 *     teleport its pen or claim a kill.
 *   - The server replays that strike into its own copy of the match and then
 *     echoes it to everyone, including the player who sent it. Every browser
 *     runs the identical solver, so all of them show the same shot at the same
 *     time without anyone streaming positions at 60 frames a second.
 *   - When the table settles, the server sends a full snapshot. Any drift —
 *     two browsers rounding a sine differently, say — is wiped out once per
 *     turn, so it can never accumulate.
 *
 * That gives smooth local animation and a single source of truth.
 */

import type { Pen, PenState } from '../physics/pen';
import { createPen } from '../physics/pen';
import type { Table } from '../physics/table';
import { DEFAULT_TUNING, type Tuning } from '../physics/tuning';
import { createWorld, type World } from '../physics/world';
import type { Match, MatchPhase, Player } from '../game/match';
import type { Strike } from '../game/strike';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface PenSnapshot {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  omega: number;
  state: PenState;
  fallProgress: number;
}

export interface MatchSnapshot {
  code: string;
  phase: MatchPhase;
  players: Player[];
  pens: PenSnapshot[];
  table: Table;
  turnIndex: number;
  turnNumber: number;
  winnerId: string | null;
  /** Wall-clock ms after which the current player forfeits their turn. */
  turnEndsAt: number | null;
}

export function snapshotPen(pen: Pen): PenSnapshot {
  return {
    id: pen.id,
    ownerId: pen.ownerId,
    x: pen.x,
    y: pen.y,
    angle: pen.angle,
    vx: pen.vx,
    vy: pen.vy,
    omega: pen.omega,
    state: pen.state,
    fallProgress: pen.fallProgress,
  };
}

export function snapshotMatch(match: Match, turnEndsAt: number | null = null): MatchSnapshot {
  return {
    code: match.code,
    phase: match.phase,
    players: match.players.map((player) => ({ ...player })),
    pens: match.world.pens.map(snapshotPen),
    table: { ...match.world.table },
    turnIndex: match.turnIndex,
    turnNumber: match.turnNumber,
    winnerId: match.winnerId,
    turnEndsAt,
  };
}

/**
 * Rebuild a playable match from a snapshot.
 *
 * Mass and inertia are recomputed from tuning rather than sent, so they can
 * never disagree between two builds of the game.
 */
export function restoreMatch(snapshot: MatchSnapshot, tuning: Tuning = DEFAULT_TUNING): Match {
  const world: World = createWorld([], snapshot.table, tuning);
  world.pens = snapshot.pens.map((penSnapshot) => {
    const pen = createPen(
      {
        id: penSnapshot.id,
        ownerId: penSnapshot.ownerId,
        x: penSnapshot.x,
        y: penSnapshot.y,
        angle: penSnapshot.angle,
      },
      tuning,
    );
    pen.vx = penSnapshot.vx;
    pen.vy = penSnapshot.vy;
    pen.omega = penSnapshot.omega;
    pen.state = penSnapshot.state;
    pen.fallProgress = penSnapshot.fallProgress;
    return pen;
  });

  return {
    code: snapshot.code,
    phase: snapshot.phase,
    players: snapshot.players.map((player) => ({ ...player })),
    world,
    turnIndex: snapshot.turnIndex,
    turnNumber: snapshot.turnNumber,
    winnerId: snapshot.winnerId,
  };
}

/** Overwrite a live match with authoritative state, keeping object identity. */
export function applySnapshot(match: Match, snapshot: MatchSnapshot): void {
  const restored = restoreMatch(snapshot, match.world.tuning);
  match.phase = restored.phase;
  match.players = restored.players;
  match.world.pens = restored.world.pens;
  match.world.table = restored.world.table;
  match.world.elapsed = 0;
  match.world.restSteps = 0;
  match.turnIndex = restored.turnIndex;
  match.turnNumber = restored.turnNumber;
  match.winnerId = restored.winnerId;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Browser -> table. */
export type ClientMessage =
  | { type: 'join'; name: string; version: number }
  /** Only the host may start; everyone else's is ignored. */
  | { type: 'start' }
  | { type: 'strike'; strike: Strike }
  | { type: 'rematch' }
  | { type: 'ping' };

/** Table -> browser. */
export type ServerMessage =
  /** Sent once on connect: who you are, and the state of the table. */
  | { type: 'welcome'; playerId: string; hostId: string; snapshot: MatchSnapshot; version: number }
  /** Full authoritative state. Snap to this. */
  | { type: 'snapshot'; snapshot: MatchSnapshot; hostId: string }
  /** Somebody flicked. Replay it locally and animate. */
  | { type: 'strike'; playerId: string; strike: Strike; turnNumber: number }
  /** A turn was passed over without a shot. */
  | { type: 'skipped'; playerId: string; reason: 'timeout' | 'disconnected' }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function decodeClientMessage(raw: string): ClientMessage | null {
  return parse<ClientMessage>(raw);
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  return parse<ServerMessage>(raw);
}

function parse<T>(raw: string): T | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && typeof value.type === 'string'
      ? (value as T)
      : null;
  } catch {
    return null;
  }
}

/**
 * A session is "a match you are playing", however it happens to be driven.
 *
 * Solo runs the whole match inside this tab. Online runs a shadow copy here
 * and lets the server have the final word. The rest of the client — the
 * renderer, the aim controller, the HUD — talks to this interface and cannot
 * tell the difference, which is why adding another mode later (a replay
 * viewer, a spectator link) does not touch any of them.
 */

import type { Pen } from '../../shared/physics/pen';
import type { Match } from '../../shared/game/match';
import { currentPlayer, playerById } from '../../shared/game/match';
import type { Strike } from '../../shared/game/strike';
import type { CollisionEvent } from '../../shared/physics/collision';
import type { WaitingPlayer, WinTally } from '../../shared/net/protocol';

export interface FrameEvents {
  collisions: CollisionEvent[];
  startedFalling: string[];
  eliminated: string[];
  turnEnded: boolean;
}

/** Somebody at the table reacted. `reaction` indexes `REACTIONS` in `ui/glyphs.ts`. */
export type ReactionListener = (playerId: string, reaction: number) => void;

export const NO_EVENTS: FrameEvents = {
  collisions: [],
  startedFalling: [],
  eliminated: [],
  turnEnded: false,
};

export interface Session {
  readonly match: Match;
  /** The local player's id. Null while spectating. */
  readonly youAre: string | null;
  /** Who may start the match and call a rematch. */
  readonly hostId: string | null;
  /** A short human-readable note for the HUD, e.g. a connection problem. */
  readonly notice: string | null;
  /** Games won at this table so far, by player id. Survives rematches. */
  readonly wins: Readonly<WinTally>;
  /** Online: people dealt into the next match, not this one. */
  readonly waiting?: readonly WaitingPlayer[];
  /** Online: the last turn passed over without a shot, and when (`performance.now()` ms). */
  readonly lastSkip?: { playerId: string; reason: 'timeout' | 'disconnected'; at: number } | null;

  /** Advance one fixed physics frame. */
  tick(): FrameEvents;
  /** Offer the local player's shot. Ignored when it is not their turn. */
  submitStrike(strike: Strike): void;
  requestRematch(): void;
  /** Offer one of the fixed reactions. Ignored for spectators. */
  react(reaction: number): void;
  /** Somebody reacted — the local player included, once the table has passed it on. */
  onReaction(listener: ReactionListener): () => void;
  /** Called whenever anything the UI cares about changed. */
  onChange(listener: () => void): () => void;
  destroy(): void;
}

/**
 * The pen the local player is allowed to flick right now, if any.
 * Shared by every session type — the rule does not vary.
 */
export function strikeablePen(session: Session): Pen | null {
  const { match, youAre } = session;
  if (!youAre || match.phase !== 'aiming') return null;

  const onTurn = currentPlayer(match);
  if (!onTurn || onTurn.id !== youAre) return null;

  const player = playerById(match, youAre);
  if (!player || player.eliminated) return null;

  const pen = match.world.pens.find((candidate) => candidate.id === player.penId);
  return pen && pen.state === 'onTable' ? pen : null;
}

/** Tiny listener bookkeeping, shared by the session implementations. */
export class ChangeEmitter<Args extends unknown[] = []> {
  private listeners = new Set<(...args: Args) => void>();

  subscribe(listener: (...args: Args) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...args: Args): void {
    for (const listener of this.listeners) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }
}

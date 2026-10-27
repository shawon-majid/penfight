/**
 * Online play against a table hosted on the server.
 *
 * The browser keeps a full copy of the match and animates shots itself, so
 * play feels instant. The server keeps the copy that counts. Two rules keep
 * the two honest:
 *
 *   1. Your own shot is played locally the moment you release, and the
 *      server's echo of it is ignored — otherwise the shot would replay.
 *   2. Every snapshot from the server overwrites local state outright. Any
 *      drift is gone once per turn and can never build up.
 */

import type { Match } from '../../shared/game/match';
import { createMatch, skipTurn, submitStrike } from '../../shared/game/match';
import type { Strike } from '../../shared/game/strike';
import { stepMatch } from '../../shared/game/match';
import type { ServerMessage, WaitingPlayer, WinTally } from '../../shared/net/protocol';
import { applySnapshot } from '../../shared/net/protocol';
import { PROTOCOL_VERSION } from '../../shared/net/protocol';
import { RoomClient, localPlayerId, type ConnectionStatus } from '../net/room-client';
import { isReaction } from '../../shared/game/reactions';
import {
  ChangeEmitter,
  NO_EVENTS,
  type FrameEvents,
  type ReactionListener,
  type Session,
} from './session';

export interface OnlineOptions {
  code: string;
  name: string;
  colourIndex: number | null;
  avatar: number;
  /** Null for a guest. */
  accessToken: () => Promise<string | null>;
  /** Whether the player thinks they are signed in, to warn if the server disagrees. */
  signedIn: boolean;
}

export class OnlineSession implements Session {
  match: Match;
  youAre: string;
  hostId: string | null = null;
  notice: string | null = 'Connecting…';
  wins: WinTally = {};
  /** Wall-clock ms by which the current player must shoot, if the server set one. */
  turnEndsAt: number | null = null;
  /**
   * The same deadline on this page's own clock (`performance.now()` ms), so a
   * device whose clock is a few seconds out still counts down correctly.
   */
  turnDeadline: number | null = null;
  /** People who joined mid-match and will be dealt into the next one. */
  waiting: WaitingPlayer[] = [];
  /** The last turn that was passed over, and when, so the display can say so. */
  lastSkip: { playerId: string; reason: 'timeout' | 'disconnected'; at: number } | null = null;

  private readonly emitter = new ChangeEmitter();
  private readonly reactions = new ChangeEmitter<[string, number]>();
  private readonly client: RoomClient;
  private readonly expectSignedIn: boolean;
  /**
   * Turn numbers whose strike we already played locally. Used to drop the
   * server's echo of our own shot.
   */
  private readonly selfPlayedTurns = new Set<number>();

  constructor(options: OnlineOptions) {
    this.youAre = localPlayerId();
    this.expectSignedIn = options.signedIn;
    // A placeholder so the renderer has something to draw before the first
    // snapshot lands. It is replaced wholesale by `welcome`.
    this.match = createMatch(options.code, []);

    this.client = new RoomClient({
      code: options.code,
      playerId: this.youAre,
      name: options.name,
      colourIndex: options.colourIndex,
      avatar: options.avatar,
      accessToken: options.accessToken,
      onMessage: (message) => this.handle(message),
      onStatus: (status) => this.handleStatus(status),
    });
  }

  tick(): FrameEvents {
    if (this.match.phase !== 'resolving') return NO_EVENTS;
    const result = stepMatch(this.match);
    if (result.turnEnded || result.eliminated.length > 0) this.emitter.emit();
    return result;
  }

  /**
   * Play the shot immediately and tell the server about it.
   *
   * If the server disagrees — a stale turn, a doctored strike — its next
   * snapshot puts things right, so the worst case is a brief wrong animation
   * rather than a desynced game.
   */
  submitStrike(strike: Strike): void {
    const result = submitStrike(this.match, this.youAre, strike);
    if (!result.ok) return;
    this.selfPlayedTurns.add(this.match.turnNumber);
    this.client.send({ type: 'strike', strike });
    this.emitter.emit();
  }

  start(): void {
    this.client.send({ type: 'start' });
  }

  requestRematch(): void {
    this.client.send({ type: 'rematch' });
  }

  /** Shown when the table echoes it back, so everyone sees it at the same moment. */
  react(reaction: number): void {
    if (!isReaction(reaction)) return;
    this.client.send({ type: 'react', reaction });
  }

  onReaction(listener: ReactionListener): () => void {
    return this.reactions.subscribe(listener);
  }

  onChange(listener: () => void): () => void {
    return this.emitter.subscribe(listener);
  }

  destroy(): void {
    this.client.close();
    this.emitter.clear();
    this.reactions.clear();
  }

  get isHost(): boolean {
    return this.hostId !== null && this.hostId === this.youAre;
  }

  private handleStatus(status: ConnectionStatus): void {
    this.notice =
      status === 'open'
        ? null
        : status === 'connecting'
          ? 'Connecting…'
          : status === 'reconnecting'
            ? 'Lost the connection — trying again…'
            : 'Disconnected.';
    this.emitter.emit();
  }

  /** True while you are queued for the next match rather than playing this one. */
  get isWaiting(): boolean {
    return this.waiting.some((player) => player.id === this.youAre);
  }

  private readClock(turnEndsAt: number | null, serverNow: number | undefined): void {
    this.turnEndsAt = turnEndsAt;
    this.turnDeadline =
      turnEndsAt === null ? null : performance.now() + (turnEndsAt - (serverNow ?? Date.now()));
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        if (message.version !== PROTOCOL_VERSION) {
          this.notice = 'This page is out of date — reload to keep playing.';
          this.emitter.emit();
          return;
        }
        this.youAre = message.playerId;
        this.hostId = message.hostId;
        this.wins = message.wins ?? {};
        applySnapshot(this.match, message.snapshot);
        this.readClock(message.snapshot.turnEndsAt, message.serverNow);
        this.waiting = message.waiting ?? [];
        this.notice =
          this.expectSignedIn && !message.signedIn
            ? 'Could not confirm your sign-in, so games here will not count on your profile.'
            : null;
        break;
      }

      case 'snapshot': {
        this.hostId = message.hostId;
        this.wins = message.wins ?? {};
        applySnapshot(this.match, message.snapshot);
        this.readClock(message.snapshot.turnEndsAt, message.serverNow);
        this.waiting = message.waiting ?? [];
        // Everything before this point is settled; forget the echo bookkeeping.
        this.selfPlayedTurns.clear();
        break;
      }

      case 'strike': {
        // Our own shot has already been played locally.
        if (message.playerId === this.youAre && this.selfPlayedTurns.has(message.turnNumber)) {
          this.selfPlayedTurns.delete(message.turnNumber);
          return;
        }
        submitStrike(this.match, message.playerId, message.strike);
        break;
      }

      case 'skipped': {
        skipTurn(this.match);
        this.lastSkip = { playerId: message.playerId, reason: message.reason, at: performance.now() };
        // The next player's clock arrives with the snapshot that follows.
        this.turnDeadline = null;
        break;
      }

      case 'reaction': {
        // Nothing about the match changed, so no change event either.
        if (isReaction(message.reaction)) this.reactions.emit(message.playerId, message.reaction);
        return;
      }

      case 'error': {
        this.notice = message.message;
        break;
      }

      case 'pong':
        return;
    }

    this.emitter.emit();
  }
}

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
import type { ServerMessage, WinTally } from '../../shared/net/protocol';
import { applySnapshot } from '../../shared/net/protocol';
import { PROTOCOL_VERSION } from '../../shared/net/protocol';
import { RoomClient, localPlayerId, type ConnectionStatus } from '../net/room-client';
import { ChangeEmitter, NO_EVENTS, type FrameEvents, type Session } from './session';

export interface OnlineOptions {
  code: string;
  name: string;
}

export class OnlineSession implements Session {
  match: Match;
  youAre: string;
  hostId: string | null = null;
  notice: string | null = 'Connecting…';
  wins: WinTally = {};
  /** Wall-clock ms by which the current player must shoot, if the server set one. */
  turnEndsAt: number | null = null;

  private readonly emitter = new ChangeEmitter();
  private readonly client: RoomClient;
  /**
   * Turn numbers whose strike we already played locally. Used to drop the
   * server's echo of our own shot.
   */
  private readonly selfPlayedTurns = new Set<number>();

  constructor(options: OnlineOptions) {
    this.youAre = localPlayerId();
    // A placeholder so the renderer has something to draw before the first
    // snapshot lands. It is replaced wholesale by `welcome`.
    this.match = createMatch(options.code, []);

    this.client = new RoomClient({
      code: options.code,
      playerId: this.youAre,
      name: options.name,
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

  onChange(listener: () => void): () => void {
    return this.emitter.subscribe(listener);
  }

  destroy(): void {
    this.client.close();
    this.emitter.clear();
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
        this.turnEndsAt = message.snapshot.turnEndsAt;
        this.notice = null;
        break;
      }

      case 'snapshot': {
        this.hostId = message.hostId;
        this.wins = message.wins ?? {};
        applySnapshot(this.match, message.snapshot);
        this.turnEndsAt = message.snapshot.turnEndsAt;
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
        break;
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

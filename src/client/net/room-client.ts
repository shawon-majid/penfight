/**
 * The socket to a table.
 *
 * Its only jobs are staying connected and handing decoded messages upwards.
 * It knows nothing about pens — swap the transport and the game is unaffected.
 *
 * Reconnection matters more here than in most games: a dropped player keeps
 * their pen on the table and their seat waiting, so coming back should put
 * them straight back into the match rather than into a new one. That is why
 * the player id is generated once, kept in local storage, and sent on every
 * connect.
 */

import type { ClientMessage, ServerMessage } from '../../shared/net/protocol';
import {
  SIGNED_IN_SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  decodeServerMessage,
  encode,
} from '../../shared/net/protocol';
import { socket } from './server';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomClientOptions {
  /** Table code, already normalised. */
  code: string;
  playerId: string;
  name: string;
  /** Preferred pen colour, or null to take whatever is free. */
  colourIndex: number | null;
  /**
   * The signed-in player's access token, or null for a guest. Asked for on
   * every connect, so a reconnect an hour later still gets a fresh one.
   */
  accessToken: () => Promise<string | null>;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
/** Keeps intermediaries from closing an idle socket between slow turns. */
const HEARTBEAT_MS = 25000;

export class RoomClient {
  private readonly options: RoomClientOptions;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  constructor(options: RoomClientOptions) {
    this.options = options;
    void this.connect();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode(message));
    }
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.options.onStatus('closed');
  }

  private url(): string {
    const params = new URLSearchParams({
      player: this.options.playerId,
      name: this.options.name,
    });
    if (this.options.colourIndex !== null) params.set('colour', String(this.options.colourIndex));
    return socket(`/api/table/${this.options.code}/ws?${params}`);
  }

  private async connect(): Promise<void> {
    this.options.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let token: string | null = null;
    try {
      token = await this.options.accessToken();
    } catch {
      // Could not refresh the sign-in. Join as a guest rather than not at all.
    }
    if (this.closedByUs) return;

    // See SIGNED_IN_SUBPROTOCOL: the token rides here, not in the URL.
    const protocols = token ? [SIGNED_IN_SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + token] : [];
    const socket = new WebSocket(this.url(), protocols);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.options.onStatus('open');
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      const message = decodeServerMessage(String(event.data));
      if (message) this.options.onMessage(message);
    });

    socket.addEventListener('close', () => {
      this.stopHeartbeat();
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });

    // An error is always followed by a close, so let that path do the work.
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.options.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
  }
}

const PLAYER_ID_KEY = 'penfight.playerId';

/**
 * A stable id for this browser, so refreshing or dropping out returns you to
 * your own seat instead of handing you a new one.
 */
export function localPlayerId(): string {
  const existing = localStorage.getItem(PLAYER_ID_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, created);
  return created;
}
